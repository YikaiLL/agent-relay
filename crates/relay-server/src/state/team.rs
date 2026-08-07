//! Task team runner model.
//!
//! A `TeamRun` is one execution of the fixed three-role team — TL, dev, reviewer
//! — against a user-written `TaskSpec`, inside a dedicated git worktree. It holds
//! only orchestration metadata: every agent's real output lives in the background
//! thread it names, and the TL's plan/design/report live as files in the worktree.
//!
//! Two things here differ from `WorkflowRun` on purpose, and both are load-bearing:
//!
//! 1. **`TeamRunStatus` is its own enum, not `RunStatus`.** It has to carry
//!    `Paused`/`PausePending`/`AwaitingUser`, and adding a variant to the shared
//!    `RunStatus` would be a persistence trap: an unknown status string is a hard
//!    serde error, `PersistenceStore::load` turns that into `Err`, and `AppState::new`
//!    responds by discarding the ENTIRE `session.json` — paired devices, projects,
//!    allowed roots and all. So this enum decodes leniently (unknown -> `Failed`),
//!    which is the property `RunStatus` is missing.
//!
//! 2. **`Paused` is durable and survives restore.** Every other non-terminal run in
//!    this codebase reconciles to `Interrupted` when its driver is lost, because a
//!    run persisted `Running` with no driver would strand its locks. A paused run is
//!    the deliberate case of exactly that, so the exemption lives inside
//!    `mark_interrupted_if_stranded` rather than in its callers — neither the restore
//!    path nor the lifeguard can then forget it.
//!
//! Resumability contract: `(phase, each sub-task's status + digested flag, the round
//! counters, the verdicts)` is sufficient to decide the next action, and
//! `next_team_action` is a pure function of the record that proves it. The driver
//! advances `phase` in the SAME write that records a step's result, so a crash
//! re-runs at most the last turn. See `markdown/task-team-design.md` §5.

// The driver (brick 4) and the HTTP surface (brick 11) consume these; keep the
// model ahead of its wiring without dead-code warnings, mirroring
// `state/workflow.rs` and `state/task_list.rs`.
#![allow(dead_code)]

use serde::{Deserialize, Deserializer, Serialize};

use super::unix_now;
use super::workflow::WorkflowVerdict;

/// Hard ceiling on review rounds per sub-task. The product rule is "at most two
/// rounds, one is fine"; this clamps whatever a caller asks for.
pub(crate) const MAX_SUBTASK_REVIEW_ROUNDS: u32 = 2;
/// Same ceiling for the final MR gate.
pub(crate) const MAX_MR_ROUNDS: u32 = 2;
/// How many times the TL may be re-seeded before the run gives up. A re-seed loop
/// would otherwise burn tokens forever on a task the TL cannot hold.
pub(crate) const MAX_TL_GENERATIONS: usize = 8;

/// Lifecycle of a team run.
///
/// Terminal: `Done`, `Escalated`, `Failed`, `Interrupted`, `Cancelled`.
/// Non-terminal with a live driver: `Queued`, `Running`, `PausePending`,
/// `AwaitingUser`, `Resolving`.
/// Non-terminal WITHOUT a driver: `Paused` (durable, re-spawnable) and `Blocked`
/// (a stop could not be confirmed; keeps owning its threads until recovery).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TeamRunStatus {
    /// Recorded, driver not yet started.
    Queued,
    /// The driver is working through actions.
    Running,
    /// A pause was requested. The driver is alive and finishing the in-flight
    /// turn; it settles to `Paused` at the next step boundary.
    PausePending,
    /// Settled at a boundary with no driver alive. Survives restart verbatim and
    /// can be resumed from the record. THIS is the state the interrupt
    /// reconciliation must not touch.
    Paused,
    /// A dev or TL thread is parked on an `AskUserQuestion`. The turn is NOT
    /// stopped — it is blocked inside the provider's tool callback and continues
    /// the moment the answer lands.
    AwaitingUser,
    /// The MR gate approved and every sub-task landed. TERMINAL.
    Done,
    /// A round budget ran out somewhere; unresolved items are written out.
    /// TERMINAL.
    Escalated,
    /// A stop path could not confirm a file-mutating turn actually stopped.
    /// Non-terminal on purpose: the run keeps owning its threads and worktree
    /// until an explicit recovery.
    Blocked,
    /// An explicit recovery action is draining owned turns. Non-terminal so
    /// duplicate recoveries cannot drain the same threads twice.
    Resolving,
    /// The safe fallback: also what an unknown or missing persisted status
    /// decodes to, so a forward-compat state file can never strand a lock.
    /// TERMINAL.
    #[default]
    Failed,
    /// The driver was lost while non-terminal and the run was not paused.
    /// TERMINAL — the card offers a re-run.
    Interrupted,
    /// The user stopped the run. TERMINAL.
    Cancelled,
}

impl TeamRunStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::PausePending => "pause_pending",
            Self::Paused => "paused",
            Self::AwaitingUser => "awaiting_user",
            Self::Done => "done",
            Self::Escalated => "escalated",
            Self::Blocked => "blocked",
            Self::Resolving => "resolving",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
            Self::Cancelled => "cancelled",
        }
    }

    /// Decode a persisted status, treating anything unrecognized as the safe
    /// terminal `Failed`. Unlike `RunStatus`, an unknown value here must never
    /// become a serde error — see the module docs for what that would cost.
    pub(crate) fn from_wire(raw: &str) -> Self {
        match raw {
            "queued" => Self::Queued,
            "running" => Self::Running,
            "pause_pending" => Self::PausePending,
            "paused" => Self::Paused,
            "awaiting_user" => Self::AwaitingUser,
            "done" => Self::Done,
            "escalated" => Self::Escalated,
            "blocked" => Self::Blocked,
            "resolving" => Self::Resolving,
            "interrupted" => Self::Interrupted,
            "cancelled" => Self::Cancelled,
            _ => Self::Failed,
        }
    }

    pub(crate) fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Done | Self::Escalated | Self::Failed | Self::Interrupted | Self::Cancelled
        )
    }

    /// Whether a driver can be spawned for this run as-is.
    pub(crate) fn is_resumable(self) -> bool {
        matches!(self, Self::Paused)
    }

    /// Whether the run holds its threads and worktree with no driver entitled to
    /// move it. `Paused` waits for the user, `Blocked` for an explicit recovery,
    /// `Resolving` for the recovery already in progress.
    ///
    /// These states are writable only by a deliberate user action, never by a
    /// driver. That asymmetry is the point: a force stop settles `Paused` while
    /// the driver is still inside a turn, and moments later that driver observes
    /// its own turn vanish and tries to record a failure. Letting it through would
    /// turn every successful force stop into `Failed`.
    pub(crate) fn is_settled_without_driver(self) -> bool {
        matches!(self, Self::Paused | Self::Blocked | Self::Resolving)
    }
}

impl<'de> Deserialize<'de> for TeamRunStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        // `Option<String>` rather than `String` so an explicit `null` degrades to
        // the safe default instead of failing the whole state file.
        let raw = Option::<String>::deserialize(deserializer)?;
        Ok(raw.as_deref().map(Self::from_wire).unwrap_or_default())
    }
}

/// The user's Task, verbatim.
///
/// IMMUTABLE by construction: only `TeamRun::new` sets it and there is no `&mut`
/// accessor. The TL owns the plan file and may rewrite it freely, but it must not
/// be able to edit the thing it is being measured against — `agreed_scope` and
/// `quality_rules` are the MR gate's yardstick.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct TaskSpec {
    pub(crate) title: String,
    pub(crate) context: String,
    pub(crate) acceptance_criteria: String,
    pub(crate) agreed_scope: String,
    pub(crate) quality_rules: String,
}

/// Where the run is in the fixed pipeline.
///
/// Decodes leniently for the same reason `TeamRunStatus` does — a strict derive
/// here would make one unknown value from a newer build fail the whole
/// `PersistedRelayState` decode, which `AppState::new` answers by discarding the
/// entire session file. Unknown maps to `Finished`, the one variant that yields
/// no action at all: a record we cannot interpret must not be acted on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TeamPhase {
    /// TL reads the spec, writes the plan file, and judges complexity.
    #[default]
    Intake,
    /// TL writes a design (complex tasks only).
    Design,
    /// The reviewer reviews the design.
    DesignReview,
    /// TL splits the work into sub-tasks.
    Planning,
    /// The dev/review loop, one sub-task at a time.
    SubTasks,
    /// Whole-diff review against the agreed scope and quality rules.
    MrGate,
    /// Final commit + report.
    Wrapping,
    Finished,
}

