//! Task team runner.
//!
//! Drives the fixed three-role pipeline described in `markdown/task-team-design.md`:
//! the TL takes the task in and splits it, a dev implements each sub-task in a
//! FRESH session, a reviewer reviews it in a fresh session (at most
//! `max_review_rounds` rounds), the TL is told the outcome, and a final MR gate
//! judges the whole diff against the user's agreed scope.
//!
//! Three things differ from `run_workflow_job`, all deliberate:
//!
//! 1. **Every action is dispatched by `next_team_action`, a pure function of the
//!    persisted record.** The driver holds no cursor across an await. That is what
//!    makes resume real rather than aspirational — cold start and restart-resume
//!    are the same code path, so there is no second path to disagree.
//!
//! 2. **The pause boundary is the top of the loop, and nowhere else.** A pause
//!    request never stops a turn; it lands after the in-flight turn ends. The
//!    driver then returns NORMALLY so its lifeguard disarms, leaving a durable
//!    `Paused` run with no driver — which is the one state the restore path is
//!    forbidden from reconciling.
//!
//! 3. **`team_turn` re-reads the thread id from the record after send AND after
//!    wait.** `run_turn` does not need to because its author is the parent thread,
//!    whose id is already real. Every team thread is background-started, so every
//!    one of them can be a Claude `claude-pending-*` id that gets re-keyed by
//!    `promote_background_thread` the moment its first turn starts.

use std::time::Duration;

use tokio::time::Instant;

use crate::state::{
    next_team_action, parse_complexity, parse_sub_tasks, parse_verdict, prompts, SubTaskStatus,
    TaskSpec, TeamAction, TeamPhase, TeamRun, TeamRunStatus, TeamThreadSlot, WorkflowVerdict,
};

use super::review::{
    classify_workspace_result, random_suffix, reviewer_thread_settings, ThreadDriveError,
};
use super::worktree::{provision_task_worktree, TaskWorktree, NO_HOOKS};
use super::*;

/// Backstop stall timeout for one team turn. The wait returns as soon as the turn
/// completes; this only trips on a turn that makes no progress at all. Lives on
/// `AppState` as `team_step_stall_ms` so a test can shrink it.

/// How long a turn may stay parked on an `AskUserQuestion` before the run gives
/// up on it. Deliberately enormous: the person being asked may be asleep, and the
/// only cost of waiting is a worktree nobody else wants. It exists so an
/// unanswered question cannot hold the run's locks forever.
const TEAM_ASK_USER_MAX_SECS: u64 = 24 * 60 * 60;

/// Ceiling on a rendered review diff.
///
/// The per-file caps upstream do not bound the TOTAL: tracked output is capped
/// globally, but each untracked file contributes up to 64 KiB and nothing limits
/// how many there are. One generated directory would otherwise build a prompt
/// large enough to exhaust the model's context.
const REVIEW_DIFF_MAX_BYTES: usize = 256 * 1024;

/// Relative paths inside the task worktree. Excluded from git by the same
/// `/.sealwire/` entry that hides the worktrees themselves, which is what keeps
/// the team's own scaffolding out of the branch the user is asked to merge.
const PLAN_REL_PATH: &str = ".sealwire/PLAN.md";
const DESIGN_REL_PATH: &str = ".sealwire/DESIGN.md";
const REPORT_REL_PATH: &str = ".sealwire/REPORT.md";

/// Which of the three seats a thread fills. Only the seat decides its sandbox: a
/// reviewer is read-only, a TL and a dev are not.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum TeamRole {
    Tl,
    Dev,
    Reviewer,
}

impl TeamRole {
    fn as_str(self) -> &'static str {
        match self {
            Self::Tl => "tl",
            Self::Dev => "dev",
            Self::Reviewer => "reviewer",
        }
    }
}

/// How a team turn ended.
#[derive(Debug, PartialEq, Eq)]
enum TeamStepOutcome {
    /// The turn finished and produced fresh assistant text.
    Replied(String),
    /// The turn finished but said nothing new — a no-op agent.
    Silent,
    /// Could not start, timed out, or was stopped. Carries why.
    Failed(String),
}

/// What a user-driven stop leaves behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TeamStopKind {
    /// Stop now and stay resumable. The worktree, branch and plan file survive.
    Pause,
    /// Stop now and hand the slot back. TERMINAL.
    Cancel,
}

impl TeamStopKind {
    fn settled_status(self) -> TeamRunStatus {
        match self {
            Self::Pause => TeamRunStatus::Paused,
            Self::Cancel => TeamRunStatus::Cancelled,
        }
    }

    fn reason(self) -> &'static str {
        match self {
            Self::Pause => "stopped by the user",
            Self::Cancel => "the task was cancelled by the user",
        }
    }
}

/// Crash net for `run_team_job`.
///
/// Unlike `WorkflowRunLifeguard` this must NOT reconcile a resumable run: a
/// paused run has no driver on purpose. `TeamRun::mark_interrupted_if_stranded`
/// enforces that, so this only has to remember to disarm on the deliberate exits.
struct TeamRunLifeguard {
    app: AppState,
    run_id: String,
    disarmed: bool,
}

impl TeamRunLifeguard {
    fn disarm(&mut self) {
        self.disarmed = true;
    }
}

impl Drop for TeamRunLifeguard {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        let app = self.app.clone();
        let run_id = self.run_id.clone();
        tokio::spawn(async move {
            app.interrupt_team_run_if_stranded(&run_id).await;
        });
    }
}

/// The exclusive right to drive one run, held for the driver's lifetime.
///
/// Two concurrent Resumes both read `Paused`, both pass the status guard, and
/// both spawn a driver onto the same worktree — two agents editing the same
/// files with two orchestrators recording over each other. The record cannot
/// express this: "a driver exists" is true only of THIS process, and a `Running`
/// status persists across a restart where no driver does.
///
/// Ownership is per-ticket, not per-run-id, so the caller that claimed it is the
/// one that releases it. A release keyed on the id alone would let a driver
/// finishing its last step free the ticket a newly-resumed driver is holding.
pub(super) struct TeamDriveTicket {
    app: AppState,
    run_id: String,
}

impl Drop for TeamDriveTicket {
    fn drop(&mut self) {
        self.app.release_team_drive(&self.run_id);
    }
}

/// Crash net for a `Blocked` recovery.
///
/// `Resolving` is non-terminal and has no driver, so a recovery that dies
/// mid-drain — a panic, or an HTTP client that hung up — would strand the run in
/// a state nothing ever moves again. Put it back to `Blocked`, which at least
/// keeps the recovery offerable.
struct TeamRecoveryGuard {
    app: AppState,
    run_id: String,
    disarmed: bool,
}

impl TeamRecoveryGuard {
    fn disarm(&mut self) {
        self.disarmed = true;
    }
}

impl Drop for TeamRecoveryGuard {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        let app = self.app.clone();
        let run_id = self.run_id.clone();
        tokio::spawn(async move {
            app.restore_resolving_team_run_as_blocked(
                &run_id,
                "the task's recovery was interrupted before its owned turns confirmed stopping",
            )
            .await;
        });
    }
}

/// What a caller needs to start a task.
#[derive(Debug, Clone, Default)]
pub(crate) struct StartTeamInput {
    pub(crate) spec: TaskSpec,
    /// Any directory inside the repository the task should fork from.
    pub(crate) origin_cwd: String,
    /// Branch to fork from; defaults to the main worktree's current branch.
    pub(crate) target_branch: Option<String>,
    pub(crate) device_id: String,
    pub(crate) tl_provider: String,
    pub(crate) dev_provider: String,
    pub(crate) reviewer_provider: String,
}