impl TeamPhase {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Intake => "intake",
            Self::Design => "design",
            Self::DesignReview => "design_review",
            Self::Planning => "planning",
            Self::SubTasks => "sub_tasks",
            Self::MrGate => "mr_gate",
            Self::Wrapping => "wrapping",
            Self::Finished => "finished",
        }
    }

    fn from_wire(raw: &str) -> Self {
        match raw {
            "intake" => Self::Intake,
            "design" => Self::Design,
            "design_review" => Self::DesignReview,
            "planning" => Self::Planning,
            "sub_tasks" => Self::SubTasks,
            "mr_gate" => Self::MrGate,
            "wrapping" => Self::Wrapping,
            _ => Self::Finished,
        }
    }
}

impl<'de> Deserialize<'de> for TeamPhase {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Option::<String>::deserialize(deserializer)?;
        Ok(raw.as_deref().map(Self::from_wire).unwrap_or_default())
    }
}

/// Per-sub-task lifecycle. Terminal: `Done`, `Escalated`, `Failed`, `Skipped`.
///
/// Decodes leniently, same rationale as `TeamPhase`. Unknown maps to the terminal
/// `Failed`: a sub-task we cannot interpret is never re-run, and still gets
/// reported to the TL.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SubTaskStatus {
    /// Needs a dev turn (round 1, or a further round after findings).
    #[default]
    Pending,
    /// The dev turn landed; needs a review turn.
    Implementing,
    /// The reviewer approved. TERMINAL.
    Done,
    /// The round budget ran out without approval. TERMINAL.
    Escalated,
    /// The step errored. TERMINAL.
    Failed,
    /// Never run because the run settled first. TERMINAL.
    Skipped,
}

impl SubTaskStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Implementing => "implementing",
            Self::Done => "done",
            Self::Escalated => "escalated",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }

    fn from_wire(raw: &str) -> Self {
        match raw {
            "pending" => Self::Pending,
            "implementing" => Self::Implementing,
            "done" => Self::Done,
            "escalated" => Self::Escalated,
            "skipped" => Self::Skipped,
            _ => Self::Failed,
        }
    }

    pub(crate) fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Done | Self::Escalated | Self::Failed | Self::Skipped
        )
    }
}

impl<'de> Deserialize<'de> for SubTaskStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Option::<String>::deserialize(deserializer)?;
        // A missing value means "not started", which is what `Pending` is; only an
        // UNKNOWN value is the untrustworthy case that must settle terminal.
        Ok(raw.as_deref().map_or(Self::Pending, Self::from_wire))
    }
}

/// One TL-authored unit of work.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct SubTask {
    pub(crate) id: String,
    pub(crate) title: String,
    /// TL-authored and SELF-CONTAINED: the dev gets a fresh session per sub-task,
    /// so anything not in here (or in the plan file) does not exist to it.
    pub(crate) brief: String,
    pub(crate) status: SubTaskStatus,
    pub(crate) rounds_used: u32,
    /// Checkpoint commit taken when this sub-task started; scopes its review diff
    /// to its OWN changes rather than everything since the run began.
    pub(crate) base_commit: String,
    pub(crate) dev_thread_id: Option<String>,
    pub(crate) reviewer_thread_id: Option<String>,
    /// Every thread this sub-task has ever owned — the set the lifeguard drains
    /// and the lock predicate consults. Never pruned while the run is live.
    pub(crate) owned_thread_ids: Vec<String>,
    pub(crate) last_verdict: Option<WorkflowVerdict>,
    /// The ONLY thing that reaches the TL. Never a transcript.
    pub(crate) result_summary: Option<String>,
    /// Whether the TL has been told this sub-task's outcome. Separate from
    /// `status` because settling and reporting are two different steps, and a
    /// crash between them must not lose the report.
    pub(crate) digested: bool,
    pub(crate) error: Option<String>,
}

/// One TL session in the succession chain.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct TlGeneration {
    pub(crate) thread_id: String,
    pub(crate) reason: String,
    pub(crate) retired_at: u64,
}

/// A parked question waiting on the user.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct AwaitingUser {
    pub(crate) thread_id: String,
    pub(crate) request_id: String,
    /// `tl` or `dev` — the reviewer never asks.
    pub(crate) role: String,
    pub(crate) asked_at: u64,
}

/// WHERE in the record a thread id lives.
///
/// The driver addresses seats by slot rather than by value so it can re-resolve
/// after a mid-turn promotion. Holding the id itself is exactly the bug: the
/// value it captured before sending can be dead by the time the turn ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TeamThreadSlot {
    Tl,
    SubTaskDev(usize),
    SubTaskReviewer(usize),
    /// Index into `run_owned_thread_ids` — the design reviewer, an MR reviewer,
    /// or the MR-revision dev.
    RunOwned(usize),
}

/// The next thing the driver should do. Derived, never stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TeamAction {
    TlIntake,
    TlDesign,
    ReviewDesign,
    TlPlan,
    DevImplement { index: usize },
    ReviewSubTask { index: usize },
    TlDigestSubTask { index: usize },
    MrReview,
    TlAddressMr,
    Wrap,
}

/// One execution of the team pipeline.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct TeamRun {
    pub(crate) id: String,
    pub(crate) status: TeamRunStatus,
    pub(crate) phase: TeamPhase,
    pub(crate) spec: TaskSpec,
    pub(crate) sub_tasks: Vec<SubTask>,

    /// Whether the TL judged the task complex enough to need a design phase.
    /// `None` until intake answers it.
    pub(crate) complex: Option<bool>,

    pub(crate) slug: String,
    pub(crate) branch: String,
    /// FULLY QUALIFIED (`refs/heads/main`). It is evaluated by `merge_base_with`
    /// inside the task worktree, where a relative expression like `HEAD` would
    /// resolve to the task's own tip and hide every commit from the MR diff.
    pub(crate) target_ref: String,
    pub(crate) base_commit: String,
    pub(crate) repo_main_worktree: String,
    /// The worktree. Every team thread starts here, with this exact string.
    pub(crate) cwd: String,
    pub(crate) source_dirty: bool,

    pub(crate) plan_rel_path: String,
    pub(crate) design_rel_path: String,
    pub(crate) report_rel_path: String,

    pub(crate) tl_thread_id: String,
    pub(crate) tl_provider: String,
    pub(crate) tl_model: String,
    pub(crate) tl_succession: Vec<TlGeneration>,
    pub(crate) tl_turns_this_generation: u32,

    /// Threads owned by the RUN rather than by a sub-task: the design reviewer,
    /// each MR-gate reviewer, and the dev thread that addresses MR findings.
    ///
    /// Without this they would have nowhere to live, and `owned_thread_ids` — the
    /// set the lifeguards drain and the lock predicate consults — would silently
    /// omit them. A cancel during the MR gate would then leave an orphaned turn,
    /// and for the MR-revision dev that turn keeps WRITING the worktree after the
    /// run's locks are released. Persisted, appended, never pruned while live.
    pub(crate) run_owned_thread_ids: Vec<String>,

    pub(crate) dev_provider: String,
    pub(crate) dev_model: String,
    pub(crate) reviewer_provider: String,
    pub(crate) reviewer_model: String,

    pub(crate) max_review_rounds: u32,
    pub(crate) max_mr_rounds: u32,
    pub(crate) design_review_rounds: u32,
    pub(crate) mr_rounds_used: u32,

    /// The thread a turn is being started on RIGHT NOW, set before the provider
    /// call and cleared once the turn resolves.
    ///
    /// Exists because a provider marks a thread working only AFTER `start_turn`
    /// returns: in between, the provider may already be running while relay state
    /// still reads idle. A driver lost in that window would look drained, the run
    /// would go terminal, its locks would release, and the real session would keep
    /// writing the worktree. This marker makes that window visible to cleanup.
    pub(crate) in_flight_thread: Option<String>,

    pub(crate) pause_requested: bool,
    pub(crate) pause_requested_by: String,
    pub(crate) pause_reason: Option<String>,
    pub(crate) awaiting: Option<AwaitingUser>,

    pub(crate) design_verdict: Option<WorkflowVerdict>,
    pub(crate) mr_verdict: Option<WorkflowVerdict>,
    pub(crate) unresolved: Vec<String>,
    pub(crate) head_commit: Option<String>,

    pub(crate) requested_by_device_id: String,
    pub(crate) requested_at: u64,
    pub(crate) updated_at: u64,
    pub(crate) error: Option<String>,
}

impl TeamRun {
    pub(crate) fn new(
        id: String,
        spec: TaskSpec,
        cwd: String,
        requested_by_device_id: String,
    ) -> Self {
        let now = unix_now();
        Self {
            id,
            status: TeamRunStatus::Queued,
            phase: TeamPhase::Intake,
            spec,
            cwd,
            max_review_rounds: MAX_SUBTASK_REVIEW_ROUNDS,
            max_mr_rounds: MAX_MR_ROUNDS,
            requested_by_device_id,
            requested_at: now,
            updated_at: now,
            ..Self::default()
        }
    }

    /// Advance the status. Terminal is final, and a state the user settled is
    /// off-limits, so a decision that won a race can never be clobbered by the
    /// driver's next between-step write. Same guard `WorkflowRun` uses, widened by
    /// `Paused` because this run type is the one that can be settled underneath a
    /// live driver.
    pub(crate) fn set_status(&mut self, status: TeamRunStatus) {
        if self.status.is_terminal() || self.status.is_settled_without_driver() {
            return;
        }
        self.status = status;
        self.updated_at = unix_now();
    }

    pub(crate) fn fail(&mut self, error: impl Into<String>) {
        if self.status.is_terminal() || self.status.is_settled_without_driver() {
            return;
        }
        self.error = Some(error.into());
        self.set_status(TeamRunStatus::Failed);
    }

    pub(crate) fn block(&mut self, error: impl Into<String>) {
        if self.status.is_terminal() {
            return;
        }
        self.error = Some(error.into());
        self.status = TeamRunStatus::Blocked;
        self.updated_at = unix_now();
    }

    /// Record a pause request. Does not stop anything: the driver settles at the
    /// next boundary.
    pub(crate) fn request_pause(&mut self, device_id: impl Into<String>) {
        if self.status.is_terminal() || self.status.is_settled_without_driver() {
            return;
        }
        self.pause_requested = true;
        self.pause_requested_by = device_id.into();
        self.set_status(TeamRunStatus::PausePending);
    }

    /// Settle a requested pause. Returns whether it took.
    pub(crate) fn settle_paused(&mut self, reason: impl Into<String>) -> bool {
        if self.status.is_terminal() || self.status.is_settled_without_driver() {
            return false;
        }
        self.pause_requested = false;
        self.pause_reason = Some(reason.into());
        // Nothing is in flight once a pause settles: the caller proved every owned
        // turn is quiescent before getting here. Leaving a stale marker would make
        // the next cleanup pass read an unobservable turn and block the run.
        self.in_flight_thread = None;
        self.status = TeamRunStatus::Paused;
        self.updated_at = unix_now();
        true
    }

    /// Leave `Paused` for a fresh drive. Returns whether it took.
    ///
    /// The ONLY way out of a settled state back into work, and deliberately
    /// narrow: `is_resumable` is `Paused` alone, so this can never restart a run
    /// that was cancelled, blocked, or is already being driven. Resume needs no
    /// cursor of its own — `next_team_action` reads the record, so a resumed
    /// driver and a cold one take exactly the same path.
    ///
    /// `error` is cleared because the only errors that reach a resumable run are
    /// the ones a recovery already dealt with; keeping one would leave a resumed
    /// task wearing a failure that is no longer true.
    pub(crate) fn resume(&mut self) -> bool {
        if !self.status.is_resumable() {
            return false;
        }
        self.pause_requested = false;
        self.pause_requested_by = String::new();
        self.pause_reason = None;
        self.error = None;
        self.status = TeamRunStatus::Running;
        self.updated_at = unix_now();
        true
    }

    /// Settle the run at the user's request. TERMINAL.
    ///
    /// Unlike `set_status` this may leave `Paused`/`Blocked`/`Resolving`: those
    /// states exist to stop a DRIVER from writing over a decision, not to stop the
    /// user from making one. Callers must confirm every owned turn stopped first —
    /// terminal releases the run's locks, and an agent still writing the worktree
    /// after that is exactly what `Blocked` exists to prevent.
    pub(crate) fn cancel(&mut self, reason: impl Into<String>) -> bool {
        if self.status.is_terminal() {
            return false;
        }
        self.error = Some(reason.into());
        self.pause_requested = false;
        self.awaiting = None;
        self.in_flight_thread = None;
        self.status = TeamRunStatus::Cancelled;
        self.updated_at = unix_now();
        true
    }

    /// `Blocked` -> `Resolving`. Only a blocked run may enter, so two concurrent
    /// recoveries cannot drain the same threads twice.
    pub(crate) fn begin_resolving_blocked(&mut self) -> bool {
        if !matches!(self.status, TeamRunStatus::Blocked) {
            return false;
        }
        self.status = TeamRunStatus::Resolving;
        self.updated_at = unix_now();
        true
    }

    /// `Resolving` -> `Paused`, once the recovery's drain confirmed.
    ///
    /// Deliberately NOT terminal, unlike `WorkflowRun::resolve_blocked_as_failed`.
    /// A drained team run is quiescent with its worktree and plan file intact,
    /// which is precisely what `Paused` describes — and `next_team_action` is a
    /// pure function of the record, so the work is genuinely resumable. Throwing
    /// that away would discard finished sub-tasks over a stop that took two tries.
    pub(crate) fn resolve_as_paused(&mut self, reason: impl Into<String>) -> bool {
        if !matches!(self.status, TeamRunStatus::Resolving) {
            return false;
        }
        self.pause_requested = false;
        self.pause_reason = Some(reason.into());
        self.in_flight_thread = None;
        self.status = TeamRunStatus::Paused;
        self.updated_at = unix_now();
        true
    }

    /// `Resolving` -> `Blocked`, for a recovery that never finished.
    pub(crate) fn restore_resolving_as_blocked(&mut self, error: impl Into<String>) -> bool {
        if !matches!(self.status, TeamRunStatus::Resolving) {
            return false;
        }
        self.block(error);
        true
    }

    /// Reconcile a run whose driver is gone. Returns whether it changed.
    ///
    /// A `Paused` run is exempt: it has no driver ON PURPOSE and must survive a
    /// restart verbatim so `resume_team_run` can pick it up. The exemption lives
    /// here rather than in the restore path and the lifeguard so neither can
    /// forget it.
    pub(crate) fn mark_interrupted_if_stranded(&mut self) -> bool {
        if self.status.is_terminal() || self.status.is_resumable() {
            return false;
        }
        self.error.get_or_insert_with(|| {
            "the task team's driver was lost; re-run to continue from the last completed step"
                .to_string()
        });
        self.status = TeamRunStatus::Interrupted;
        self.updated_at = unix_now();
        true
    }

    /// Snapshot this run as unresumable because its TL thread never materialized.
    ///
    /// Applied by the persistence writer, not to the live run: the in-memory run
    /// keeps going, and the next write (after the provider promotes the id)
    /// records the real state. What this protects is the RESTORE — a synthetic
    /// `claude-pending-*` id names nothing after a restart, so the run must come
    /// back terminal rather than as something the user can press Resume on. The
    /// spec, worktree path and branch are deliberately kept: a tree and a branch
    /// exist on disk, and a card that says so beats a card that vanished.
    pub(crate) fn detach_unresumable_tl(&mut self) {
        self.tl_thread_id = String::new();
        self.pause_requested = false;
        self.awaiting = None;
        if !self.status.is_terminal() {
            self.error.get_or_insert_with(|| {
                "the team lead's session had not started when the relay restarted; re-run this task"
                    .to_string()
            });
            self.status = TeamRunStatus::Interrupted;
            self.updated_at = unix_now();
        }
    }