impl AppState {
    /// Provision a worktree, record the run, and start driving it.
    pub(crate) async fn start_team_run(&self, input: StartTeamInput) -> Result<String, String> {
        // One at a time in M1, and the check has to be atomic with the insert or
        // two requests can both pass it. `acquire_session_slot` is the existing
        // check-then-act mutex; it is released as soon as the run is recorded, NOT
        // held for the run's lifetime — holding it would block every unrelated
        // user operation.
        let _slot = self.acquire_session_slot()?;
        if self.relay.read().await.has_active_team_run() {
            return Err("another task is already running; pause or finish it first".to_string());
        }

        let origin_cwd = normalize_cwd(&input.origin_cwd);
        let (allowed_roots, device_scope) = {
            let relay = self.relay.read().await;
            (
                relay.allowed_roots.clone(),
                relay.device_path_scope(&input.device_id),
            )
        };
        // The ORIGIN must be in scope too, not only the destination. Provisioning
        // reads and MUTATES the origin's repository — it writes `info/exclude` in
        // the common git dir and creates a branch — so a scope check that only
        // covered the new worktree path would let a device with a configured
        // worktree root reach into a repository it was never granted.
        ensure_path_within_device_scope(&origin_cwd, &device_scope, &allowed_roots)?;
        let origin = LiveWorkspace::from_path(&origin_cwd)
            .ok_or_else(|| format!("workspace {origin_cwd} does not exist"))?;
        let worktree: TaskWorktree = provision_task_worktree(
            &origin,
            &input.spec.title,
            input.target_branch.as_deref(),
            &|planned| ensure_path_within_device_scope(planned, &device_scope, &allowed_roots),
        )
        .await?;

        let run_id = format!("team_{}", random_suffix());
        let mut run = TeamRun::new(
            run_id.clone(),
            input.spec,
            worktree.path.clone(),
            input.device_id,
        );
        run.slug = worktree
            .branch
            .strip_prefix("task/")
            .unwrap_or(&worktree.branch)
            .to_string();
        run.branch = worktree.branch;
        run.target_ref = worktree.target_ref;
        run.base_commit = worktree.base_commit;
        run.repo_main_worktree = worktree.repo_main_worktree;
        run.source_dirty = worktree.source_dirty;
        run.plan_rel_path = PLAN_REL_PATH.to_string();
        run.design_rel_path = DESIGN_REL_PATH.to_string();
        run.report_rel_path = REPORT_REL_PATH.to_string();
        run.tl_provider = input.tl_provider;
        run.dev_provider = input.dev_provider;
        run.reviewer_provider = input.reviewer_provider;

        {
            let mut relay = self.relay.write().await;
            relay.insert_team_run(run);
            relay.push_log(
                "info",
                format!("Task: started {run_id} in {}", worktree.path),
            );
            relay.notify();
        }

        let ticket = self
            .claim_team_drive(&run_id)
            .ok_or_else(|| "this task already has a driver".to_string())?;
        self.spawn_team_driver(run_id.clone(), ticket);
        Ok(run_id)
    }

    /// Pick a paused run back up.
    ///
    /// Cold start and resume are the SAME code path: `next_team_action` is a pure
    /// function of the record, so there is no second path that could disagree
    /// about where the run left off. All this has to do is prove the run may be
    /// driven, prove nothing else is driving it, and hand the driver its ticket.
    pub(crate) async fn resume_team_run(
        &self,
        run_id: Option<String>,
        device_id: Option<String>,
    ) -> Result<TeamRunStatus, String> {
        let (run_id, _device_id) = self
            .authorize_team_action(run_id.as_deref(), device_id)
            .await?;
        let status = self
            .team_run_snapshot(&run_id)
            .await
            .map(|run| run.status)
            .ok_or_else(|| "there is no task with that id".to_string())?;
        if !status.is_resumable() {
            return Err(format!(
                "only a paused task can be resumed; this one is {}",
                status.as_str()
            ));
        }
        // The worktree is where every seat's turns run and cannot be relocated, so
        // a resume into a tree that is gone would fail at the first turn with a
        // provider error instead of a reason. This blocks the run and says so.
        self.require_team_workspace(&run_id)
            .await
            .map_err(|()| "the task worktree no longer exists".to_string())?;

        // Claim BEFORE flipping the status: a ticket we cannot get means another
        // driver is already live, and nothing about the record has changed yet.
        let ticket = self
            .claim_team_drive(&run_id)
            .ok_or_else(|| "this task already has a driver".to_string())?;

        let mut resumed = false;
        {
            let mut relay = self.relay.write().await;
            relay.update_team_run(&run_id, |run| resumed = run.resume());
            if resumed {
                relay.push_log("info", format!("Task {run_id}: resumed"));
                relay.notify();
            }
        }
        if !resumed {
            return Err("this task is no longer paused".to_string());
        }

        self.spawn_team_driver(run_id, ticket);
        Ok(TeamRunStatus::Running)
    }

    /// Validate every restored `Paused` task once the relay is up.
    ///
    /// Deliberately does NOT auto-resume anything: a pause is a decision the user
    /// made, and only the user un-makes it. What it does is stop a Resume from
    /// being offered when it cannot work — a worktree deleted between relay runs
    /// is the ordinary case, and a Resume that dies at its first turn is worse
    /// than a card that says the tree is gone. The branch survives either way, so
    /// blocking loses nothing.
    pub(crate) async fn validate_paused_team_runs(&self) {
        let paused: Vec<(String, String)> = {
            let relay = self.relay.read().await;
            relay
                .team_runs_snapshot()
                .filter(|run| run.status.is_resumable())
                .map(|run| (run.id.clone(), run.cwd.clone()))
                .collect()
        };
        for (run_id, cwd) in paused {
            if LiveWorkspace::from_path(&cwd).is_none() {
                self.block_team_run(
                    &run_id,
                    format!(
                        "the task worktree {cwd} no longer exists, so this task cannot be \
resumed; its branch is untouched"
                    ),
                )
                .await;
            }
        }
    }

    fn spawn_team_driver(&self, run_id: String, ticket: TeamDriveTicket) {
        let app = self.clone();
        tokio::spawn(async move {
            // Held for the driver's whole life, including an unwind: dropping the
            // future drops the ticket, so a panicking driver still frees the run.
            let _ticket = ticket;
            app.run_team_job(run_id).await;
        });
    }

    /// Take the exclusive right to drive a run, or `None` if it is already taken.
    pub(super) fn claim_team_drive(&self, run_id: &str) -> Option<TeamDriveTicket> {
        let claimed = self
            .driving_team_runs
            .lock()
            .map(|mut driving| driving.insert(run_id.to_string()))
            .unwrap_or(false);
        claimed.then(|| TeamDriveTicket {
            app: self.clone(),
            run_id: run_id.to_string(),
        })
    }

    #[cfg(test)]
    pub(crate) fn set_team_step_stall_ms(&self, ms: u64) {
        self.team_step_stall_ms
            .store(ms, std::sync::atomic::Ordering::Relaxed);
    }

    fn release_team_drive(&self, run_id: &str) {
        if let Ok(mut driving) = self.driving_team_runs.lock() {
            driving.remove(run_id);
        }
    }

    /// Ask the run to pause at its next step boundary.
    ///
    /// Sets a flag and NOTHING else: no turn is stopped, no thread is touched.
    /// That is the entire safety property — a dev is never cut off mid-edit, so a
    /// paused worktree is always a tree some agent finished writing. The driver
    /// settles it at the top of its next iteration. Use `force_stop_team_run` when
    /// the wait is unacceptable.
    pub(crate) async fn pause_team_run(
        &self,
        run_id: Option<String>,
        device_id: Option<String>,
    ) -> Result<TeamRunStatus, String> {
        let (run_id, device_id) = self
            .authorize_team_action(run_id.as_deref(), device_id)
            .await?;
        let status = self.require_stoppable_team_run(&run_id).await?;
        // Idempotent: a second Pause on a run that already settled is the user
        // pressing twice, not an error worth surfacing.
        if status == TeamRunStatus::Paused {
            return Ok(status);
        }

        let mut relay = self.relay.write().await;
        relay.update_team_run(&run_id, |run| run.request_pause(&device_id));
        let settled = relay
            .team_run(&run_id)
            .map(|run| run.status)
            .unwrap_or(TeamRunStatus::Failed);
        relay.push_log(
            "info",
            format!("Task {run_id}: pause requested; it settles after the current turn"),
        );
        relay.notify();
        Ok(settled)
    }

    /// Stop the run now rather than at a boundary, keeping it resumable.
    pub(crate) async fn force_stop_team_run(
        &self,
        run_id: Option<String>,
        device_id: Option<String>,
    ) -> Result<TeamRunStatus, String> {
        self.stop_team_run(run_id, device_id, TeamStopKind::Pause)
            .await
    }

    /// Stop the run now and give the slot back. The worktree and branch survive —
    /// the user's work is on disk and deleting it is never this action's call.
    pub(crate) async fn cancel_team_run(
        &self,
        run_id: Option<String>,
        device_id: Option<String>,
    ) -> Result<TeamRunStatus, String> {
        self.stop_team_run(run_id, device_id, TeamStopKind::Cancel)
            .await
    }

    /// The shared body of both immediate stops.
    ///
    /// The ORDER is the design. Requesting the pause first means a driver that
    /// reaches its own boundary while we drain settles there instead of starting
    /// one more turn; draining second confirms every owned turn actually stopped;
    /// settling last goes through `settle_team_run`, which re-checks quiescence
    /// and blocks rather than persisting a stop that is not true. Any other order
    /// leaves a window where the run reads "stopped" while an agent writes.
    async fn stop_team_run(
        &self,
        run_id: Option<String>,
        device_id: Option<String>,
        kind: TeamStopKind,
    ) -> Result<TeamRunStatus, String> {
        let (run_id, device_id) = self
            .authorize_team_action(run_id.as_deref(), device_id)
            .await?;
        self.require_stoppable_team_run(&run_id).await?;

        {
            let mut relay = self.relay.write().await;
            relay.update_team_run(&run_id, |run| run.request_pause(&device_id));
            relay.notify();
        }

        if !self.drain_team_run(&run_id).await {
            self.block_team_run(
                &run_id,
                "the task could not be stopped: at least one owned turn did not confirm stopping",
            )
            .await;
            return Err(
                "this task is blocked because an owned turn did not confirm stopping".to_string(),
            );
        }

        self.settle_team_run(&run_id, kind.settled_status(), kind.reason())
            .await;
        self.team_run_snapshot(&run_id)
            .await
            .map(|run| run.status)
            .ok_or_else(|| "there is no task with that id".to_string())
    }