    /// Roll the sub-task in flight back to the start of its current round.
    ///
    /// Used when a parked question can no longer be answered — pending questions
    /// live only in memory and the provider worker dies with the relay, so on
    /// restore there is nobody left to answer and nobody left to receive it.
    /// `rounds_used` is deliberately untouched: the round never completed, so
    /// charging it against the budget would silently shorten the team's runway.
    pub(crate) fn rollback_current_round(&mut self) {
        self.awaiting = None;
        let Some(index) = self.current_sub_task() else {
            return;
        };
        if let Some(task) = self.sub_tasks.get_mut(index) {
            if !task.status.is_terminal() {
                task.status = SubTaskStatus::Pending;
            }
        }
    }

    /// The sub-task the run is currently working, for display. Derived, so it can
    /// never drift from the sub-task statuses the way a stored cursor would.
    pub(crate) fn current_sub_task(&self) -> Option<usize> {
        self.sub_tasks
            .iter()
            .position(|task| !task.status.is_terminal() || !task.digested)
    }

    /// Rewrite every reference to `pending_id` as `real_id`.
    ///
    /// Claude mints a synthetic `claude-pending-*` id and only replaces it with a
    /// real session id once the first turn starts, at which point
    /// `promote_background_thread` re-keys the runtime map. EVERY seat here is
    /// background-started, so every one of them can be promoted mid-turn — and a
    /// driver still holding the pending id would find no runtime, read that as
    /// "not working", and treat a turn that is very much running as finished.
    pub(crate) fn rekey_thread(&mut self, pending_id: &str, real_id: &str) -> bool {
        if pending_id.is_empty() || pending_id == real_id {
            return false;
        }
        let mut changed = false;
        let mut swap = |slot: &mut String| {
            if slot == pending_id {
                *slot = real_id.to_string();
                changed = true;
            }
        };
        swap(&mut self.tl_thread_id);
        for generation in self.tl_succession.iter_mut() {
            swap(&mut generation.thread_id);
        }
        for thread_id in self.run_owned_thread_ids.iter_mut() {
            swap(thread_id);
        }
        for task in self.sub_tasks.iter_mut() {
            if let Some(dev) = task.dev_thread_id.as_mut() {
                swap(dev);
            }
            if let Some(reviewer) = task.reviewer_thread_id.as_mut() {
                swap(reviewer);
            }
            for thread_id in task.owned_thread_ids.iter_mut() {
                swap(thread_id);
            }
        }
        if let Some(in_flight) = self.in_flight_thread.as_mut() {
            if in_flight == pending_id {
                *in_flight = real_id.to_string();
                changed = true;
            }
        }
        if let Some(awaiting) = self.awaiting.as_mut() {
            if awaiting.thread_id == pending_id {
                awaiting.thread_id = real_id.to_string();
                changed = true;
            }
        }
        if changed {
            self.updated_at = unix_now();
        }
        changed
    }

    /// Read the CURRENT id in a seat, so a caller can re-resolve after a promotion
    /// instead of holding one it captured before the turn started.
    pub(crate) fn thread_in_slot(&self, slot: TeamThreadSlot) -> Option<String> {
        let id = match slot {
            TeamThreadSlot::Tl => self.tl_thread_id.clone(),
            TeamThreadSlot::SubTaskDev(index) => {
                self.sub_tasks.get(index)?.dev_thread_id.clone()?
            }
            TeamThreadSlot::SubTaskReviewer(index) => {
                self.sub_tasks.get(index)?.reviewer_thread_id.clone()?
            }
            TeamThreadSlot::RunOwned(index) => self.run_owned_thread_ids.get(index)?.clone(),
        };
        (!id.is_empty()).then_some(id)
    }

    /// Record a thread the RUN owns (design reviewer, MR reviewer, MR-revision
    /// dev). Idempotent, so a retry cannot double-register.
    pub(crate) fn record_run_thread(&mut self, thread_id: impl Into<String>) {
        let thread_id = thread_id.into();
        if thread_id.is_empty() || self.run_owned_thread_ids.contains(&thread_id) {
            return;
        }
        self.run_owned_thread_ids.push(thread_id);
        self.updated_at = unix_now();
    }

    /// Every thread this run owns right now, deduplicated and in a stable order.
    ///
    /// Retired TL generations stay in the set: they should already be idle, but a
    /// drain that skipped them would be exactly the hole a re-seed opens. Same for
    /// run-level threads — the MR-revision dev writes files, so a drain that
    /// missed it would let the worktree keep changing after the locks are gone.
    pub(crate) fn owned_thread_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        let candidates = std::iter::once(self.tl_thread_id.as_str())
            .chain(
                self.tl_succession
                    .iter()
                    .map(|generation| generation.thread_id.as_str()),
            )
            .chain(self.run_owned_thread_ids.iter().map(String::as_str))
            .chain(self.sub_tasks.iter().flat_map(|task| {
                task.owned_thread_ids
                    .iter()
                    .map(String::as_str)
                    .chain(task.dev_thread_id.as_deref())
                    .chain(task.reviewer_thread_id.as_deref())
            }));
        for id in candidates {
            if !id.is_empty() && !ids.iter().any(|seen| seen == id) {
                ids.push(id.to_string());
            }
        }
        ids
    }
}

/// The next action, as a pure function of the record.
///
/// This is what makes resume real rather than aspirational: cold start and
/// restart-resume call it identically, so there is no second code path that can
/// disagree about where the run left off.
pub(crate) fn next_team_action(run: &TeamRun) -> Option<TeamAction> {
    if run.status.is_terminal() {
        return None;
    }
    match run.phase {
        TeamPhase::Intake => Some(TeamAction::TlIntake),
        TeamPhase::Design => Some(TeamAction::TlDesign),
        TeamPhase::DesignReview => Some(TeamAction::ReviewDesign),
        TeamPhase::Planning => Some(TeamAction::TlPlan),
        TeamPhase::SubTasks => {
            // Strictly index-ordered: a sub-task is implemented, reviewed, and
            // reported to the TL before the next one starts, so the TL can adapt
            // the plan while it still matters.
            for (index, task) in run.sub_tasks.iter().enumerate() {
                if !task.status.is_terminal() {
                    return Some(match task.status {
                        SubTaskStatus::Implementing => TeamAction::ReviewSubTask { index },
                        // `Pending` covers both round 1 and a further round after
                        // findings — the reviewer sends work back by resetting here.
                        _ => TeamAction::DevImplement { index },
                    });
                }
                if !task.digested {
                    return Some(TeamAction::TlDigestSubTask { index });
                }
            }
            Some(TeamAction::MrReview)
        }
        TeamPhase::MrGate => Some(match &run.mr_verdict {
            None => TeamAction::MrReview,
            Some(verdict) if verdict.approved => TeamAction::Wrap,
            // Out of budget: wrap and write the leftovers into the report rather
            // than looping on a gate that is not converging.
            Some(_) if run.mr_rounds_used >= run.max_mr_rounds => TeamAction::Wrap,
            Some(_) => TeamAction::TlAddressMr,
        }),
        TeamPhase::Wrapping => Some(TeamAction::Wrap),
        TeamPhase::Finished => None,
    }
}

/// Marker the TL uses to declare whether the task needs a design phase.
const COMPLEXITY_MARKER: &str = "COMPLEXITY:";
/// Markers the TL uses to emit the sub-task list.
const SUBTASK_OPEN: &str = "SUBTASK:";
const SUBTASK_CLOSE: &str = "END SUBTASK";
/// A brief the TL never bounded; long enough for real instructions, short enough
/// that a runaway reply cannot bloat the persisted record.
const MAX_BRIEF_BYTES: usize = 4_000;
const MAX_SUB_TASKS: usize = 24;

/// Whether the TL judged the task complex enough to need a design phase.
///
/// Provisional text convention, the same shape (and the same open question) as
/// `parse_verdict`'s `VERDICT:` line in `state/review.rs`: how a provider is made
/// to emit structure directly — a required tool call versus parsing the last
/// message — is not settled. `None` means the TL did not answer, which the caller
/// treats as "not complex" rather than guessing.
pub(crate) fn parse_complexity(text: &str) -> Option<bool> {
    text.lines().rev().find_map(|line| {
        let rest = line.trim().strip_prefix(COMPLEXITY_MARKER)?;
        match rest.trim().to_ascii_lowercase().as_str() {
            "complex" => Some(true),
            "simple" => Some(false),
            _ => None,
        }
    })
}

/// Parse the TL's sub-task list.
///
/// Block form rather than one line per task, because a brief is prose and has to
/// survive containing punctuation:
///
/// ```text
/// SUBTASK: Add the parser
/// Handle the three encodings, and keep the existing error text.
/// END SUBTASK
/// ```
///
/// An unterminated final block is still accepted — a truncated reply should cost
/// the run its last sub-task, not all of them.
pub(crate) fn parse_sub_tasks(text: &str) -> Vec<SubTask> {
    let mut tasks: Vec<SubTask> = Vec::new();
    let mut current: Option<(String, Vec<String>)> = None;

    let finish = |tasks: &mut Vec<SubTask>, title: String, body: Vec<String>| {
        if tasks.len() >= MAX_SUB_TASKS {
            return;
        }
        let mut brief = body.join("\n").trim().to_string();
        brief.truncate(
            (0..=MAX_BRIEF_BYTES.min(brief.len()))
                .rev()
                .find(|index| brief.is_char_boundary(*index))
                .unwrap_or(0),
        );
        tasks.push(SubTask {
            id: format!("st-{}", tasks.len() + 1),
            title,
            brief,
            ..SubTask::default()
        });
    };

    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(title) = trimmed.strip_prefix(SUBTASK_OPEN) {
            if let Some((title, body)) = current.take() {
                finish(&mut tasks, title, body);
            }
            current = Some((title.trim().to_string(), Vec::new()));
        } else if trimmed == SUBTASK_CLOSE {
            if let Some((title, body)) = current.take() {
                finish(&mut tasks, title, body);
            }
        } else if let Some((_, body)) = current.as_mut() {
            body.push(line.to_string());
        }
    }
    if let Some((title, body)) = current.take() {
        finish(&mut tasks, title, body);
    }
    tasks.retain(|task| !task.title.is_empty());
    tasks
}

/// Prompts the driver sends. Kept beside the model (as `state/review.rs` does)
/// so the wording and the record that shapes it stay in one file.
pub(crate) mod prompts {
    use super::{TaskSpec, SUBTASK_CLOSE, SUBTASK_OPEN};

    fn spec_block(spec: &TaskSpec) -> String {
        format!(
            "# Task\n{}\n\n## Context\n{}\n\n## Acceptance criteria\n{}\n\n\
## Agreed scope\n{}\n\n## Code quality rules\n{}",
            spec.title,
            spec.context,
            spec.acceptance_criteria,
            spec.agreed_scope,
            spec.quality_rules
        )
    }

    /// First TL turn: absorb the task, write the plan file, judge complexity.
    pub(crate) fn intake(spec: &TaskSpec, plan_path: &str, source_dirty: bool) -> String {
        let dirty = if source_dirty {
            "\n\nNote: the repository had uncommitted changes when this task forked. \
They are NOT present in your worktree — you are working from a clean checkout of \
the target branch."
        } else {
            ""
        };
        format!(
            "You are the team lead. You own scope and planning for this task; two \
other agents (a developer and a reviewer) will do the work, each in a fresh \
session per sub-task, and they can only see what you write down.\n\n\
{}\n\n\
Do two things now.\n\n\
1. Write a short plan to `{plan_path}`. Keep it tight — it is re-read on every \
sub-task, and a long file constrains an agent less than a short one, not more. \
Cover only: what we are building, the shape of the approach, and anything a \
developer would otherwise get wrong.\n\n\
2. End your reply with exactly one line:\n\
   COMPLEXITY: complex   (the approach needs designing and reviewing first)\n\
   COMPLEXITY: simple    (go straight to sub-tasks)\n\n\
Do not start implementing.{dirty}",
            spec_block(spec)
        )
    }

    /// TL writes the design (complex tasks only).
    pub(crate) fn design(spec: &TaskSpec, design_path: &str, plan_path: &str) -> String {
        format!(
            "Write the design for this task to `{design_path}`. Your plan is at \
`{plan_path}`.\n\n{}\n\nA reviewer will read the design next and can send it \
back once. Favour naming the decisions and their trade-offs over exhaustive \
detail — the developers read the plan, not the design.",
            spec_block(spec)
        )
    }

    /// TL splits the work.
    pub(crate) fn plan(spec: &TaskSpec, plan_path: &str) -> String {
        format!(
            "Split this task into sub-tasks and update `{plan_path}` to match.\n\n{}\n\n\
Each sub-task gets a developer with a FRESH session and a reviewer with a fresh \
session, and at most two review rounds. So size them to be reviewable in one \
pass, and write each brief to stand ALONE — the developer sees the brief and the \
plan file, nothing else, and none of this conversation.\n\n\
Emit the list in exactly this form, and nothing else after it:\n\n\
{SUBTASK_OPEN} <short title>\n<what to build, and how it should be verified>\n{SUBTASK_CLOSE}",
            spec_block(spec)
        )
    }