    /// Recover a `Blocked` task by draining its owned turns again.
    ///
    /// Succeeds into `Paused`, not into a terminal state: a drained run is
    /// quiescent with its worktree, branch and plan file intact, and
    /// `next_team_action` is a pure function of that record. Throwing the run away
    /// would discard finished sub-tasks over a stop that needed two attempts.
    pub(crate) async fn resolve_blocked_team_run(
        &self,
        run_id: Option<String>,
        device_id: Option<String>,
    ) -> Result<TeamRunStatus, String> {
        let device_id = require_device_id(device_id)?;
        let run_id = {
            let mut relay = self.relay.write().await;
            let run_id = relay.blocked_team_run_id(run_id.as_deref())?;
            let cwd = relay
                .team_run(&run_id)
                .map(|run| run.cwd.clone())
                .unwrap_or_default();
            ensure_path_within_device_scope(
                &cwd,
                &relay.device_path_scope(&device_id),
                &relay.allowed_roots,
            )?;
            // Blocked -> Resolving under the SAME write lock that resolved the id,
            // or two recoveries can both pass the check and drain the same threads.
            let mut began = false;
            relay.update_team_run(&run_id, |run| began = run.begin_resolving_blocked());
            if !began {
                return Err("this task is no longer blocked".to_string());
            }
            relay.notify();
            run_id
        };
        let mut guard = TeamRecoveryGuard {
            app: self.clone(),
            run_id: run_id.clone(),
            disarmed: false,
        };

        if !self.drain_team_run(&run_id).await {
            self.block_team_run(
                &run_id,
                "this task is still blocked: at least one owned turn did not confirm stopping",
            )
            .await;
            guard.disarm();
            return Err(
                "this task is still blocked because an owned turn did not confirm stopping"
                    .to_string(),
            );
        }

        {
            let mut relay = self.relay.write().await;
            relay.update_team_run(&run_id, |run| {
                run.resolve_as_paused("recovered by stopping every owned turn");
            });
            relay.push_log(
                "info",
                format!("Task {run_id}: unblocked; owned turns are stopped and it can be resumed"),
            );
            relay.notify();
        }
        guard.disarm();
        Ok(TeamRunStatus::Paused)
    }

    /// Resolve and authorize a whole-run action.
    ///
    /// Authorized by the run's WORKTREE path scope, the way `cancel_review`
    /// authorizes a stop rather than by active-session control: a task you were
    /// allowed to start you must be allowed to stop, and gating that on control
    /// would strand a run whose starter is no longer the controlling device.
    async fn authorize_team_action(
        &self,
        run_id: Option<&str>,
        device_id: Option<String>,
    ) -> Result<(String, String), String> {
        let device_id = require_device_id(device_id)?;
        let relay = self.relay.read().await;
        let run_id = relay.active_team_run_id(run_id)?;
        let cwd = relay
            .team_run(&run_id)
            .map(|run| run.cwd.clone())
            .unwrap_or_default();
        ensure_path_within_device_scope(
            &cwd,
            &relay.device_path_scope(&device_id),
            &relay.allowed_roots,
        )?;
        Ok((run_id, device_id))
    }

    /// The statuses a stop may act on, with a reason for each refusal.
    ///
    /// `Blocked`/`Resolving` are refused rather than re-drained: they already have
    /// a dedicated recovery, and a second drain racing the first is how one
    /// recovery confirms quiescence the other just broke.
    async fn require_stoppable_team_run(&self, run_id: &str) -> Result<TeamRunStatus, String> {
        let status = self
            .team_run_snapshot(run_id)
            .await
            .map(|run| run.status)
            .ok_or_else(|| "there is no task with that id".to_string())?;
        if status.is_terminal() {
            return Err(format!("this task already finished as {}", status.as_str()));
        }
        if matches!(status, TeamRunStatus::Blocked | TeamRunStatus::Resolving) {
            return Err("this task is blocked; resolve it first".to_string());
        }
        Ok(status)
    }

    /// Put a `Resolving` run back to `Blocked` after a recovery that never landed.
    pub(super) async fn restore_resolving_team_run_as_blocked(&self, run_id: &str, error: &str) {
        let mut relay = self.relay.write().await;
        let mut restored = false;
        relay.update_team_run(run_id, |run| {
            restored = run.restore_resolving_as_blocked(error);
        });
        if restored {
            relay.push_log("warn", format!("Task {run_id}: {error}"));
            relay.notify();
        }
    }

    /// The driver loop.
    async fn run_team_job(&self, run_id: String) {
        let mut lifeguard = TeamRunLifeguard {
            app: self.clone(),
            run_id: run_id.clone(),
            disarmed: false,
        };
        self.update_team_status(&run_id, TeamRunStatus::Running)
            .await;

        loop {
            // ---- THE boundary. The only place a pause can land. ----
            if let Some(settled) = self.team_boundary_check(&run_id).await {
                self.settle_team_run(&run_id, settled, "paused at a step boundary")
                    .await;
                // Return normally so the lifeguard disarms: a settled pause is not
                // a stranded run, and reconciling it would destroy the feature.
                lifeguard.disarm();
                return;
            }

            let Some(action) = self.next_team_action_for(&run_id).await else {
                break;
            };

            let progressed = match action {
                TeamAction::TlIntake => self.run_tl_intake(&run_id).await,
                TeamAction::TlDesign => self.run_tl_design(&run_id).await,
                TeamAction::ReviewDesign => self.run_design_review(&run_id).await,
                TeamAction::TlPlan => self.run_tl_plan(&run_id).await,
                TeamAction::DevImplement { index } => self.run_dev_round(&run_id, index).await,
                TeamAction::ReviewSubTask { index } => self.run_review_round(&run_id, index).await,
                TeamAction::TlDigestSubTask { index } => {
                    self.run_digest_sub_task(&run_id, index).await
                }
                TeamAction::MrReview => self.run_mr_round(&run_id).await,
                TeamAction::TlAddressMr => self.run_address_mr(&run_id).await,
                TeamAction::Wrap => self.run_wrap_up(&run_id).await,
            };
            if !progressed {
                // The step already recorded why and settled the run.
                lifeguard.disarm();
                return;
            }
        }

        self.finalize_team_run(&run_id).await;
        lifeguard.disarm();
    }

    /// Whether the run should stop here, and as what. Read-only.
    async fn team_boundary_check(&self, run_id: &str) -> Option<TeamRunStatus> {
        let relay = self.relay.read().await;
        let run = relay.team_run(run_id)?;
        if run.status.is_terminal() {
            return Some(run.status);
        }
        // A user action can settle the run underneath a live driver, so the driver
        // re-reads its own right to continue here rather than only looking for the
        // pause flag it knows about. Without this a force stop would settle
        // `Paused` and then watch the driver walk straight into the next action.
        if run.status.is_settled_without_driver() {
            return Some(run.status);
        }
        run.pause_requested.then_some(TeamRunStatus::Paused)
    }

    async fn next_team_action_for(&self, run_id: &str) -> Option<TeamAction> {
        let relay = self.relay.read().await;
        next_team_action(relay.team_run(run_id)?)
    }

    /// Write a settlement, refusing to persist one that is not true.
    ///
    /// `reason` is recorded only by the settlements that keep one (`Paused`,
    /// `Cancelled`); the sticky and terminal statuses carry their own already.
    async fn settle_team_run(&self, run_id: &str, status: TeamRunStatus, reason: &str) {
        // Already there. The driver and a user action both reach this, and the
        // loser must not re-run the quiescence check against a run it no longer
        // drives — its own next turn would look like a reason to block.
        if self.team_run_snapshot(run_id).await.map(|run| run.status) == Some(status) {
            return;
        }
        // Both of these hand the workspace back — `Paused` to a later resume,
        // `Cancelled` outright — so neither may be written while a turn is still
        // mutating the tree. That would be a lie the user acts on. A run that
        // cannot prove quiescence is Blocked instead, keeping its locks.
        if matches!(status, TeamRunStatus::Paused | TeamRunStatus::Cancelled) {
            let working = self.working_team_threads(run_id).await;
            if !working.is_empty() {
                self.block_team_run(
                    run_id,
                    format!(
                        "cannot settle this task as {}: {} still has a turn in flight",
                        status.as_str(),
                        working.join(", ")
                    ),
                )
                .await;
                return;
            }
        }

        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| match status {
            TeamRunStatus::Paused => {
                run.settle_paused(reason);
            }
            TeamRunStatus::Cancelled => {
                run.cancel(reason);
            }
            other => run.set_status(other),
        });
        relay.notify();
    }

    /// Which of the run's own threads are observably mid-turn right now.
    async fn working_team_threads(&self, run_id: &str) -> Vec<String> {
        let owned = self.team_owned_threads(run_id).await;
        let relay = self.relay.read().await;
        owned
            .into_iter()
            .filter(|id| {
                relay
                    .runtime_for_thread(id)
                    .is_some_and(|runtime| runtime.is_working())
            })
            .collect()
    }

    async fn update_team_status(&self, run_id: &str, status: TeamRunStatus) {
        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| run.set_status(status));
        relay.notify();
    }

    async fn fail_team_run(&self, run_id: &str, error: impl Into<String>) {
        let error = error.into();
        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| run.fail(error.clone()));
        relay.push_log("warn", format!("Task {run_id} failed: {error}"));
        relay.notify();
    }

    async fn block_team_run(&self, run_id: &str, error: impl Into<String>) {
        let error = error.into();
        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| run.block(error.clone()));
        relay.push_log("warn", format!("Task {run_id} blocked: {error}"));
        relay.notify();
    }

    /// Reconcile a run whose driver is gone.
    ///
    /// Draining FIRST is the whole point: a dev or TL turn can still be writing
    /// the worktree, and marking the run terminal releases its locks. An
    /// unconfirmed drain therefore leaves the run `Blocked` (non-terminal, still
    /// owning its threads) rather than Interrupted — the same contract
    /// `interrupt_workflow_if_stranded` follows.
    pub(super) async fn interrupt_team_run_if_stranded(&self, run_id: &str) {
        let resumable = self
            .team_run_snapshot(run_id)
            .await
            .map(|run| run.status.is_terminal() || run.status.is_resumable());
        // A paused run has no driver ON PURPOSE; it is not stranded.
        if resumable.unwrap_or(true) {
            return;
        }

        if !self.drain_team_run(run_id).await {
            self.block_team_run(
                run_id,
                "the task's driver ended unexpectedly and at least one owned turn did not confirm stopping",
            )
            .await;
            return;
        }

        let mut relay = self.relay.write().await;
        let mut interrupted = false;
        relay.update_team_run(run_id, |run| {
            run.error
                .get_or_insert_with(|| "the task's driver ended unexpectedly".to_string());
            interrupted = run.mark_interrupted_if_stranded();
        });
        if interrupted {
            relay.push_log(
                "warn",
                format!("Task {run_id}: driver lost; marked interrupted"),
            );
            relay.notify();
        }
    }

    /// Stop every turn this run owns and confirm each one actually stopped.
    ///
    /// Returns whether ALL of them confirmed. A caller that gets `false` MUST
    /// leave the run non-terminal: settling releases the run's locks, and a dev
    /// turn still writing the worktree after that is unsupervised.
    ///
    /// Shared by the lifeguard and by both user stops on purpose — one contract,
    /// so a stop the user asked for cannot be more optimistic than the one
    /// cleanup performs.
    async fn drain_team_run(&self, run_id: &str) -> bool {
        let mut drained = true;
        for thread_id in self.team_owned_threads(run_id).await {
            drained &= self.stop_and_drain(&thread_id).await;
        }
        // A turn caught mid-start is the dangerous case: the provider marks a
        // thread working only AFTER `start_turn` returns, so a thread with no
        // runtime at all may still be executing. "No runtime" therefore means
        // UNKNOWN here, not idle — confirming it would release the locks while an
        // agent keeps writing. Read AFTER the drain, so a marker cleared by the
        // stop we just landed is not counted against us.
        if let Some(in_flight) = self
            .team_run_snapshot(run_id)
            .await
            .and_then(|run| run.in_flight_thread)
        {
            let observable = self
                .relay
                .read()
                .await
                .runtime_for_thread(&in_flight)
                .is_some();
            if !observable {
                drained = false;
            }
        }
        drained
    }

    async fn team_owned_threads(&self, run_id: &str) -> Vec<String> {
        self.relay
            .read()
            .await
            .team_run(run_id)
            .map(TeamRun::owned_thread_ids)
            .unwrap_or_default()
    }

    async fn team_run_snapshot(&self, run_id: &str) -> Option<TeamRun> {
        self.relay.read().await.team_run(run_id).cloned()
    }

    /// Start a background thread for one seat.
    ///
    /// Mirrors `start_workflow_step_thread`, including the two things that break
    /// silently if skipped: the model must be resolved against THIS provider's own
    /// catalog (or a codex seat inherits a claude model id), and `thread.provider`
    /// / `thread.source` must be stamped or `find_thread_provider` cannot route to
    /// the thread at all.
    async fn start_team_thread(
        &self,
        run_id: &str,
        role: TeamRole,
        workspace: &LiveWorkspace,
    ) -> Result<String, ThreadDriveError> {
        let (provider, model_override) = {
            let relay = self.relay.read().await;
            let run = relay
                .team_run(run_id)
                .ok_or_else(|| ThreadDriveError::Provider("task run is gone".to_string()))?;
            match role {
                TeamRole::Tl => (run.tl_provider.clone(), run.tl_model.clone()),
                TeamRole::Dev => (run.dev_provider.clone(), run.dev_model.clone()),
                TeamRole::Reviewer => (run.reviewer_provider.clone(), run.reviewer_model.clone()),
            }
        };

        let (provider_name, bridge) = {
            let (name, bridge) = self.resolve_provider(Some(&provider))?;
            (name.to_string(), bridge.clone())
        };
        let defaults = self.defaults().await;
        let provider_models = self
            .load_provider_model_catalog(&provider_name, &bridge)
            .await;
        let model = resolve_provider_model(
            &provider_name,
            &provider_models,
            non_empty(Some(model_override)),
            defaults.model.clone(),
        );
        let effort = default_effort_for_model(&provider_models, &model)
            .unwrap_or_else(|| defaults.reasoning_effort.clone());
        let (approval_policy, sandbox) = team_thread_settings(
            &provider_name,
            role,
            &defaults.approval_policy,
            &defaults.sandbox,
        );

        let start = classify_workspace_result(
            workspace,
            bridge
                .start_thread(workspace.as_str(), &model, &approval_policy, &sandbox, None)
                .await,
        )?;
        let mut thread = start.thread;
        thread.provider = provider_name.clone();
        thread.source = provider_name.clone();
        let thread_id = thread.id.clone();

        {
            let mut relay = self.relay.write().await;
            relay.register_background_thread(
                thread,
                workspace.as_str(),
                &model,
                &approval_policy,
                &sandbox,
                &effort,
            );
            // Hide only the reviewer from navigation. Hiding the dev too would put
            // it in `reviewer_thread_ids()`, which `has_working_thread_in_cwd`
            // subtracts — and the dev is the seat that WRITES, so it must stay
            // visible to that guard.
            if role == TeamRole::Reviewer {
                let tl = relay
                    .team_run(run_id)
                    .map(|run| run.tl_thread_id.clone())
                    .unwrap_or_default();
                relay.register_reviewer_thread(thread_id.clone(), tl);
            }
            relay.push_log(
                "info",
                format!(
                    "Task {run_id}: started a {provider_name} {} thread in {}",
                    role.as_str(),
                    workspace.as_str()
                ),
            );
            relay.notify();
        }
        Ok(thread_id)
    }

    /// Run one turn on a team thread and return its fresh reply.
    ///
    /// `thread_ref` names where the run records this thread's id, because the id
    /// can CHANGE mid-turn: a Claude thread starts life as a synthetic
    /// `claude-pending-*` id and `promote_background_thread` re-keys it on the
    /// first turn. Re-reading after send and after wait is what keeps the driver
    /// from talking to a thread that no longer exists.
    async fn team_turn(
        &self,
        run_id: &str,
        slot: TeamThreadSlot,
        role: TeamRole,
        prompt: &str,
    ) -> TeamStepOutcome {
        let Some(mut thread_id) = self.resolve_team_slot(run_id, slot).await else {
            return TeamStepOutcome::Failed(format!("task run {run_id} has no thread in {slot:?}"));
        };
        if let Err(error) = self.team_turn_preflight(run_id, &thread_id).await {
            return TeamStepOutcome::Failed(error);
        }
        let baseline = self
            .latest_assistant_entry(&thread_id)
            .await
            .map(|(id, _)| id);
        self.set_in_flight_thread(run_id, Some(thread_id.clone()))
            .await;

        let model = self
            .relay
            .read()
            .await
            .runtime_for_thread(&thread_id)
            .map(|runtime| runtime.model.clone());

        match self
            .send_message_to_thread(&thread_id, prompt, model.as_deref(), None)
            .await
        {
            Ok(Some(_)) => {}
            // Both are uncertain starts: `Ok(None)` returned no turn id, and a
            // provider can begin work before returning `Err`. Drain either way, or
            // a started turn keeps mutating the worktree after the run settles.
            Ok(None) | Err(_) => {
                let drained = self.stop_and_drain(&thread_id).await;
                self.set_in_flight_thread(run_id, None).await;
                if !drained {
                    return TeamStepOutcome::Failed(format!(
                        "thread {thread_id}'s turn did not confirm stopping after an uncertain start"
                    ));
                }
                return TeamStepOutcome::Failed(format!(
                    "could not start a turn on thread {thread_id}"
                ));
            }
        }
        if let Some(promoted) = self.resolve_team_slot(run_id, slot).await {
            thread_id = promoted;
        }

        let outcome = self.wait_for_team_step(run_id, &thread_id, role).await;
        if let Some(promoted) = self.resolve_team_slot(run_id, slot).await {
            thread_id = promoted;
        }
        if let Some(error) = outcome {
            let drained = self.stop_and_drain(&thread_id).await;
            self.set_in_flight_thread(run_id, None).await;
            if !drained {
                return TeamStepOutcome::Failed(format!(
                    "{error}; and thread {thread_id} did not confirm stopping"
                ));
            }
            return TeamStepOutcome::Failed(error);
        }

        self.set_in_flight_thread(run_id, None).await;
        match self.latest_assistant_entry(&thread_id).await {
            Some((id, text)) if baseline.as_deref() != Some(id.as_str()) => {
                TeamStepOutcome::Replied(text)
            }
            _ => TeamStepOutcome::Silent,
        }
    }

    async fn set_in_flight_thread(&self, run_id: &str, thread_id: Option<String>) {
        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| run.in_flight_thread = thread_id.clone());
    }

    /// Record a run-owned thread and return the slot that now names it.
    async fn record_run_thread(&self, run_id: &str, thread_id: &str) -> TeamThreadSlot {
        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| run.record_run_thread(thread_id.to_string()));
        let index = relay
            .team_run(run_id)
            .and_then(|run| {
                run.run_owned_thread_ids
                    .iter()
                    .position(|id| id == thread_id)
            })
            .unwrap_or(0);
        relay.notify();
        TeamThreadSlot::RunOwned(index)
    }

    /// The live id in a seat. Re-read rather than remembered, because
    /// `promote_background_thread` can replace it mid-turn.
    async fn resolve_team_slot(&self, run_id: &str, slot: TeamThreadSlot) -> Option<String> {
        self.relay
            .read()
            .await
            .team_run(run_id)?
            .thread_in_slot(slot)
    }

    /// Refuse to send when sending would be wrong.
    ///
    /// Deliberately does NOT include `has_working_thread_in_cwd` the way
    /// `workflow_turn_preflight` does: TL, dev and reviewer share one worktree,
    /// and the Claude SDK can start an unrequested turn of its own, so a
    /// cwd-wide notion of "busy" would deadlock the run against itself. The
    /// per-thread live-turn check below is the part that actually protects us.
    async fn team_turn_preflight(&self, run_id: &str, thread_id: &str) -> Result<(), String> {
        let relay = self.relay.read().await;
        let run = relay
            .team_run(run_id)
            .ok_or_else(|| format!("task run {run_id} is gone"))?;
        if run.status.is_terminal() {
            return Err(format!(
                "task run {run_id} settled as {} before this turn started",
                run.status.as_str()
            ));
        }
        if !run.owned_thread_ids().iter().any(|id| id == thread_id) {
            return Err(format!(
                "thread {thread_id} is not owned by task run {run_id}"
            ));
        }
        if relay
            .runtime_for_thread(thread_id)
            .is_some_and(|runtime| runtime.has_live_turn())
        {
            return Err(format!(
                "thread {thread_id} already has a turn in flight; refusing to overlap it"
            ));
        }
        Ok(())
    }

    /// Wait for a team turn to settle. `None` means it completed.
    ///
    /// Deliberately keyed on an explicit thread id and never on the active thread
    /// or the cwd: TL, dev and reviewer share one worktree, and the Claude SDK can
    /// start an unrequested turn of its own (the `task-notification` path), so any
    /// cwd-wide notion of "busy" would deadlock the run against itself.
    ///
    /// Three things happen here that `wait_for_step_idle` does not do, and each is
    /// a consequence of a team turn being long-lived and unattended:
    ///
    /// 1. **A tool approval is RUN-owned.** The worktree is isolated so dev and TL
    ///    run non-prompting; an approval that appears anyway is denied and the SAME
    ///    turn carries on. Denying rather than approving matches the fail-closed
    ///    posture everywhere else here, and it never reaches the user — nobody is
    ///    watching a background turn at 3am.
    /// 2. **An `AskUserQuestion` is USER-owned.** A parked turn is NOT stopped: it
    ///    is blocked inside the provider's tool callback and resumes the instant an
    ///    answer lands. So the wait simply keeps waiting — there is no "resume the
    ///    turn" step to build, which is the single reason this brick is small. A
    ///    parked thread also still reports itself working; see the loop body.
    /// 3. **The stall deadline FREEZES while parked.** Otherwise a user who thinks
    ///    about the question for eleven minutes trips a 600 s timeout that was
    ///    measuring their reading speed rather than the agent's progress. A parked
    ///    turn is bounded by `TEAM_ASK_USER_MAX_SECS` instead.
    async fn wait_for_team_step(
        &self,
        run_id: &str,
        thread_id: &str,
        role: TeamRole,
    ) -> Option<String> {
        let timeout = Duration::from_millis(
            self.team_step_stall_ms
                .load(std::sync::atomic::Ordering::Relaxed),
        );
        let mut deadline = Instant::now() + timeout;
        let mut last_revision = self
            .relay
            .read()
            .await
            .runtime_for_thread(thread_id)
            .map(|runtime| runtime.transcript_revision)
            .unwrap_or(0);
        let mut parked_since: Option<Instant> = None;
        let mut rx = self.subscribe();
        loop {
            let question;
            let has_approval;
            {
                let relay = self.relay.read().await;
                // Only THIS thread's interactions matter. Another thread parking on
                // its own approval is none of this run's business, and denying it
                // would answer a question the user was asked.
                has_approval = relay
                    .pending_approvals
                    .values()
                    .any(|approval| approval.thread_id == thread_id);
                question = relay
                    .pending_ask_user_questions
                    .values()
                    .find(|pending| pending.thread_id == thread_id)
                    .cloned();
                let (working, revision) = match relay.runtime_for_thread(thread_id) {
                    Some(runtime) => (runtime.is_working(), runtime.transcript_revision),
                    None => (false, last_revision),
                };
                // No extra guard for a pending question here, and that is load
                // bearing rather than an omission: `RelayState::set_thread_status`
                // drops a thread's pending requests the moment its status settles,
                // under an explicit contract that every provider marks a thread
                // working BEFORE recording one. So "not working" and "has a parked
                // question" cannot both be true, and a guard for it would be code
                // no test could ever reach.
                if !working {
                    break;
                }
                if revision != last_revision {
                    last_revision = revision;
                    // Progress un-freezes the clock even if a question is still
                    // recorded: the agent is demonstrably moving.
                    deadline = Instant::now() + timeout;
                }
            }

            // Outside the read lock: both of these take locks of their own.
            if has_approval {
                self.auto_handle_team_approval(run_id, thread_id).await;
                continue;
            }

            match (&question, parked_since) {
                (Some(pending), None) => {
                    parked_since = Some(Instant::now());
                    self.park_team_run_on_question(run_id, thread_id, role, pending)
                        .await;
                }
                (None, Some(_)) => {
                    parked_since = None;
                    self.unpark_team_run(run_id).await;
                    // A fresh stall window: the agent starts working again from
                    // here, and none of the time the user spent counts against it.
                    deadline = Instant::now() + timeout;
                }
                _ => {}
            }

            // While parked the stall deadline is frozen and a far longer bound
            // applies, so an unanswered question eventually fails rather than
            // holding the run's worktree forever.
            let wake = match parked_since {
                Some(since) => since + Duration::from_secs(TEAM_ASK_USER_MAX_SECS),
                None => deadline,
            };
            tokio::select! {
                changed = rx.changed() => {
                    if changed.is_err() {
                        break;
                    }
                }
                _ = tokio::time::sleep_until(wake) => {
                    if parked_since.is_some() {
                        self.unpark_team_run(run_id).await;
                        return Some(format!(
                            "thread {thread_id} asked a question that went unanswered for \
            {TEAM_ASK_USER_MAX_SECS}s"
                        ));
                    }
                    return Some(format!(
                        "thread {thread_id} made no progress for {}s",
                        timeout.as_secs()
                    ));
                }
            }
        }
        if parked_since.is_some() {
            self.unpark_team_run(run_id).await;
        }
        None
    }

    /// Deny a tool approval raised by a team thread and let the turn continue.
    ///
    /// The user never sees it: they are not watching, and the isolated worktree is
    /// what makes non-prompting correct in the first place. It IS recorded on the
    /// run, because a denial means the agent was stopped from doing something and
    /// the final report is where the user finds that out.
    async fn auto_handle_team_approval(&self, run_id: &str, thread_id: &str) {
        self.deny_thread_approvals_best_effort(thread_id).await;
        self.clear_thread_interactions(thread_id).await;
        let note = format!(
            "a tool approval on thread {thread_id} was denied automatically; the task \
worktree is sandboxed and nobody is watching a background turn"
        );
        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| {
            // Deduplicated: a thread that keeps asking must not fill the report with
            // the same line.
            if !run.unresolved.iter().any(|entry| entry == &note) {
                run.unresolved.push(note.clone());
            }
        });
        relay.push_log("warn", format!("Task {run_id}: {note}"));
        relay.notify();
    }

    async fn park_team_run_on_question(
        &self,
        run_id: &str,
        thread_id: &str,
        role: TeamRole,
        pending: &crate::state::PendingAskUserQuestion,
    ) {
        let awaiting = crate::state::AwaitingUser {
            thread_id: thread_id.to_string(),
            request_id: pending.request_id.clone(),
            role: role.as_str().to_string(),
            asked_at: pending.requested_at,
        };
        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| {
            run.awaiting = Some(awaiting.clone());
            run.set_status(TeamRunStatus::AwaitingUser);
        });
        relay.push_log(
            "info",
            format!(
                "Task {run_id}: the {} is waiting on your answer",
                role.as_str()
            ),
        );
        // Exactly once per park: this is what wakes the surfaces that render the
        // question card.
        relay.notify();
    }

    async fn unpark_team_run(&self, run_id: &str) {
        let mut relay = self.relay.write().await;
        let mut changed = false;
        relay.update_team_run(run_id, |run| {
            if run.awaiting.take().is_some() {
                changed = true;
            }
            // Only back to Running if the run is still ours to move: a stop that
            // landed while the question was parked settled it already.
            if matches!(run.status, TeamRunStatus::AwaitingUser) {
                run.set_status(TeamRunStatus::Running);
            }
        });
        if changed {
            relay.notify();
        }
    }

    /// The task's live worktree, or `None` if it is gone.
    ///
    /// A missing worktree blocks rather than substituting a nearby tree: provider
    /// threads re-send their cwd every turn and cannot be relocated, so "diff
    /// something else instead" would be answering a different question.
    async fn team_workspace(&self, run_id: &str) -> Option<LiveWorkspace> {
        let cwd = self.relay.read().await.team_run(run_id)?.cwd.clone();
        LiveWorkspace::from_path(&cwd)
    }

    async fn require_team_workspace(&self, run_id: &str) -> Result<LiveWorkspace, ()> {
        match self.team_workspace(run_id).await {
            Some(workspace) => Ok(workspace),
            None => {
                let recorded = self
                    .team_run_snapshot(run_id)
                    .await
                    .map(|run| run.cwd)
                    .unwrap_or_default();
                self.block_team_run(
                    run_id,
                    format!("the task worktree {recorded} no longer exists"),
                )
                .await;
                Err(())
            }
        }
    }

    /// Ensure the TL has a live thread, starting one on first use.
    async fn ensure_tl_thread(&self, run_id: &str) -> Result<String, ()> {
        if let Some(existing) = self
            .team_run_snapshot(run_id)
            .await
            .map(|run| run.tl_thread_id)
            .filter(|id| !id.is_empty())
        {
            return Ok(existing);
        }
        let workspace = self.require_team_workspace(run_id).await?;
        match self
            .start_team_thread(run_id, TeamRole::Tl, &workspace)
            .await
        {
            Ok(thread_id) => {
                let mut relay = self.relay.write().await;
                relay.update_team_run(run_id, |run| run.tl_thread_id = thread_id.clone());
                relay.notify();
                Ok(thread_id)
            }
            Err(error) => {
                self.fail_team_run(run_id, format!("could not start the team lead: {error}"))
                    .await;
                Err(())
            }
        }
    }

    /// Run one TL turn, counting it against the generation's turn budget.
    async fn tl_turn(&self, run_id: &str, prompt: String) -> Option<String> {
        self.ensure_tl_thread(run_id).await.ok()?;
        let outcome = self
            .team_turn(run_id, TeamThreadSlot::Tl, TeamRole::Tl, &prompt)
            .await;
        {
            let mut relay = self.relay.write().await;
            relay.update_team_run(run_id, |run| run.tl_turns_this_generation += 1);
        }
        match outcome {
            TeamStepOutcome::Replied(text) => Some(text),
            TeamStepOutcome::Silent => {
                self.fail_team_run(run_id, "the team lead replied with nothing")
                    .await;
                None
            }
            TeamStepOutcome::Failed(error) => {
                self.fail_team_run(run_id, error).await;
                None
            }
        }
    }

    async fn run_tl_intake(&self, run_id: &str) -> bool {
        let Some(run) = self.team_run_snapshot(run_id).await else {
            return false;
        };
        let prompt = prompts::intake(&run.spec, &run.plan_rel_path, run.source_dirty);
        let Some(reply) = self.tl_turn(run_id, prompt).await else {
            return false;
        };
        // Silence is not "complex": a TL that did not answer gets the cheaper path,
        // and the design phase stays something it has to ASK for.
        let complex = parse_complexity(&reply).unwrap_or(false);
        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| {
            run.complex = Some(complex);
            run.phase = if complex {
                TeamPhase::Design
            } else {
                TeamPhase::Planning
            };
        });
        relay.notify();
        true
    }

    async fn run_tl_design(&self, run_id: &str) -> bool {
        let Some(run) = self.team_run_snapshot(run_id).await else {
            return false;
        };
        let prompt = prompts::design(&run.spec, &run.design_rel_path, &run.plan_rel_path);
        if self.tl_turn(run_id, prompt).await.is_none() {
            return false;
        }
        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| run.phase = TeamPhase::DesignReview);
        relay.notify();
        true
    }

    async fn run_design_review(&self, run_id: &str) -> bool {
        let Ok(workspace) = self.require_team_workspace(run_id).await else {
            return false;
        };
        let Some(run) = self.team_run_snapshot(run_id).await else {
            return false;
        };
        let thread_id = match self
            .start_team_thread(run_id, TeamRole::Reviewer, &workspace)
            .await
        {
            Ok(id) => id,
            Err(error) => {
                self.fail_team_run(
                    run_id,
                    format!("could not start the design reviewer: {error}"),
                )
                .await;
                return false;
            }
        };
        let slot = self.record_run_thread(run_id, &thread_id).await;

        let prompt = format!(
            "Review the design at `{}` against this task.\n\n## Agreed scope\n{}\n\n\
## Acceptance criteria\n{}\n\nEnd with `VERDICT: APPROVED` or \
`VERDICT: NEEDS_CHANGES` followed by one finding per line.",
            run.design_rel_path, run.spec.agreed_scope, run.spec.acceptance_criteria
        );
        let text = match self
            .team_turn(run_id, slot, TeamRole::Reviewer, &prompt)
            .await
        {
            TeamStepOutcome::Replied(text) => text,
            TeamStepOutcome::Silent => String::new(),
            TeamStepOutcome::Failed(error) => {
                self.fail_team_run(run_id, error).await;
                return false;
            }
        };
        let verdict = verdict_from(&text);

        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| {
            run.design_review_rounds += 1;
            let exhausted = run.design_review_rounds >= run.max_review_rounds;
            if !verdict.approved && !exhausted {
                // Send it back for one more pass.
                run.phase = TeamPhase::Design;
            } else {
                if !verdict.approved {
                    // Record something even when the reviewer produced no parsed
                    // findings, or a silent rejection would leave `unresolved`
                    // empty and the run could still finish Done.
                    if verdict.findings.is_empty() {
                        run.unresolved.push(
                            "the design was not approved within its review budget".to_string(),
                        );
                    } else {
                        run.unresolved.extend(verdict.findings.iter().cloned());
                    }
                }
                run.phase = TeamPhase::Planning;
            }
            run.design_verdict = Some(verdict.clone());
        });
        relay.notify();
        true
    }

    async fn run_tl_plan(&self, run_id: &str) -> bool {
        let Some(run) = self.team_run_snapshot(run_id).await else {
            return false;
        };
        let prompt = prompts::plan(&run.spec, &run.plan_rel_path);
        let Some(reply) = self.tl_turn(run_id, prompt).await else {
            return false;
        };
        let sub_tasks = parse_sub_tasks(&reply);
        if sub_tasks.is_empty() {
            self.fail_team_run(
                run_id,
                "the team lead produced no sub-tasks; nothing to hand to a developer",
            )
            .await;
            return false;
        }
        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| {
            run.sub_tasks = sub_tasks;
            run.phase = TeamPhase::SubTasks;
        });
        relay.notify();
        true
    }

    async fn run_dev_round(&self, run_id: &str, index: usize) -> bool {
        let Ok(workspace) = self.require_team_workspace(run_id).await else {
            return false;
        };
        let Some(run) = self.team_run_snapshot(run_id).await else {
            return false;
        };
        let Some(task) = run.sub_tasks.get(index).cloned() else {
            return false;
        };

        // Round 1 gets a FRESH dev; a later round reuses it so it can see its own
        // prior work. The checkpoint taken here is what scopes the review diff to
        // this sub-task rather than everything since the run began.
        let _seat = match task.dev_thread_id.clone() {
            Some(existing) if task.rounds_used > 0 => existing,
            _ => {
                let base = self.checkpoint_commit(&workspace).await;
                let started = match self
                    .start_team_thread(run_id, TeamRole::Dev, &workspace)
                    .await
                {
                    Ok(id) => id,
                    Err(error) => {
                        self.fail_team_run(run_id, format!("could not start a developer: {error}"))
                            .await;
                        return false;
                    }
                };
                let mut relay = self.relay.write().await;
                relay.update_team_run(run_id, |run| {
                    if let Some(task) = run.sub_tasks.get_mut(index) {
                        task.dev_thread_id = Some(started.clone());
                        task.owned_thread_ids.push(started.clone());
                        if task.base_commit.is_empty() {
                            task.base_commit = base.clone().unwrap_or_default();
                        }
                    }
                });
                relay.notify();
                started
            }
        };

        let prior_findings = task
            .last_verdict
            .as_ref()
            .map(|verdict| verdict.findings.clone())
            .unwrap_or_default();
        let prompt = prompts::dev(
            &run.spec,
            &task.title,
            &task.brief,
            &run.plan_rel_path,
            &prior_findings,
        );
        let outcome = self
            .team_turn(
                run_id,
                TeamThreadSlot::SubTaskDev(index),
                TeamRole::Dev,
                &prompt,
            )
            .await;
        if let TeamStepOutcome::Failed(error) = outcome {
            self.fail_team_run(run_id, error).await;
            return false;
        }

        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| {
            if let Some(task) = run.sub_tasks.get_mut(index) {
                task.status = SubTaskStatus::Implementing;
            }
        });
        relay.notify();
        true
    }

    async fn run_review_round(&self, run_id: &str, index: usize) -> bool {
        let Ok(workspace) = self.require_team_workspace(run_id).await else {
            return false;
        };
        let Some(run) = self.team_run_snapshot(run_id).await else {
            return false;
        };
        let Some(task) = run.sub_tasks.get(index).cloned() else {
            return false;
        };

        // A FRESH reviewer every round, so round 2 judges the work rather than
        // defending its own round-1 opinion.
        let thread_id = match self
            .start_team_thread(run_id, TeamRole::Reviewer, &workspace)
            .await
        {
            Ok(id) => id,
            Err(error) => {
                self.fail_team_run(run_id, format!("could not start a reviewer: {error}"))
                    .await;
                return false;
            }
        };
        {
            let mut relay = self.relay.write().await;
            relay.update_team_run(run_id, |run| {
                if let Some(task) = run.sub_tasks.get_mut(index) {
                    task.reviewer_thread_id = Some(thread_id.clone());
                    task.owned_thread_ids.push(thread_id.clone());
                }
            });
            relay.notify();
        }

        let base = non_empty(Some(task.base_commit.clone()));
        let diff = match collect_workspace_diff_against(&workspace, base.as_deref()).await {
            Ok(response) => render_review_diff(&response),
            Err(error) => {
                self.fail_team_run(
                    run_id,
                    format!("could not collect the review diff: {error}"),
                )
                .await;
                return false;
            }
        };
        let prompt = format!(
            "Review this sub-task's changes.\n\n## Sub-task: {}\n{}\n\n\
## Code quality rules\n{}\n\nWorking tree: {}\n\n```diff\n{diff}\n```\n\n\
End with `VERDICT: APPROVED` or `VERDICT: NEEDS_CHANGES` followed by one \
finding per line.",
            task.title,
            task.brief,
            run.spec.quality_rules,
            workspace.as_str()
        );

        let text = match self
            .team_turn(
                run_id,
                TeamThreadSlot::SubTaskReviewer(index),
                TeamRole::Reviewer,
                &prompt,
            )
            .await
        {
            TeamStepOutcome::Replied(text) => text,
            TeamStepOutcome::Silent => String::new(),
            TeamStepOutcome::Failed(error) => {
                self.fail_team_run(run_id, error).await;
                return false;
            }
        };
        let verdict = verdict_from(&text);

        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| {
            let max_rounds = run.max_review_rounds;
            if let Some(task) = run.sub_tasks.get_mut(index) {
                task.rounds_used += 1;
                if verdict.approved {
                    task.status = SubTaskStatus::Done;
                    task.result_summary = Some(
                        verdict
                            .summary
                            .clone()
                            .unwrap_or_else(|| "Approved.".to_string()),
                    );
                } else if task.rounds_used >= max_rounds {
                    task.status = SubTaskStatus::Escalated;
                    task.result_summary = Some(format!(
                        "Unresolved after {} review round(s):\n{}",
                        task.rounds_used,
                        verdict
                            .findings
                            .iter()
                            .map(|finding| format!("- {finding}"))
                            .collect::<Vec<_>>()
                            .join("\n")
                    ));
                } else {
                    // Back to the same dev for another round.
                    task.status = SubTaskStatus::Pending;
                }
                task.last_verdict = Some(verdict.clone());
            }
        });
        relay.notify();
        true
    }

    async fn run_digest_sub_task(&self, run_id: &str, index: usize) -> bool {
        let Some(run) = self.team_run_snapshot(run_id).await else {
            return false;
        };
        let Some(task) = run.sub_tasks.get(index).cloned() else {
            return false;
        };
        // Skipped sub-tasks have nothing to report.
        if task.status != SubTaskStatus::Skipped {
            let approved = task.status == SubTaskStatus::Done;
            let summary = task.result_summary.clone().unwrap_or_default();
            let prompt = prompts::sub_task_result(&task.title, approved, &summary);
            if self.tl_turn(run_id, prompt).await.is_none() {
                return false;
            }
        }
        // Checkpoint the sub-task before moving on. Without this HEAD never
        // advances, so the NEXT sub-task's base is the same commit and its
        // reviewer is handed every earlier sub-task's changes as though they
        // were its own.
        if let Ok(workspace) = self.require_team_workspace(run_id).await {
            if let Err(error) = self
                .commit_worktree(&workspace, &format!("task: {}", task.title))
                .await
            {
                self.fail_team_run(run_id, error).await;
                return false;
            }
        } else {
            return false;
        }

        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| {
            if let Some(task) = run.sub_tasks.get_mut(index) {
                task.digested = true;
            }
            if run.sub_tasks.iter().all(|task| task.digested) {
                run.phase = TeamPhase::MrGate;
            }
        });
        relay.notify();
        true
    }

    async fn run_mr_round(&self, run_id: &str) -> bool {
        let Ok(workspace) = self.require_team_workspace(run_id).await else {
            return false;
        };
        let Some(run) = self.team_run_snapshot(run_id).await else {
            return false;
        };
        // Commit first so the gate reviews a settled tree, and so the branch
        // carries the work even if the gate then escalates. A failure here must
        // stop the run: reviewing an uncommitted tree and then reporting Done is
        // exactly how work goes missing.
        if let Err(error) = self
            .commit_worktree(&workspace, "task: work in progress")
            .await
        {
            self.fail_team_run(run_id, error).await;
            return false;
        }

        // A missing merge base must never fall through to `HEAD`. The tree was
        // just committed, so diffing against HEAD yields NOTHING — the gate would
        // approve an empty change and the run would report Done. Deleting the
        // target branch, or force-pushing it to unrelated history, is enough to
        // reach this. Fall back to the fork point recorded at provisioning time,
        // and refuse outright if even that is gone.
        let base = match merge_base_with(&workspace, &run.target_ref).await {
            Some(base) => base,
            None if !run.base_commit.is_empty() => {
                self.push_runtime_log(
                    "warn",
                    format!(
                        "Task {run_id}: {} has no merge base with this task; \
diffing against the recorded fork point instead.",
                        run.target_ref
                    ),
                )
                .await;
                run.base_commit.clone()
            }
            None => {
                self.fail_team_run(
                    run_id,
                    format!(
                        "cannot determine what to diff this task against: {} has no common \
history with it and no fork point was recorded",
                        run.target_ref
                    ),
                )
                .await;
                return false;
            }
        };
        let diff = match collect_workspace_diff_against(&workspace, Some(&base)).await {
            Ok(response) => render_review_diff(&response),
            Err(error) => {
                self.fail_team_run(run_id, format!("could not collect the MR diff: {error}"))
                    .await;
                return false;
            }
        };

        let thread_id = match self
            .start_team_thread(run_id, TeamRole::Reviewer, &workspace)
            .await
        {
            Ok(id) => id,
            Err(error) => {
                self.fail_team_run(
                    run_id,
                    format!("could not start the final reviewer: {error}"),
                )
                .await;
                return false;
            }
        };
        {
            let mut relay = self.relay.write().await;
            relay.update_team_run(run_id, |run| run.record_run_thread(thread_id.clone()));
            relay.notify();
        }
        let slot = self.record_run_thread(run_id, &thread_id).await;

        let prompt = prompts::mr_gate(&run.spec, &diff, workspace.as_str());
        let text = match self
            .team_turn(run_id, slot, TeamRole::Reviewer, &prompt)
            .await
        {
            TeamStepOutcome::Replied(text) => text,
            TeamStepOutcome::Silent => String::new(),
            TeamStepOutcome::Failed(error) => {
                self.fail_team_run(run_id, error).await;
                return false;
            }
        };
        let verdict = verdict_from(&text);

        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| {
            run.mr_rounds_used += 1;
            if verdict.approved {
                run.phase = TeamPhase::Wrapping;
            } else if run.mr_rounds_used >= run.max_mr_rounds {
                run.unresolved.extend(verdict.findings.iter().cloned());
                run.phase = TeamPhase::Wrapping;
            }
            run.mr_verdict = Some(verdict.clone());
        });
        relay.notify();
        true
    }

    async fn run_address_mr(&self, run_id: &str) -> bool {
        let Ok(workspace) = self.require_team_workspace(run_id).await else {
            return false;
        };
        let Some(run) = self.team_run_snapshot(run_id).await else {
            return false;
        };
        let findings = run
            .mr_verdict
            .as_ref()
            .map(|verdict| verdict.findings.clone())
            .unwrap_or_default();

        let thread_id = match self
            .start_team_thread(run_id, TeamRole::Dev, &workspace)
            .await
        {
            Ok(id) => id,
            Err(error) => {
                self.fail_team_run(run_id, format!("could not start a developer: {error}"))
                    .await;
                return false;
            }
        };
        let slot = self.record_run_thread(run_id, &thread_id).await;

        let prompt = prompts::address_mr(&findings, &run.plan_rel_path);
        if let TeamStepOutcome::Failed(error) =
            self.team_turn(run_id, slot, TeamRole::Dev, &prompt).await
        {
            self.fail_team_run(run_id, error).await;
            return false;
        }
        // Clearing the verdict sends the gate back to `MrReview` on the next tick.
        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| run.mr_verdict = None);
        relay.notify();
        true
    }

    async fn run_wrap_up(&self, run_id: &str) -> bool {
        let Ok(workspace) = self.require_team_workspace(run_id).await else {
            return false;
        };
        let Some(run) = self.team_run_snapshot(run_id).await else {
            return false;
        };
        let prompt = prompts::wrap(&run.spec, &run.report_rel_path, &run.unresolved);
        if self.tl_turn(run_id, prompt).await.is_none() {
            return false;
        }
        if let Err(error) = self.commit_worktree(&workspace, "task: final").await {
            self.fail_team_run(run_id, error).await;
            return false;
        }
        let head = self.checkpoint_commit(&workspace).await;

        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| {
            run.head_commit = head.clone();
            run.phase = TeamPhase::Finished;
        });
        relay.notify();
        true
    }

    async fn finalize_team_run(&self, run_id: &str) {
        let Some(run) = self.team_run_snapshot(run_id).await else {
            return;
        };
        let approved = run
            .mr_verdict
            .as_ref()
            .map(|verdict| verdict.approved)
            .unwrap_or(false);
        let all_done = run
            .sub_tasks
            .iter()
            .all(|task| task.status == SubTaskStatus::Done);
        let design_ok = run
            .design_verdict
            .as_ref()
            .map(|verdict| verdict.approved)
            .unwrap_or(true);
        let status = if approved && all_done && design_ok && run.unresolved.is_empty() {
            TeamRunStatus::Done
        } else {
            TeamRunStatus::Escalated
        };
        self.update_team_status(run_id, status).await;
    }

    /// `git add -A` + commit. Returns whether a commit was created.
    ///
    /// Errors propagate. A silently-failed commit is the worst outcome available
    /// here: the MR gate would review an uncommitted tree, `head_commit` would
    /// point at the pre-existing HEAD, and the run would report Done with the
    /// work still sitting in the working tree. A missing `user.email` is enough
    /// to trigger exactly that.
    ///
    /// Hooks are suppressed the same way provisioning suppresses them.
    /// `--no-verify` alone is NOT sufficient: it skips `pre-commit` and
    /// `commit-msg`, but `prepare-commit-msg` and `post-commit` still run, which
    /// would reopen the arbitrary-code surface on an unaudited repository.
    pub(super) async fn commit_worktree(
        &self,
        workspace: &LiveWorkspace,
        message: &str,
    ) -> Result<bool, String> {
        let staged = run_git_capture(workspace, &["add", "-A"]).await?;
        if !staged.status.success() {
            return Err(format!(
                "git add failed in {}: {}",
                workspace.as_str(),
                String::from_utf8_lossy(&staged.stderr).trim()
            ));
        }

        let pending = run_git_capture(workspace, &["diff", "--cached", "--quiet"]).await?;
        // Exit 0 means nothing is staged. Any OTHER non-zero code than 1 is a real
        // git failure, and treating it as "nothing to commit" is how work goes
        // missing, so only code 1 (differences found) proceeds.
        match pending.status.code() {
            Some(0) => return Ok(false),
            Some(1) => {}
            other => {
                return Err(format!(
                    "git diff --cached failed in {} (exit {:?}): {}",
                    workspace.as_str(),
                    other,
                    String::from_utf8_lossy(&pending.stderr).trim()
                ))
            }
        }

        let committed = run_git_capture(
            workspace,
            &["-c", NO_HOOKS, "commit", "--no-verify", "-m", message],
        )
        .await?;
        if !committed.status.success() {
            return Err(format!(
                "git commit failed in {}: {}",
                workspace.as_str(),
                String::from_utf8_lossy(&committed.stderr).trim()
            ));
        }
        Ok(true)
    }

    async fn checkpoint_commit(&self, workspace: &LiveWorkspace) -> Option<String> {
        let output = run_git_capture(workspace, &["rev-parse", "--verify", "--quiet", "HEAD"])
            .await
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .filter(|commit| !commit.is_empty())
    }
}