    /// Dev implements a sub-task.
    pub(crate) fn dev(
        spec: &TaskSpec,
        title: &str,
        brief: &str,
        plan_path: &str,
        prior_findings: &[String],
    ) -> String {
        let findings = if prior_findings.is_empty() {
            String::new()
        } else {
            format!(
                "\n\nA reviewer looked at your previous attempt and asked for these \
changes. Address them:\n{}",
                prior_findings
                    .iter()
                    .map(|finding| format!("- {finding}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };
        format!(
            "You are the developer on one sub-task of a larger task. The team \
lead's plan is at `{plan_path}` — read it first.\n\n\
## Sub-task: {title}\n{brief}\n\n\
## Code quality rules you will be reviewed against\n{}\n\n\
Implement only this sub-task. Staying inside it matters more than finishing \
everything you can see that needs doing — the other sub-tasks have their own \
developers. If the brief is ambiguous in a way you cannot resolve from the plan \
or the code, ask the user rather than guessing.{findings}",
            spec.quality_rules
        )
    }

    /// TL is told how a sub-task went. Verdict + summary only, never a transcript.
    pub(crate) fn sub_task_result(title: &str, approved: bool, summary: &str) -> String {
        let outcome = if approved {
            "was approved by the reviewer"
        } else {
            "ran out of review rounds without approval"
        };
        format!(
            "Sub-task \"{title}\" {outcome}.\n\n{summary}\n\nUpdate your plan file if \
this changes anything for the remaining sub-tasks. Reply briefly; do not \
implement anything."
        )
    }

    /// The final gate: the whole diff against the agreed scope.
    pub(crate) fn mr_gate(spec: &TaskSpec, diff: &str, workspace: &str) -> String {
        format!(
            "Review this task's complete diff before it is handed back to the user.\n\n\
## Agreed scope\n{}\n\n## Acceptance criteria\n{}\n\n## Code quality rules\n{}\n\n\
Judge two things and nothing else: whether the change stays inside the agreed \
scope, and whether it meets the quality rules. Work you would have done \
differently is not a finding.\n\n\
Working tree under review: {workspace}\n\n```diff\n{diff}\n```\n\n\
End with `VERDICT: APPROVED` or `VERDICT: NEEDS_CHANGES` followed by one \
finding per line.",
            spec.agreed_scope, spec.acceptance_criteria, spec.quality_rules
        )
    }

    /// The team addresses MR-gate findings.
    pub(crate) fn address_mr(findings: &[String], plan_path: &str) -> String {
        format!(
            "The final review of this task's whole diff asked for these changes \
before it can be handed back:\n{}\n\nAddress them. The plan is at `{plan_path}`. \
Change only what these findings call for.",
            findings
                .iter()
                .map(|finding| format!("- {finding}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    }

    /// TL writes the closing report.
    pub(crate) fn wrap(spec: &TaskSpec, report_path: &str, unresolved: &[String]) -> String {
        let leftovers = if unresolved.is_empty() {
            "Nothing was left unresolved.".to_string()
        } else {
            format!(
                "These were NOT resolved and must be written out plainly:\n{}",
                unresolved
                    .iter()
                    .map(|item| format!("- {item}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };
        format!(
            "The work is finished. Write a short report to `{report_path}` for the \
user.\n\nCover: what changed and why, how it maps onto the acceptance criteria, \
and anything you would flag before this is merged.\n\n{leftovers}\n\n\
## Acceptance criteria\n{}",
            spec.acceptance_criteria
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_with(phase: TeamPhase, sub_tasks: Vec<SubTask>) -> TeamRun {
        let mut run = TeamRun::new(
            "run-1".to_string(),
            TaskSpec::default(),
            "/tmp/wt".to_string(),
            "device-1".to_string(),
        );
        run.status = TeamRunStatus::Running;
        run.phase = phase;
        run.sub_tasks = sub_tasks;
        run
    }

    fn sub_task(status: SubTaskStatus, digested: bool) -> SubTask {
        SubTask {
            id: "st".to_string(),
            status,
            digested,
            ..SubTask::default()
        }
    }

    #[test]
    fn unknown_status_decodes_to_failed_not_an_error() {
        // The whole reason this enum exists instead of reusing `RunStatus`: a
        // serde error here would make `PersistenceStore::load` fail, which makes
        // `AppState::new` discard the entire session file.
        let decoded: TeamRunStatus =
            serde_json::from_str("\"a_status_from_a_future_build\"").expect("must not error");
        assert_eq!(decoded, TeamRunStatus::Failed);

        let null: TeamRunStatus = serde_json::from_str("null").expect("null must not error");
        assert_eq!(null, TeamRunStatus::Failed);
    }

    #[test]
    fn known_statuses_round_trip() {
        for status in [
            TeamRunStatus::Queued,
            TeamRunStatus::Running,
            TeamRunStatus::PausePending,
            TeamRunStatus::Paused,
            TeamRunStatus::AwaitingUser,
            TeamRunStatus::Done,
            TeamRunStatus::Escalated,
            TeamRunStatus::Blocked,
            TeamRunStatus::Resolving,
            TeamRunStatus::Failed,
            TeamRunStatus::Interrupted,
            TeamRunStatus::Cancelled,
        ] {
            let encoded = serde_json::to_string(&status).expect("serialize");
            let decoded: TeamRunStatus = serde_json::from_str(&encoded).expect("deserialize");
            assert_eq!(decoded, status, "round trip failed for {}", status.as_str());
            assert_eq!(encoded, format!("\"{}\"", status.as_str()));
        }
    }

    #[test]
    fn a_run_missing_its_status_decodes_to_failed() {
        let decoded: TeamRun = serde_json::from_str("{\"id\":\"r\"}").expect("decode");
        assert_eq!(decoded.status, TeamRunStatus::Failed);
        assert!(decoded.status.is_terminal());
    }

    #[test]
    fn paused_is_non_terminal_and_exempt_from_interrupt() {
        let mut run = run_with(TeamPhase::SubTasks, vec![]);
        run.status = TeamRunStatus::Paused;
        assert!(!run.status.is_terminal(), "paused must stay non-terminal");
        assert!(run.status.is_resumable());

        assert!(
            !run.mark_interrupted_if_stranded(),
            "a deliberate pause has no driver ON PURPOSE and must not be reconciled"
        );
        assert_eq!(run.status, TeamRunStatus::Paused);
    }

    #[test]
    fn a_stranded_running_run_is_reconciled_to_interrupted() {
        let mut run = run_with(TeamPhase::SubTasks, vec![]);
        assert!(run.mark_interrupted_if_stranded());
        assert_eq!(run.status, TeamRunStatus::Interrupted);
        assert!(run.error.is_some(), "the reason must be recorded");

        // Idempotent: a second reconciliation is a no-op.
        assert!(!run.mark_interrupted_if_stranded());
    }

    #[test]
    fn terminal_and_blocked_states_are_sticky() {
        let mut run = run_with(TeamPhase::SubTasks, vec![]);
        run.set_status(TeamRunStatus::Cancelled);
        run.set_status(TeamRunStatus::Running);
        assert_eq!(
            run.status,
            TeamRunStatus::Cancelled,
            "a cancel that won the race must not be clobbered"
        );

        let mut blocked = run_with(TeamPhase::SubTasks, vec![]);
        blocked.block("drain unconfirmed");
        blocked.set_status(TeamRunStatus::Running);
        assert_eq!(blocked.status, TeamRunStatus::Blocked);
        assert!(
            !blocked.status.is_terminal(),
            "blocked still owns its locks"
        );
    }

    #[test]
    fn pausing_is_a_request_then_a_boundary_settlement() {
        let mut run = run_with(TeamPhase::SubTasks, vec![]);
        run.request_pause("device-9");
        assert_eq!(
            run.status,
            TeamRunStatus::PausePending,
            "requesting a pause must not claim the run is already paused"
        );
        assert!(run.pause_requested);

        assert!(run.settle_paused("boundary reached"));
        assert_eq!(run.status, TeamRunStatus::Paused);
        assert!(!run.pause_requested, "the request is consumed by settling");
        assert_eq!(run.pause_reason.as_deref(), Some("boundary reached"));
    }

    #[test]
    fn a_run_the_user_settled_is_off_limits_to_its_driver() {
        // A force stop settles the run while the driver is still inside a turn.
        // That driver then watches its own turn end with no reply and tries to
        // record a failure — so every state a user settles has to be unwritable
        // by a driver, or a successful stop lands as Failed.
        for settled in [
            TeamRunStatus::Paused,
            TeamRunStatus::Blocked,
            TeamRunStatus::Resolving,
        ] {
            let mut run = run_with(TeamPhase::SubTasks, vec![]);
            run.status = settled;

            run.set_status(TeamRunStatus::Running);
            assert_eq!(run.status, settled, "a driver must not restart {settled:?}");
            run.fail("the team lead replied with nothing");
            assert_eq!(
                run.status, settled,
                "a driver must not fail a run it no longer drives"
            );
            assert!(
                run.error.is_none(),
                "and must not leave its own reason behind either"
            );

            // The user, however, can always end it.
            assert!(run.cancel("stopped by the user"));
            assert_eq!(run.status, TeamRunStatus::Cancelled);
        }
    }

    #[test]
    fn every_settled_stop_clears_the_in_flight_marker() {
        // `in_flight_thread` names a turn that may be running with no runtime to
        // observe it, and cleanup reads that as UNKNOWN rather than idle. Leaving
        // a stale one behind therefore blocks a run that is genuinely quiescent —
        // and every settlement below has just PROVEN quiescence.
        let mut paused = run_with(TeamPhase::SubTasks, vec![]);
        paused.in_flight_thread = Some("thread-1".to_string());
        assert!(paused.settle_paused("boundary"));
        assert!(paused.in_flight_thread.is_none());

        let mut cancelled = run_with(TeamPhase::SubTasks, vec![]);
        cancelled.in_flight_thread = Some("thread-1".to_string());
        assert!(cancelled.cancel("stopped by the user"));
        assert!(cancelled.in_flight_thread.is_none());

        let mut recovered = run_with(TeamPhase::SubTasks, vec![]);
        recovered.in_flight_thread = Some("thread-1".to_string());
        recovered.block("a drain that did not confirm");
        assert!(recovered.begin_resolving_blocked());
        assert!(recovered.resolve_as_paused("recovered"));
        assert!(recovered.in_flight_thread.is_none());
    }

    #[test]
    fn a_blocked_run_recovers_into_a_resumable_pause_and_only_once() {
        let mut run = run_with(TeamPhase::SubTasks, vec![]);
        run.sub_tasks = vec![sub_task(SubTaskStatus::Done, true)];
        run.block("a drain that did not confirm");

        assert!(run.begin_resolving_blocked());
        assert_eq!(run.status, TeamRunStatus::Resolving);
        assert!(
            !run.begin_resolving_blocked(),
            "a second recovery must not drain the same threads again"
        );

        assert!(run.resolve_as_paused("recovered by stopping every owned turn"));
        assert_eq!(
            run.status,
            TeamRunStatus::Paused,
            "a drained run keeps its work; it does not get thrown away"
        );
        assert!(run.status.is_resumable());
        assert_eq!(
            run.sub_tasks[0].status,
            SubTaskStatus::Done,
            "finished sub-tasks survive the recovery"
        );
        assert!(
            !run.resolve_as_paused("again"),
            "only a Resolving run can be resolved"
        );
    }

    #[test]
    fn an_interrupted_recovery_falls_back_to_blocked_not_to_limbo() {
        // `Resolving` is non-terminal and has no driver, so a recovery that dies
        // mid-drain would strand the run somewhere nothing ever moves it from.
        let mut run = run_with(TeamPhase::SubTasks, vec![]);
        run.block("a drain that did not confirm");
        assert!(run.begin_resolving_blocked());

        assert!(run.restore_resolving_as_blocked("the recovery was interrupted"));
        assert_eq!(run.status, TeamRunStatus::Blocked);
        assert!(!run.status.is_terminal(), "it still owns its threads");
        assert!(
            !run.restore_resolving_as_blocked("again"),
            "a run that is not resolving has nothing to restore"
        );
    }

    #[test]
    fn settling_a_pause_cannot_resurrect_a_terminal_run() {
        let mut run = run_with(TeamPhase::SubTasks, vec![]);
        run.request_pause("device-9");
        run.set_status(TeamRunStatus::Cancelled);
        assert!(!run.settle_paused("too late"));
        assert_eq!(run.status, TeamRunStatus::Cancelled);
    }

    #[test]
    fn next_team_action_walks_the_pipeline_in_order() {
        let mut run = run_with(TeamPhase::Intake, vec![]);
        assert_eq!(next_team_action(&run), Some(TeamAction::TlIntake));

        run.phase = TeamPhase::Design;
        assert_eq!(next_team_action(&run), Some(TeamAction::TlDesign));

        run.phase = TeamPhase::DesignReview;
        assert_eq!(next_team_action(&run), Some(TeamAction::ReviewDesign));

        run.phase = TeamPhase::Planning;
        assert_eq!(next_team_action(&run), Some(TeamAction::TlPlan));

        run.phase = TeamPhase::Wrapping;
        assert_eq!(next_team_action(&run), Some(TeamAction::Wrap));

        run.phase = TeamPhase::Finished;
        assert_eq!(next_team_action(&run), None);
    }

    #[test]
    fn a_terminal_run_has_no_next_action() {
        let mut run = run_with(
            TeamPhase::SubTasks,
            vec![sub_task(SubTaskStatus::Pending, false)],
        );
        run.status = TeamRunStatus::Cancelled;
        assert_eq!(next_team_action(&run), None);
    }

    #[test]
    fn sub_tasks_run_dev_then_review_then_digest_in_index_order() {
        let run = run_with(
            TeamPhase::SubTasks,
            vec![
                sub_task(SubTaskStatus::Pending, false),
                sub_task(SubTaskStatus::Pending, false),
            ],
        );
        assert_eq!(
            next_team_action(&run),
            Some(TeamAction::DevImplement { index: 0 })
        );

        let mut run = run;
        run.sub_tasks[0].status = SubTaskStatus::Implementing;
        assert_eq!(
            next_team_action(&run),
            Some(TeamAction::ReviewSubTask { index: 0 })
        );

        run.sub_tasks[0].status = SubTaskStatus::Done;
        assert_eq!(
            next_team_action(&run),
            Some(TeamAction::TlDigestSubTask { index: 0 }),
            "a settled sub-task must be reported to the TL before the next one starts"
        );

        run.sub_tasks[0].digested = true;
        assert_eq!(
            next_team_action(&run),
            Some(TeamAction::DevImplement { index: 1 }),
            "only then does sub-task 1 begin"
        );
    }

    #[test]
    fn an_escalated_sub_task_is_still_digested() {
        let mut run = run_with(
            TeamPhase::SubTasks,
            vec![sub_task(SubTaskStatus::Escalated, false)],
        );
        assert_eq!(
            next_team_action(&run),
            Some(TeamAction::TlDigestSubTask { index: 0 }),
            "the TL has to learn about failures too — that is how the plan adapts"
        );

        run.sub_tasks[0].digested = true;
        assert_eq!(
            next_team_action(&run),
            Some(TeamAction::MrReview),
            "with every sub-task settled and reported, the gate is next"
        );
    }

    #[test]
    fn the_mr_gate_reviews_then_revises_up_to_its_budget() {
        let mut run = run_with(TeamPhase::MrGate, vec![]);
        assert_eq!(next_team_action(&run), Some(TeamAction::MrReview));

        // A rejected first round sends work back to the team.
        run.mr_verdict = Some(WorkflowVerdict::needs_changes(vec![
            "scope creep".to_string()
        ]));
        run.mr_rounds_used = 1;
        assert_eq!(next_team_action(&run), Some(TeamAction::TlAddressMr));

        // Approval ends the gate regardless of remaining budget.
        run.mr_verdict = Some(WorkflowVerdict::approved());
        assert_eq!(next_team_action(&run), Some(TeamAction::Wrap));
    }

    #[test]
    fn the_mr_gate_wraps_when_its_budget_runs_out() {
        let mut run = run_with(TeamPhase::MrGate, vec![]);
        run.mr_verdict = Some(WorkflowVerdict::needs_changes(vec![
            "still wrong".to_string()
        ]));
        run.mr_rounds_used = MAX_MR_ROUNDS;
        assert_eq!(
            next_team_action(&run),
            Some(TeamAction::Wrap),
            "an exhausted budget wraps and writes the leftovers out; it does not loop"
        );
    }

    #[test]
    fn next_team_action_is_a_pure_function_of_the_record() {
        let run = run_with(
            TeamPhase::SubTasks,
            vec![
                sub_task(SubTaskStatus::Done, true),
                sub_task(SubTaskStatus::Implementing, false),
            ],
        );
        // Round-tripping through persistence must not change the decision — that
        // is exactly what a restart does before resuming.
        let encoded = serde_json::to_string(&run).expect("serialize");
        let restored: TeamRun = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(next_team_action(&run), next_team_action(&restored));
        assert_eq!(
            next_team_action(&restored),
            Some(TeamAction::ReviewSubTask { index: 1 })
        );
    }

    #[test]
    fn the_current_sub_task_is_derived_not_stored() {
        let mut run = run_with(
            TeamPhase::SubTasks,
            vec![
                sub_task(SubTaskStatus::Done, true),
                sub_task(SubTaskStatus::Pending, false),
            ],
        );
        assert_eq!(run.current_sub_task(), Some(1));

        run.sub_tasks[1].status = SubTaskStatus::Done;
        run.sub_tasks[1].digested = true;
        assert_eq!(run.current_sub_task(), None, "everything settled");
    }

    #[test]
    fn unknown_phase_and_subtask_status_decode_leniently() {
        // `TeamRunStatus` was never the only enum in this record. A strict derive
        // on either of these has exactly the same blast radius: the whole
        // `PersistedRelayState` decode fails and startup discards the state file.
        let phase: TeamPhase =
            serde_json::from_str("\"a_phase_from_a_future_build\"").expect("must not error");
        assert_eq!(
            phase,
            TeamPhase::Finished,
            "an uninterpretable phase must yield no action rather than a guessed one"
        );
        assert_eq!(next_team_action(&run_with(phase, vec![])), None);

        let status: SubTaskStatus =
            serde_json::from_str("\"a_status_from_a_future_build\"").expect("must not error");
        assert_eq!(status, SubTaskStatus::Failed);
        assert!(status.is_terminal(), "so it is never silently re-run");

        // A whole run carrying both still decodes.
        let raw = "{\"id\":\"r\",\"phase\":\"warp_drive\",\
\"sub_tasks\":[{\"id\":\"s\",\"status\":\"quantum\"}]}";
        let run: TeamRun = serde_json::from_str(raw).expect("must not error");
        assert_eq!(run.phase, TeamPhase::Finished);
        assert_eq!(run.sub_tasks[0].status, SubTaskStatus::Failed);
    }

    #[test]
    fn known_phases_and_subtask_statuses_round_trip() {
        for phase in [
            TeamPhase::Intake,
            TeamPhase::Design,
            TeamPhase::DesignReview,
            TeamPhase::Planning,
            TeamPhase::SubTasks,
            TeamPhase::MrGate,
            TeamPhase::Wrapping,
            TeamPhase::Finished,
        ] {
            let encoded = serde_json::to_string(&phase).expect("serialize");
            assert_eq!(encoded, format!("\"{}\"", phase.as_str()));
            let decoded: TeamPhase = serde_json::from_str(&encoded).expect("deserialize");
            assert_eq!(decoded, phase);
        }
        for status in [
            SubTaskStatus::Pending,
            SubTaskStatus::Implementing,
            SubTaskStatus::Done,
            SubTaskStatus::Escalated,
            SubTaskStatus::Failed,
            SubTaskStatus::Skipped,
        ] {
            let encoded = serde_json::to_string(&status).expect("serialize");
            assert_eq!(encoded, format!("\"{}\"", status.as_str()));
            let decoded: SubTaskStatus = serde_json::from_str(&encoded).expect("deserialize");
            assert_eq!(decoded, status);
        }
        // A sub-task with no recorded status has simply not started.
        let task: SubTask = serde_json::from_str("{\"id\":\"s\"}").expect("decode");
        assert_eq!(task.status, SubTaskStatus::Pending);
    }

    #[test]
    fn run_level_threads_are_owned_and_drainable() {
        // The design reviewer, the MR reviewers and the MR-revision dev belong to
        // no sub-task. Before this they had nowhere to live, so a cancel during
        // the MR gate would leave an orphaned turn — and the MR-revision dev keeps
        // WRITING the worktree after the run's locks are released.
        let mut run = run_with(TeamPhase::MrGate, vec![]);
        run.tl_thread_id = "tl-1".to_string();
        run.record_run_thread("design-reviewer-1");
        run.record_run_thread("mr-reviewer-1");
        run.record_run_thread("mr-dev-1");
        run.record_run_thread("mr-reviewer-1");

        let owned = run.owned_thread_ids();
        for expected in ["tl-1", "design-reviewer-1", "mr-reviewer-1", "mr-dev-1"] {
            assert!(
                owned.contains(&expected.to_string()),
                "missing {expected} in {owned:?}"
            );
        }
        assert_eq!(
            owned.len(),
            4,
            "recording twice must not duplicate: {owned:?}"
        );
    }

    #[test]
    fn a_run_with_an_unresumable_tl_settles_terminal_but_keeps_its_worktree() {
        let mut run = run_with(TeamPhase::Intake, vec![]);
        run.status = TeamRunStatus::Paused;
        run.tl_thread_id = "claude-pending-3".to_string();
        run.branch = "task/x".to_string();
        run.cwd = "/repo/.sealwire/worktrees/x".to_string();

        run.detach_unresumable_tl();

        assert_eq!(
            run.status,
            TeamRunStatus::Interrupted,
            "a run naming a thread that cannot come back must not offer Resume"
        );
        assert!(run.tl_thread_id.is_empty());
        assert!(run.error.is_some());
        assert_eq!(
            run.cwd, "/repo/.sealwire/worktrees/x",
            "the worktree is still on disk, so the record of it must survive"
        );
        assert_eq!(run.branch, "task/x");
    }

    #[test]
    fn complexity_is_read_from_the_tls_last_declaration() {
        assert_eq!(parse_complexity("blah\nCOMPLEXITY: complex"), Some(true));
        assert_eq!(parse_complexity("COMPLEXITY: simple\n"), Some(false));
        assert_eq!(
            parse_complexity("COMPLEXITY: complex\nsecond thoughts\nCOMPLEXITY: simple"),
            Some(false),
            "the last declaration wins, like parse_verdict"
        );
        assert_eq!(
            parse_complexity("I think this is complex."),
            None,
            "prose is not a declaration; the caller decides what silence means"
        );
    }

    #[test]
    fn sub_tasks_parse_as_blocks_so_briefs_can_be_prose() {
        let text = "Here is the split.\n\
SUBTASK: Add the parser\n\
Handle all three encodings.\n\
Keep the existing error text: it is asserted on.\n\
END SUBTASK\n\
SUBTASK: Wire it up\n\
Call it from the loader.\n\
END SUBTASK\n";
        let tasks = parse_sub_tasks(text);
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].title, "Add the parser");
        assert!(
            tasks[0].brief.contains("error text: it is asserted on"),
            "punctuation in a brief must survive, got {:?}",
            tasks[0].brief
        );
        assert_eq!(tasks[1].title, "Wire it up");
        assert_eq!(tasks[0].id, "st-1");
        assert_eq!(tasks[1].id, "st-2");
        assert!(tasks.iter().all(|t| t.status == SubTaskStatus::Pending));
    }

    #[test]
    fn an_unterminated_final_sub_task_block_is_still_kept() {
        // A truncated reply should cost the run its last sub-task, not all of them.
        let tasks = parse_sub_tasks("SUBTASK: One\nfirst\nEND SUBTASK\nSUBTASK: Two\nsecond");
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[1].title, "Two");
        assert_eq!(tasks[1].brief, "second");
    }

    #[test]
    fn sub_task_parsing_ignores_prose_and_titleless_blocks() {
        assert!(parse_sub_tasks("I'll split this into three parts.").is_empty());
        assert!(parse_sub_tasks("SUBTASK:\nno title\nEND SUBTASK").is_empty());
    }

    #[test]
    fn sub_task_briefs_are_bounded_and_truncated_on_a_char_boundary() {
        let long = "壁".repeat(4_000);
        let tasks = parse_sub_tasks(&format!("SUBTASK: t\n{long}\nEND SUBTASK"));
        assert_eq!(tasks.len(), 1);
        assert!(
            tasks[0].brief.len() <= MAX_BRIEF_BYTES,
            "got {} bytes",
            tasks[0].brief.len()
        );
        // The real assertion: it is still valid UTF-8 that round-trips.
        let encoded = serde_json::to_string(&tasks[0]).expect("serialize");
        let _: SubTask = serde_json::from_str(&encoded).expect("deserialize");
    }

    #[test]
    fn the_tl_only_ever_learns_a_sub_tasks_verdict_and_summary() {
        // The whole reason the TL can hold one session across a long task.
        let message = prompts::sub_task_result("Add the parser", true, "Added, tests pass.");
        assert!(message.contains("Add the parser"));
        assert!(message.contains("approved"));
        assert!(message.contains("Added, tests pass."));
        assert!(
            !message.to_lowercase().contains("transcript"),
            "no transcript is ever forwarded: {message}"
        );
    }

    #[test]
    fn the_dev_prompt_is_self_contained_because_its_session_is_fresh() {
        let spec = TaskSpec {
            quality_rules: "no unwrap in library code".to_string(),
            ..TaskSpec::default()
        };
        let message = prompts::dev(
            &spec,
            "Add the parser",
            "Handle three encodings.",
            ".sealwire/PLAN.md",
            &["missing test for the empty case".to_string()],
        );
        assert!(message.contains("Add the parser"));
        assert!(message.contains("Handle three encodings."));
        assert!(
            message.contains(".sealwire/PLAN.md"),
            "it must be told where the plan is"
        );
        assert!(message.contains("no unwrap in library code"));
        assert!(
            message.contains("missing test for the empty case"),
            "round 2 must carry the reviewer's findings"
        );
        assert!(
            message.contains("ask the user"),
            "a dev that cannot resolve an ambiguity must know it may ask"
        );
    }

    #[test]
    fn owned_threads_span_the_tl_and_every_sub_task() {
        let mut run = run_with(
            TeamPhase::SubTasks,
            vec![sub_task(SubTaskStatus::Pending, false)],
        );
        run.tl_thread_id = "tl-1".to_string();
        run.sub_tasks[0].owned_thread_ids = vec!["dev-1".to_string(), "rev-1".to_string()];

        let owned = run.owned_thread_ids();
        assert!(owned.contains(&"tl-1".to_string()));
        assert!(owned.contains(&"dev-1".to_string()));
        assert!(owned.contains(&"rev-1".to_string()));
        assert_eq!(owned.len(), 3, "no duplicates: {owned:?}");
    }
}