/// Provider/role settings for a team thread.
///
/// The reviewer reuses `reviewer_thread_settings` verbatim — read-only where the
/// provider supports it, and (on Claude) with `AskUserQuestion` withheld, which
/// is exactly the product rule: a reviewer never talks to the user. TL and dev
/// run non-prompting but writable, because the worktree is isolated and there is
/// nobody to answer a tool approval; their `AskUserQuestion` channel stays open.
fn team_thread_settings(
    provider: &str,
    role: TeamRole,
    default_approval: &str,
    default_sandbox: &str,
) -> (String, String) {
    if role == TeamRole::Reviewer {
        let (approval, sandbox, _) =
            reviewer_thread_settings(provider, default_approval, default_sandbox);
        return (approval, sandbox);
    }
    match provider {
        "codex" => ("never".to_string(), "workspace-write".to_string()),
        "claude" | "claude_code" => ("bypass".to_string(), default_sandbox.to_string()),
        _ => (default_approval.to_string(), default_sandbox.to_string()),
    }
}

/// Turn a reviewer's reply into a structured verdict.
///
/// Provisional, and the same open question `state/workflow.rs` records: this
/// parses `VERDICT:` out of free text rather than requiring a tool call.
fn verdict_from(text: &str) -> WorkflowVerdict {
    let parsed = parse_verdict(text);
    if parsed.is_approved() {
        return WorkflowVerdict {
            approved: true,
            summary: Some(first_meaningful_line(text)),
            findings: Vec::new(),
        };
    }
    WorkflowVerdict {
        approved: false,
        summary: Some(first_meaningful_line(text)),
        findings: findings_from(text),
    }
}

fn first_meaningful_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("VERDICT:"))
        .unwrap_or("")
        .to_string()
}

fn findings_from(text: &str) -> Vec<String> {
    text.lines()
        .skip_while(|line| !line.trim().starts_with("VERDICT:"))
        .skip(1)
        .map(|line| line.trim().trim_start_matches(['-', '*', ' ']).to_string())
        .filter(|line| !line.is_empty())
        .take(20)
        .collect()
}

/// Render a diff for a reviewer.
///
/// Uses `file_changes` rather than `WorkspaceDiffResponse::diff`, because `diff`
/// carries only TRACKED changes — untracked files are synthesized separately into
/// `file_changes`. Agents create files constantly, so reading the tracked-only
/// field would hand a reviewer a diff with the new code missing and ask it to
/// approve.
pub(super) fn render_review_diff(response: &crate::protocol::WorkspaceDiffResponse) -> String {
    if response.file_changes.is_empty() {
        return String::new();
    }
    let mut rendered = String::new();
    let mut dropped = 0usize;
    for change in &response.file_changes {
        let piece = if change.diff.trim().is_empty() {
            format!(
                "--- {} ({}, no textual diff)\n",
                change.path, change.change_type
            )
        } else {
            format!("{}\n", change.diff)
        };
        if rendered.len() + piece.len() > REVIEW_DIFF_MAX_BYTES {
            dropped += 1;
            continue;
        }
        rendered.push_str(&piece);
    }
    if dropped > 0 {
        // Say so rather than truncating silently: a reviewer that could not see a
        // file must not be left believing it saw everything.
        rendered.push_str(&format!(
            "\n[{dropped} more changed file(s) omitted: this diff exceeded {} KiB. \
Treat anything you were not shown as unreviewed.]\n",
            REVIEW_DIFF_MAX_BYTES / 1024
        ));
    }
    rendered
}
