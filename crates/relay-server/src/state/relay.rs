mod approval;
mod ask_user_question;
mod background;
mod device;
mod push;
mod runtime;
mod transcript;

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc, watch};

use crate::{
    protocol::{
        ApprovalReceipt, FileChangeApplyState, LogEntryView, ModelOptionView, SessionSnapshot,
        ThreadActivityView, ThreadEntriesResponse, ThreadEntryDetailResponse, ThreadSummaryView,
        ThreadTranscriptResponse, ThreadsResponse, TranscriptDeltaEvent,
    },
    provider::ThreadSyncData,
};

use super::{
    ensure_path_within_device_scope, persistence::PersistedRelayState, unix_now, ReviewJob,
    RunStatus, SecurityProfile, TaskListRun, WorkflowRun, CONTROLLER_LEASE_SECS,
    DEFAULT_APPROVAL_POLICY, DEFAULT_EFFORT, DEFAULT_MODEL, DEFAULT_SANDBOX,
    STALE_TURN_PROGRESS_TIMEOUT_SECS,
};

pub use self::approval::{ApprovalKind, PendingApproval};
pub use self::ask_user_question::{parse_ask_user_questions, PendingAskUserQuestion};
pub(crate) use self::device::{
    BrokerPendingMessage, ClaimChallenge, CompletedPairing, CompletedRemoteClaim, DeviceRecord,
    IssuedClaimChallenge, PairedDevice, PendingPairing, PendingPairingRequest,
    PendingPairingResult, PendingTranscriptDelta, TranscriptDeltaKind,
};
pub(crate) use self::push::{
    is_acceptable_push_endpoint, load_or_generate_vapid, vapid_key_path, PushAttentionTracker,
    PushDispatcher, PushJob, PushKind, PushSubscription, PushSubscriptionInput,
};
pub(crate) use self::runtime::ThreadRuntime;
pub(crate) use self::transcript::TranscriptRecord;

const REMOTE_ACTION_REPLAY_TTL_SECS: u64 = 600;
const MAX_REMOTE_ACTION_REPLAY_ENTRIES: usize = 512;
/// Backstop on remembered search routing hints. This grows with how much a user
/// searches, not with time, and the oldest hint is the least likely to be clicked next —
/// so a plain insertion-order FIFO is enough. Comfortably above `SEARCH_SCAN_LIMIT`'s
/// single-query yield, so one broad search cannot evict its own results.
const MAX_SEARCH_ROUTING_HINTS: usize = 2_000;
/// Backstop on retained review jobs so a long-lived relay can't accumulate every
/// recap/review body in memory. Terminal jobs otherwise persist until the user
/// deletes them (the Reviewer panel is a persistent surface), so this cap — not
/// a timer — is what eventually evicts old completed reviews.
const MAX_REVIEW_JOBS: usize = 64;
/// Backstop on retained workflow runs, mirroring `MAX_REVIEW_JOBS`: evict the
/// oldest TERMINAL runs first; non-terminal runs are never auto-evicted (they
/// have a live or restart-recoverable orchestrator).
#[allow(dead_code)]
const MAX_WORKFLOW_RUNS: usize = 64;
/// Per-parent cap on retained reviewer threads. Re-reviewing a parent with a clean
/// reviewer spawns a new hidden reviewer thread; once a parent has more than this,
/// the oldest is evicted (FIFO) and permanently deleted so reviewer threads can't
/// accumulate without bound.
pub(crate) const MAX_REVIEWERS_PER_PARENT: usize = 5;
/// Public alias for tests.
#[cfg(test)]
pub const MAX_REVIEW_JOBS_PUB: usize = MAX_REVIEW_JOBS;

/// Whether a thread's provider-reported status string means a turn is actively
/// in flight. This is a SECONDARY signal — `active_turn_id` is the authoritative
/// live-turn record (see `ThreadRuntime::is_working`); status only catches the
/// brief window before a turn id is surfaced.
///
/// NOT-working set: empty, `idle`, `viewing`, and the terminal/settled vocabulary
/// `completed` / `unknown`. The last two matter because providers don't agree on
/// an idle word: Claude's bridge hardcodes `idle`, but Codex passes through its
/// own `status.type` and a `thread/list` summary with no live status field parses
/// to `unknown` (see codex `parse_status`). Classifying those as "working" made a
/// saved-but-not-running Codex thread look busy forever — wrongly freezing the
/// "Request review" CTA and self-blocking the cwd-quiet check.
///
/// Deliberate trade-off: a Codex session driven by an EXTERNAL client (e.g. the
/// codex CLI) in the same cwd can also surface as `unknown` here, and we no longer
/// treat that as working — `active_turn_id` only covers relay-driven turns, so the
/// cwd mutation-race guard is best-effort for externally-driven sessions (v1
/// already cannot observe foreign turns; a worktree/snapshot mode is the real fix).
/// `notLoaded` belongs to the same class: Codex reports it for a saved thread
/// the app-server has not opened — the most idle state there is — and treating
/// it as working made every saved Codex thread refuse to fork ("a turn is in
/// progress") while Claude threads, which report `idle`, worked fine.
/// Comparison is case-insensitive because the word is provider formatting, not
/// semantics (Codex sends camelCase, the others lowercase).
pub(crate) fn thread_status_is_working(status: &str) -> bool {
    !matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "" | "idle" | "viewing" | "completed" | "unknown" | "notloaded"
    )
}

/// Whether relay-local state shows a turn in flight on `thread_id`, covering
/// background threads (their own runtime) as well as the selected/control
/// projection. Forking a thread mid-turn would branch from a transcript the
/// provider is still writing.
pub(crate) fn relay_thread_is_busy(relay: &RelayState, thread_id: &str) -> bool {
    relay
        .runtime_for_thread(thread_id)
        .is_some_and(|runtime| runtime.has_live_turn() || runtime.is_working())
        || (relay.active_thread_id.as_deref() == Some(thread_id)
            && relay.active_thread_has_live_turn())
}

/// Whether a status means the turn is DEFINITIVELY over — strictly stronger than
/// `!thread_status_is_working`. Used only by the two destructive turn-end sites
/// (clearing the progress phase, dropping orphaned approval / ask-user requests),
/// which must fire ONLY on a settled status, never on an indeterminate one.
///
/// `unknown` and `completed` are not-working (so they don't freeze the review CTA)
/// but they are NOT settled: `unknown` is "we can't tell" (a `thread/list` summary
/// or a malformed event), and dropping a genuinely-pending approval on an
/// indeterminate status would strand the turn. So those destructive sites keep the
/// original strict set — idle / viewing / empty — and leave pending requests intact
/// on `unknown` / `completed`, preserving the `set_thread_status` SAFETY CONTRACT.
fn thread_status_is_settled(status: &str) -> bool {
    matches!(status.trim(), "" | "idle" | "viewing")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct ThreadSessionSettings {
    pub(crate) approval_policy: String,
    pub(crate) sandbox: String,
    pub(crate) reasoning_effort: String,
    #[serde(default)]
    pub(crate) model: String,
}

impl ThreadSessionSettings {
    pub(crate) fn new(
        approval_policy: &str,
        sandbox: &str,
        reasoning_effort: &str,
        model: &str,
    ) -> Self {
        Self {
            approval_policy: approval_policy.to_string(),
            sandbox: sandbox.to_string(),
            reasoning_effort: reasoning_effort.to_string(),
            model: model.to_string(),
        }
    }
}

/// Durable identity of one reviewer thread: which parent it reviews and a strictly
/// increasing registration sequence. `seq` (not a wall-clock time) gives a reliable
/// FIFO order — even for reviewers registered in the same second — so the genuinely
/// oldest reviewer of a parent is the one evicted once the per-parent cap is hit.
/// The counter is restored as `max(seq) + 1` after a restart, so order survives.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ReviewerThread {
    pub(crate) parent_thread_id: String,
    #[serde(default)]
    pub(crate) seq: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct CachedRemoteActionResult {
    pub(crate) action_kind: String,
    pub(crate) ok: bool,
    pub(crate) snapshot: Option<SessionSnapshot>,
    pub(crate) receipt: Option<ApprovalReceipt>,
    pub(crate) ask_user_answer_receipt: Option<crate::protocol::AskUserAnswerReceipt>,
    pub(crate) providers: Option<Vec<String>>,
    pub(crate) models: Option<Vec<ModelOptionView>>,
    pub(crate) threads: Option<ThreadsResponse>,
    pub(crate) thread_entries: Option<ThreadEntriesResponse>,
    pub(crate) thread_entry_detail: Option<ThreadEntryDetailResponse>,
    pub(crate) thread_transcript: Option<ThreadTranscriptResponse>,
    pub(crate) workspace_diff: Option<crate::protocol::WorkspaceDiffResponse>,
    pub(crate) reviews: Option<crate::protocol::ReviewsResponse>,
    pub(crate) workflows: Option<crate::protocol::WorkflowsResponse>,
    pub(crate) devices: Option<crate::protocol::DevicesResponse>,
    pub(crate) projects: Option<crate::protocol::ProjectsResponse>,
    pub(crate) ask_user_question_detail: Option<crate::protocol::AskUserQuestionDetailResponse>,
    pub(crate) session_claim: Option<String>,
    pub(crate) session_claim_expires_at: Option<u64>,
    pub(crate) claim_challenge_id: Option<String>,
    pub(crate) claim_challenge: Option<String>,
    pub(crate) claim_challenge_expires_at: Option<u64>,
    pub(crate) response_secret: Option<String>,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) enum RemoteActionReplayDecision {
    Execute,
    Replay(CachedRemoteActionResult),
    InFlight,
}

#[derive(Debug, Clone)]
enum CachedRemoteActionState {
    InFlight {
        action_kind: String,
        seen_at: u64,
    },
    Completed {
        result: CachedRemoteActionResult,
        seen_at: u64,
    },
}

/// One surface's declared watch set, plus the device it belongs to.
///
/// The device id is kept because authorization and delivery are device-level: path
/// scope is a device grant, and the E2EE payload secret is per device. Identity is
/// per surface; permission is per device.
#[derive(Debug, Clone)]
pub(crate) struct WatchedSurface {
    pub(crate) device_id: String,
    pub(crate) thread_ids: HashSet<String>,
    /// Which connection generation owns this entry.
    ///
    /// A surface id is stable across reconnects (it identifies the TAB), so a refreshed
    /// page reuses it. Without a generation, the OLD connection's teardown — which can
    /// run after the new one has already declared — would delete the new connection's
    /// subscription, and the client's dedupe would then suppress re-declaring it.
    pub(crate) generation: u64,
}

pub struct RelayState {
    change_tx: watch::Sender<u64>,
    /// Live transcript appends for LOCAL SSE subscribers.
    ///
    /// Deliberately separate from `pending_broker_messages`: the broker publisher
    /// drains that queue with `mem::take`, so a second consumer would steal frames
    /// from it. A broadcast channel instead lets every open `/api/stream` connection
    /// see every delta, and a lagging subscriber drops old frames rather than
    /// stalling the relay — the snapshot that follows repairs any gap.
    delta_tx: broadcast::Sender<TranscriptDeltaEvent>,
    revision: u64,
    transcript_revision: u64,
    security: SecurityProfile,
    pub provider_connected: bool,
    pub provider_name: String,
    pub provider_connections: HashMap<String, bool>,
    pub broker_connected: bool,
    /// Whether a broker is configured for this relay lifetime (set once at startup;
    /// broker on/off is a restart, so this never changes at runtime). Transcript
    /// deltas are only ever drained by the broker publisher, so when this is false
    /// (local-only) they are dropped at enqueue instead of accumulating unbounded.
    pub broker_configured: bool,
    pub broker_channel_id: Option<String>,
    pub broker_peer_id: Option<String>,
    pub active_thread_id: Option<String>,
    pub active_controller_device_id: Option<String>,
    pub active_controller_last_seen_at: Option<u64>,
    pub active_turn_id: Option<String>,
    pub current_status: String,
    pub current_phase: Option<String>,
    pub current_tool: Option<String>,
    pub last_progress_at: Option<u64>,
    pub active_flags: Vec<String>,
    pub current_cwd: String,
    pub model: String,
    pub approval_policy: String,
    pub sandbox: String,
    pub reasoning_effort: String,
    pub(super) thread_settings: HashMap<String, ThreadSessionSettings>,
    /// Fork lineage: forked thread id -> the thread it branched from. Recorded
    /// at fork time because neither provider tracks the relationship, and
    /// retrofitting it once forked threads exist would need a migration.
    pub(super) thread_forked_from: HashMap<String, String>,
    /// Deferred-thread lineage: promoted (real) thread id -> the synthetic
    /// `claude-pending-…` id it grew out of at first send. Rides the snapshot
    /// as `active_thread_promoted_from` so EVERY client — including observers
    /// that never sent — can recognize the promotion authoritatively; the id
    /// sequence alone is indistinguishable from a normal thread switch.
    pub(super) thread_promoted_from: HashMap<String, String>,
    /// Static per relay process, seeded from the spawned bridges. Rides the
    /// snapshot so both surfaces learn fork capability through the channel they
    /// already consume, instead of inferring it from provider names.
    pub(super) provider_fork_capabilities: Vec<crate::protocol::ProviderForkCapabilityView>,
    /// Static per-provider identity + spawn outcome, one entry per configured
    /// provider (in configured order). Combined with `provider_connections` at
    /// snapshot time to derive the live `provider_status` panel — including
    /// providers that failed to launch, which never enter the providers map.
    pub(super) provider_status_base: Vec<crate::provider::ProviderStatusBase>,
    /// Honest "last real activity" timestamp per thread (unix secs), used as
    /// the thread-list sort/display key INSTEAD of the provider's raw
    /// `updated_at`. A no-prompt resume/selection spins up a live SDK session
    /// that rewrites the session file, bumping the provider's mtime-based
    /// `updated_at` to ~now — which would shove a thread to the top of the list
    /// on a mere click. This map advances only on signals that survive that:
    ///   • live in-relay activity — every per-thread transcript write
    ///     (`touch_thread_last_activity` via `bump_thread_transcript_revision`);
    ///   • on resume, the provider's reported last-activity time, folded in two
    ///     ways depending on `ProviderBridge::read_thread_reports_activity_time`:
    ///     Claude reports a transcript-derived (resume-safe) time → max-fold
    ///     (`observe_*`, which also heals unwitnessed CLI use); other providers
    ///     may report a bumpable mtime → freeze-first (`seed_*`) to avoid creep.
    /// Persisted so the ordering survives a relay restart.
    pub(super) thread_last_activity_at: HashMap<String, u64>,
    /// Persisted Projects (named session groupings), keyed by project id. Orthogonal
    /// to `allowed_roots`/`path_scope` (access-control) — grouping metadata only.
    pub(super) projects: HashMap<String, crate::protocol::ProjectView>,
    /// Session (thread) -> project id membership. Absent = "Unassigned".
    pub(super) thread_project_id: HashMap<String, String>,
    /// User-chosen session titles, keyed by thread id. Relay-owned and PERSISTED,
    /// because the provider's own title is not ours to write and not stable: Claude
    /// and Codex both re-derive a thread's name from its contents as the conversation
    /// grows, so a title the user picked would be silently overwritten mid-session.
    ///
    /// This map is an OVERRIDE, not a seed — once present it wins over the provider's
    /// name forever (see `apply_custom_thread_name`), and clearing the entry is the
    /// only way back to the auto-derived title. That is the entire point of the
    /// feature: a renamed tab must stop drifting.
    ///
    /// Absent = "use whatever the provider called it".
    pub(super) thread_custom_name: HashMap<String, String>,
    /// Monotonic cache key for the thread LIST channel; bumped only when a rename
    /// changes a session's title. Rides the snapshot (tiny); the list itself is fetched
    /// separately. In-memory only — a restart resets it to 0, so clients simply refetch
    /// once on the mismatch (harmless), same as `projects_revision`.
    pub(super) threads_revision: u64,
    /// Monotonic cache key for the dedicated Projects channel; bumped on every project
    /// mutation. Rides the snapshot (tiny); the full projects/membership payload is
    /// fetched on demand. In-memory only — a restart resets it to 0, so clients simply
    /// refetch once on the revision mismatch (harmless).
    pub(super) projects_revision: u64,
    pub allowed_roots: Vec<String>,
    pub available_models: Vec<ModelOptionView>,
    pub device_records: HashMap<String, DeviceRecord>,
    pub paired_devices: HashMap<String, PairedDevice>,
    online_surface_peer_ids: HashSet<String>,
    online_surface_peer_devices: HashMap<String, String>,
    /// Which threads each SURFACE is currently looking at, so transcript deltas are
    /// published only where they can be rendered.
    ///
    /// Keyed by surface (one browser tab / one broker peer), NOT by device. "What is on
    /// screen" is a property of a connection: two tabs of the same browser share one
    /// device id, so a per-device set would let whichever tab declared last silence the
    /// other. It also lets a surface be dropped precisely when ITS connection ends,
    /// instead of guessing from unrelated broker presence churn.
    ///
    /// Ephemeral — never persisted. A surface with no entry is not "watching nothing":
    /// it falls back to the active thread (see `device_watches_thread`), which is
    /// exactly the pre-subscription behavior for a client that never declares.
    watched_threads: HashMap<String, WatchedSurface>,
    /// Surface ids that are broker peer ids, so peer-presence pruning touches only
    /// those and never a local tab's subscription.
    broker_surface_ids: HashSet<String>,
    /// Current connection generation per surface id, so a stale connection's teardown
    /// cannot unsubscribe its own replacement.
    surface_generations: HashMap<String, u64>,
    pub pending_pairings: HashMap<String, PendingPairing>,
    pub pending_pairing_requests: HashMap<String, PendingPairingRequest>,
    pub completed_pairings: HashMap<String, CompletedPairing>,
    pub pending_claim_challenges: HashMap<String, ClaimChallenge>,
    pub pending_broker_messages: Vec<BrokerPendingMessage>,
    pub threads: Vec<ThreadSummaryView>,
    /// Provider routing for threads a SEARCH surfaced from beyond the normal page.
    ///
    /// This cannot live in `threads`: that vector is the nav-visible list and is
    /// wholesale REASSIGNED by every `list_threads` call, which the client re-polls every
    /// 12s. A hint parked there survives one poll, after which the row is still on the
    /// user's screen (they hold their own copy) but `find_thread_provider` can no longer
    /// place it — and its last-resort probe only reads the newest 200 per provider. The
    /// user clicks the session search just showed them and gets "not found on any
    /// provider". Keeping hints in their own map means the authoritative rewrite cannot
    /// erase them.
    ///
    /// Insertion-ordered and capped: this grows with what a user searches for, never
    /// with time, and the oldest hint is the least likely to be clicked next.
    search_routing_hints: HashMap<String, ThreadSummaryView>,
    search_routing_hint_order: VecDeque<String>,
    locally_deleted_thread_ids: HashSet<String>,
    pub pending_approvals: HashMap<String, PendingApproval>,
    pub pending_ask_user_questions: HashMap<String, PendingAskUserQuestion>,
    pub(super) runtimes: HashMap<String, ThreadRuntime>,
    pub(super) transcript: Vec<TranscriptRecord>,
    pub(super) logs: Vec<LogEntryView>,
    /// In-memory file-change apply state keyed by transcript `item_id`
    /// (typically `turn-diff:<turn_id>`). Never persisted: lost on relay
    /// restart, which resets entries to the default "applied" state.
    pub(super) apply_states: HashMap<String, FileChangeApplyState>,
    recent_remote_actions: HashMap<String, CachedRemoteActionState>,
    /// Relay-owned cross-agent review jobs, keyed by job id. TERMINAL jobs are
    /// persisted whole — including their recap/review text — so the Reviewer panel's
    /// completed cards survive a restart WITH their content, even if the reviewer's
    /// provider session is later pruned (see `PersistedRelayState`). The workspace diff
    /// itself is not stored (only a generated-at marker), and the set is bounded by
    /// `MAX_REVIEW_JOBS`, so the state file stays modest. In-progress jobs are NOT
    /// persisted (their orchestrator dies with the process). `pub(super)` so the
    /// persistence writer can read it.
    pub(super) review_jobs: HashMap<String, ReviewJob>,
    /// Durable identity of reviewer threads: reviewer_thread_id -> parent_thread_id.
    /// This is the *persisted* source of truth for nav-hiding (so reviewer threads
    /// stay hidden across a relay restart and across review-job eviction). An entry
    /// stays until the reviewer thread is actually deleted or explicitly un-hidden
    /// (e.g. the user kept it when deleting its parent). Distinct from
    /// `is_thread_review_locked` (live freeze), which remains in-memory.
    pub(super) reviewer_threads: HashMap<String, ReviewerThread>,
    /// Next reviewer-thread registration sequence (monotonic FIFO order). Restored as
    /// `max(seq) + 1` after a restart so eviction order survives. In-memory only.
    reviewer_thread_seq: u64,
    /// Relay-owned workflow runs, keyed by run id. Unlike `review_jobs`
    /// (terminal-only), NON-terminal runs persist too: a run must survive a restart
    /// so its card can offer "re-run from the last completed step". The restore side
    /// reconciles any non-terminal run to the terminal `Interrupted` state (no
    /// orchestrator survives a restart). `pub(super)` so the persistence writer reads it.
    pub(super) workflow_jobs: HashMap<String, WorkflowRun>,
    /// Relay-owned task-list runs, keyed by run id. A `TaskListRun` drives a
    /// sequence of child Code Flow `WorkflowRun`s (one per task). Like
    /// `workflow_jobs`, NON-terminal runs persist so a restart can reconcile a
    /// stranded list to `Interrupted` and offer re-run from the last completed task.
    /// `pub(super)` so the persistence writer reads it.
    pub(super) task_list_jobs: HashMap<String, TaskListRun>,
    /// Web Push subscriptions for remote devices, keyed by `device_id` (a device
    /// can have several browser subscriptions; deduped by endpoint). Persisted so
    /// a closed/locked phone keeps receiving pushes across a relay restart.
    pub(super) push_subscriptions: HashMap<String, Vec<PushSubscription>>,
    /// Sender into the push dispatcher task. State mutations only enqueue here
    /// (non-blocking, lock-safe); all network IO happens off the lock in the
    /// dispatcher. `None` in tests and before the dispatcher is wired.
    push_tx: Option<mpsc::UnboundedSender<PushJob>>,
    /// VAPID public key (base64url, uncompressed P-256 point) surfaced to clients
    /// as `applicationServerKey`. `None` until the dispatcher is wired.
    push_vapid_public_key: Option<String>,
    /// Server-side port of `thread-attention.js`: diffs the published snapshot
    /// stream to fire push notifications on needs_input / completed transitions
    /// even when the remote app is closed. In-memory only.
    push_attention: PushAttentionTracker,
}

impl RelayState {
    pub fn new(
        current_cwd: String,
        change_tx: watch::Sender<u64>,
        security: SecurityProfile,
    ) -> Self {
        // Bounded: a subscriber that falls this far behind gets a Lagged error and
        // resyncs from the next snapshot, which is strictly better than letting one
        // slow SSE reader pin delta history in memory.
        let (delta_tx, _) = broadcast::channel(1024);
        let mut state = Self {
            change_tx,
            delta_tx,
            revision: 0,
            transcript_revision: 0,
            security,
            provider_connected: false,
            provider_name: String::new(),
            provider_connections: HashMap::new(),
            broker_connected: false,
            broker_configured: false,
            broker_channel_id: None,
            broker_peer_id: None,
            active_thread_id: None,
            active_controller_device_id: None,
            active_controller_last_seen_at: None,
            active_turn_id: None,
            current_status: "idle".to_string(),
            current_phase: None,
            current_tool: None,
            last_progress_at: None,
            active_flags: Vec::new(),
            current_cwd,
            model: DEFAULT_MODEL.to_string(),
            approval_policy: DEFAULT_APPROVAL_POLICY.to_string(),
            sandbox: DEFAULT_SANDBOX.to_string(),
            reasoning_effort: DEFAULT_EFFORT.to_string(),
            thread_settings: HashMap::new(),
            thread_forked_from: HashMap::new(),
            thread_promoted_from: HashMap::new(),
            provider_fork_capabilities: Vec::new(),
            provider_status_base: Vec::new(),
            thread_last_activity_at: HashMap::new(),
            projects: HashMap::new(),
            thread_project_id: HashMap::new(),
            thread_custom_name: HashMap::new(),
            threads_revision: 0,
            projects_revision: 0,
            allowed_roots: Vec::new(),
            available_models: Vec::new(),
            device_records: HashMap::new(),
            paired_devices: HashMap::new(),
            online_surface_peer_ids: HashSet::new(),
            online_surface_peer_devices: HashMap::new(),
            watched_threads: HashMap::new(),
            broker_surface_ids: HashSet::new(),
            surface_generations: HashMap::new(),
            pending_pairings: HashMap::new(),
            pending_pairing_requests: HashMap::new(),
            completed_pairings: HashMap::new(),
            pending_claim_challenges: HashMap::new(),
            pending_broker_messages: Vec::new(),
            threads: Vec::new(),
            search_routing_hints: HashMap::new(),
            search_routing_hint_order: VecDeque::new(),
            locally_deleted_thread_ids: HashSet::new(),
            pending_approvals: HashMap::new(),
            pending_ask_user_questions: HashMap::new(),
            runtimes: HashMap::new(),
            transcript: Vec::new(),
            logs: Vec::new(),
            apply_states: HashMap::new(),
            recent_remote_actions: HashMap::new(),
            review_jobs: HashMap::new(),
            reviewer_threads: HashMap::new(),
            reviewer_thread_seq: 0,
            workflow_jobs: HashMap::new(),
            task_list_jobs: HashMap::new(),
            push_subscriptions: HashMap::new(),
            push_tx: None,
            push_vapid_public_key: None,
            push_attention: PushAttentionTracker::new(),
        };
        state.push_log("info", "Relay booted. Waiting for Codex app-server.");
        state
    }

    pub fn notify(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        // `send` REFUSES to store the value when no receiver is alive, which would leave
        // the channel advertising a stale revision. The local snapshot cache keys off
        // that value, so a dropped-to-zero receiver count would pin every surface to the
        // last snapshot built while someone happened to be listening. `send_replace`
        // always stores; notifying nobody is fine, forgetting the revision is not.
        let _ = self.change_tx.send_replace(self.revision);
    }

    /// Subscribe to live transcript appends (local SSE surfaces).
    pub fn subscribe_transcript_deltas(&self) -> broadcast::Receiver<TranscriptDeltaEvent> {
        self.delta_tx.subscribe()
    }

    /// Fan a delta out to local SSE subscribers. `send` fails only when nobody is
    /// subscribed, which is the common case for a headless relay — not an error.
    fn emit_local_transcript_delta(&self, delta: &PendingTranscriptDelta) {
        let _ = self.delta_tx.send(TranscriptDeltaEvent {
            thread_id: delta.thread_id.clone(),
            base_revision: delta.base_revision,
            revision: delta.revision,
            entry_seq: delta.entry_seq,
            server_time: delta.server_time,
            item_id: delta.item_id.clone(),
            turn_id: delta.turn_id.clone(),
            delta: delta.delta.clone(),
            delta_kind: match delta.kind {
                TranscriptDeltaKind::AgentText => "agent_text".to_string(),
                TranscriptDeltaKind::CommandOutput => "command_output".to_string(),
            },
            text_offset: delta.text_offset,
        });
    }

    // --- Web Push --------------------------------------------------------

    /// Install the dispatcher sender + VAPID public key (production wiring only;
    /// tests leave these unset so no dispatcher is required).
    pub(crate) fn set_push_runtime(
        &mut self,
        tx: mpsc::UnboundedSender<PushJob>,
        vapid_public_key: String,
    ) {
        self.push_tx = Some(tx);
        self.push_vapid_public_key = Some(vapid_public_key);
    }

    /// Enqueue a push job (best-effort; no-op when the dispatcher isn't wired).
    pub(crate) fn enqueue_push(&self, job: PushJob) {
        if let Some(tx) = &self.push_tx {
            let _ = tx.send(job);
        }
    }

    /// Register/replace a remote device's push subscription. The device must be
    /// paired; subscriptions are deduped by endpoint.
    pub(crate) fn register_push_subscription(
        &mut self,
        input: PushSubscriptionInput,
    ) -> Result<(), String> {
        let device_id = input
            .device_id
            .clone()
            .ok_or_else(|| "push subscription is missing a device id".to_string())?;
        if !self.paired_devices.contains_key(&device_id) {
            return Err("device is not paired".to_string());
        }
        if input.endpoint.is_empty() || input.keys.p256dh.is_empty() || input.keys.auth.is_empty() {
            return Err("push subscription is incomplete".to_string());
        }
        if !is_acceptable_push_endpoint(&input.endpoint) {
            return Err("push endpoint must be a public https URL".to_string());
        }
        // Idempotent no-op when this exact subscription is already stored. The
        // client re-asserts its subscription on every load (the register action is
        // fire-and-forget and can be lost in transit), so this keeps that reconcile
        // free of spurious re-inserts / notify() broadcasts. A rotated key on the
        // same endpoint differs here, so it still updates below.
        if let Some(existing) = self.push_subscriptions.get(&device_id) {
            if existing.iter().any(|s| {
                s.endpoint == input.endpoint
                    && s.p256dh == input.keys.p256dh
                    && s.auth == input.keys.auth
            }) {
                return Ok(());
            }
        }
        let subscription = PushSubscription {
            endpoint: input.endpoint,
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
            device_id: device_id.clone(),
            created_at: unix_now(),
        };
        let entry = self.push_subscriptions.entry(device_id).or_default();
        entry.retain(|existing| existing.endpoint != subscription.endpoint);
        entry.push(subscription);
        self.notify();
        Ok(())
    }

    /// Remove a subscription by endpoint, scoped to the owning device so one
    /// paired device cannot unregister another device's subscription.
    pub(crate) fn unregister_push_subscription(&mut self, device_id: &str, endpoint: &str) {
        let Some(subs) = self.push_subscriptions.get_mut(device_id) else {
            return;
        };
        let before = subs.len();
        subs.retain(|s| s.endpoint != endpoint);
        let changed = subs.len() != before;
        if subs.is_empty() {
            self.push_subscriptions.remove(device_id);
        }
        if changed {
            self.notify();
        }
    }

    /// Drop subscriptions a push service reported as gone (404/410). Does not
    /// `notify()` — the dispatcher does that once after pruning.
    pub(crate) fn prune_push_subscriptions(&mut self, gone_endpoints: &[String]) {
        if gone_endpoints.is_empty() {
            return;
        }
        self.push_subscriptions.retain(|_, subs| {
            subs.retain(|s| !gone_endpoints.iter().any(|e| e == &s.endpoint));
            !subs.is_empty()
        });
    }

    /// Whether a device is currently paired (gates push delivery).
    pub(crate) fn is_device_paired(&self, device_id: &str) -> bool {
        self.paired_devices.contains_key(device_id)
    }

    /// Drop any push subscription whose device is no longer paired — e.g. a stale
    /// entry restored from a state file written before revoke-time pruning existed.
    pub(crate) fn prune_orphaned_push_subscriptions(&mut self) {
        let paired: HashSet<String> = self.paired_devices.keys().cloned().collect();
        self.push_subscriptions
            .retain(|device_id, _| paired.contains(device_id));
    }

    /// Flattened snapshot of every stored subscription for a CURRENTLY-PAIRED
    /// device (for the dispatcher). Orphaned subscriptions — a revoked device, or a
    /// stale entry restored from an old state file — are excluded so the dispatcher
    /// never sends to an unpaired device.
    pub(crate) fn push_subscriptions_vec(&self) -> Vec<PushSubscription> {
        self.push_subscriptions
            .iter()
            .filter(|(device_id, _)| self.paired_devices.contains_key(device_id.as_str()))
            .flat_map(|(_, subs)| subs.iter().cloned())
            .collect()
    }

    /// Best-effort human label for a thread, for push notification copy.
    fn thread_display_name(&self, thread_id: &str) -> Option<String> {
        self.threads
            .iter()
            .find(|t| t.id == thread_id)
            .and_then(|t| {
                t.name
                    .as_ref()
                    .map(|name| name.trim().to_string())
                    .filter(|name| !name.is_empty())
            })
    }

    /// Feed the published snapshot to the attention tracker and enqueue any
    /// needs_input / completed transitions. Called once per state change by a
    /// dedicated background task (see `spawn_push_attention_task`).
    pub(crate) fn note_snapshot_for_push(&mut self, snapshot: &SessionSnapshot) {
        if self.push_tx.is_none() {
            return;
        }
        let jobs = self.push_attention.ingest(snapshot);
        for mut job in jobs {
            job.thread_name = self.thread_display_name(&job.thread_id);
            self.enqueue_push(job);
        }
    }

    /// Notify that an error ended a thread's turn. Suppresses the work→idle
    /// "completed" the tracker would otherwise emit for the same edge, then
    /// enqueues an explicit error push.
    pub(crate) fn enqueue_error_push(&mut self, thread_id: &str, reason: impl Into<String>) {
        if self.push_tx.is_none() {
            return;
        }
        self.push_attention.suppress_completed(thread_id);
        let name = self.thread_display_name(thread_id);
        let job = PushJob::new(PushKind::Error, thread_id)
            .with_name(name)
            .with_reason(reason);
        self.enqueue_push(job);
    }

    pub(super) fn bump_transcript_revision(&mut self) -> (u64, u64) {
        let Some(thread_id) = self.active_thread_id.clone() else {
            let base_revision = self.transcript_revision;
            self.transcript_revision = self.transcript_revision.wrapping_add(1);
            return (base_revision, self.transcript_revision);
        };

        self.bump_thread_transcript_revision(&thread_id)
    }

    pub(super) fn bump_thread_transcript_revision(&mut self, thread_id: &str) -> (u64, u64) {
        // Every per-thread transcript mutation (agent message start/deltas,
        // tool calls, user messages, turn-completion status, file-change apply)
        // funnels through here, so this is the one place to record genuine
        // activity for the honest sort key. Resume's bulk history load rebuilds
        // the runtime via `ThreadRuntime::from_sync_data`/`merge_fresh_history`
        // and never calls this, so a mere session selection won't reorder.
        self.touch_thread_last_activity(thread_id);
        let runtime = self.ensure_runtime_for_thread(thread_id);
        let base_revision = runtime.transcript_revision;
        runtime.transcript_revision = runtime.transcript_revision.wrapping_add(1);
        let revision = runtime.transcript_revision;
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.transcript_revision = revision;
        }
        (base_revision, revision)
    }

    pub(crate) fn selected_runtime(&self) -> Option<&ThreadRuntime> {
        self.active_thread_id
            .as_deref()
            .and_then(|thread_id| self.runtimes.get(thread_id))
    }

    pub(crate) fn runtime_for_thread(&self, thread_id: &str) -> Option<&ThreadRuntime> {
        self.runtimes.get(thread_id)
    }

    pub(crate) fn thread_turn_revision(&self, thread_id: &str) -> u64 {
        self.runtime_for_thread(thread_id)
            .map(|runtime| runtime.turn_revision)
            .unwrap_or(0)
    }

    /// True if any thread runtime (e.g. a backgrounded thread) is still working in
    /// `cwd`. A review reads the live working tree, so a concurrent turn in the
    /// same workspace could mutate files mid-review; v1 refuses rather than racing.
    pub(crate) fn has_working_thread_in_cwd(&self, cwd: &str) -> bool {
        let reviewers = self.reviewer_thread_ids();
        self.runtimes.iter().any(|(thread_id, runtime)| {
            runtime.current_cwd == cwd
                && runtime.is_working()
                // Reviewer threads are read-only background threads — they can't mutate the
                // workspace, so a running review must never gate a NEW review request.
                && !reviewers.contains(thread_id)
                // A locally-deleted thread is gone. A stray late event can resurrect its
                // runtime (the delete tombstone is enforced on the thread list, not the
                // runtime map), so a deleted thread must not keep blocking reviews.
                && !self.locally_deleted_thread_ids.contains(thread_id)
        })
    }

    /// The workspace cwd for an arbitrary thread (not just the active one): its live
    /// runtime's `current_cwd`, falling back to the cached thread row. Used to scope a
    /// review at the NAMED parent thread's workspace instead of the active thread's.
    /// `None` when the thread can't be resolved (so the caller can reject the request).
    pub(crate) fn thread_cwd(&self, thread_id: &str) -> Option<String> {
        self.runtime_for_thread(thread_id)
            .map(|runtime| runtime.current_cwd.clone())
            .filter(|cwd| !cwd.is_empty())
            .or_else(|| {
                self.threads
                    .iter()
                    .find(|thread| thread.id == thread_id)
                    .map(|thread| thread.cwd.clone())
                    .filter(|cwd| !cwd.is_empty())
            })
    }

    /// The project a thread belongs to, if any (`None` = "Unassigned").
    pub(crate) fn project_for_thread(
        &self,
        thread_id: &str,
    ) -> Option<&crate::protocol::ProjectView> {
        let project_id = self.thread_project_id.get(thread_id)?;
        self.projects.get(project_id)
    }

    /// All projects as a stable (name, then id) sorted list for clients.
    pub(crate) fn projects_view(&self) -> Vec<crate::protocol::ProjectView> {
        let mut projects: Vec<_> = self.projects.values().cloned().collect();
        projects.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
        projects
    }

    /// Create a new (empty) project with a caller-chosen id.
    pub(super) fn create_project(
        &mut self,
        id: String,
        name: String,
    ) -> crate::protocol::ProjectView {
        let project = crate::protocol::ProjectView {
            id: id.clone(),
            name,
            instructions: None,
        };
        self.projects.insert(id, project.clone());
        project
    }

    pub(super) fn rename_project(&mut self, project_id: &str, name: String) -> Result<(), String> {
        let project = self
            .projects
            .get_mut(project_id)
            .ok_or_else(|| format!("project `{project_id}` not found"))?;
        project.name = name;
        Ok(())
    }

    /// Delete a project; its member sessions fall back to "Unassigned".
    pub(super) fn delete_project(&mut self, project_id: &str) -> Result<(), String> {
        if self.projects.remove(project_id).is_none() {
            return Err(format!("project `{project_id}` not found"));
        }
        self.thread_project_id.retain(|_, pid| pid != project_id);
        Ok(())
    }

    /// Move a session into a project (replaces any prior membership). Rejects
    /// reviewer-owned threads (they're hidden, review-scoped, not user sessions);
    /// an ordinary session id that isn't loaded into the thread list is still
    /// assignable on purpose — membership is metadata, not gated on load state.
    pub(super) fn assign_thread_to_project(
        &mut self,
        thread_id: &str,
        project_id: &str,
    ) -> Result<(), String> {
        if !self.projects.contains_key(project_id) {
            return Err(format!("project `{project_id}` not found"));
        }
        if self.reviewer_thread_ids().contains(thread_id) {
            return Err(format!(
                "`{thread_id}` is a reviewer thread and cannot be assigned to a project"
            ));
        }
        self.thread_project_id
            .insert(thread_id.to_string(), project_id.to_string());
        Ok(())
    }

    /// Move a session out of its project → "Unassigned". Returns whether it changed.
    pub(super) fn unassign_thread_from_project(&mut self, thread_id: &str) -> bool {
        self.thread_project_id.remove(thread_id).is_some()
    }

    /// Bump the Projects cache key. Call after any project mutation so clients know
    /// to refetch the dedicated payload.
    pub(super) fn bump_projects_revision(&mut self) {
        self.projects_revision = self.projects_revision.wrapping_add(1);
    }

    /// Set (`Some`) or clear (`None`) a session's user-chosen title. Returns whether
    /// anything actually changed, so the caller can skip the revision bump / notify on
    /// a no-op rename (re-submitting the same name from a stale UI).
    ///
    /// The caller is responsible for trimming/validating the name — `AppState::rename_thread`
    /// owns the bounds, exactly as `project_action` owns `validate_project_name`.
    pub(super) fn set_thread_custom_name(&mut self, thread_id: &str, name: Option<String>) -> bool {
        let changed = match name {
            Some(name) => self
                .thread_custom_name
                .insert(thread_id.to_string(), name.clone())
                .is_none_or(|previous| previous != name),
            None => self.thread_custom_name.remove(thread_id).is_some(),
        };
        if changed {
            // The routing/display cache holds already-rendered rows. Re-overlay this
            // thread's now so the very next `relay.threads` read agrees with the map,
            // instead of waiting for the next provider list to refresh it.
            self.refresh_custom_thread_name(thread_id);
            // Tell every OTHER client the list it is holding is stale. Their next
            // snapshot carries the new revision and they refetch — this is what makes a
            // rename on the phone land on the desktop tab strip in ~a second instead of
            // whenever the 12s thread poll next fires.
            self.threads_revision = self.threads_revision.wrapping_add(1);
        }
        changed
    }

    /// Whether this thread was PERMANENTLY deleted while the relay was up.
    ///
    /// Deletion tombstones outlive the thread row, so a stale client can still name a
    /// thread that is gone. Metadata writes must consult this or they resurrect a
    /// persisted entry for a session nothing will ever clean up again.
    pub(crate) fn thread_is_locally_deleted(&self, thread_id: &str) -> bool {
        self.locally_deleted_thread_ids.contains(thread_id)
    }

    /// A session's user-chosen title, if it has one.
    pub(crate) fn thread_custom_name(&self, thread_id: &str) -> Option<String> {
        self.thread_custom_name.get(thread_id).cloned()
    }

    /// Resolve a thread id a CLIENT supplied to the id the relay actually keys state by.
    ///
    /// A Claude session lives under a synthetic `claude-pending-…` id until its first
    /// send promotes it to a real SDK id. Clients learn about that promotion from the
    /// snapshot, so between the promotion and the client processing it, a client can
    /// legitimately act on the pending id. A write that keyed off it verbatim would land
    /// on a dead key: invisible to every reader, and — for a PERSISTED map — orphaned
    /// forever, because the pending id is never seen by any cleanup path.
    ///
    /// `thread_promoted_from` is real_id -> pending_id, so this scans it. The map is
    /// small (one entry per promoted Claude session this process has seen) and this runs
    /// only on an explicit user action, never in a hot path.
    pub(crate) fn resolve_promoted_thread_id(&self, thread_id: &str) -> String {
        if !thread_id.starts_with("claude-pending-") {
            return thread_id.to_string();
        }
        self.thread_promoted_from
            .iter()
            .find(|(_, pending_id)| pending_id.as_str() == thread_id)
            .map(|(real_id, _)| real_id.clone())
            .unwrap_or_else(|| thread_id.to_string())
    }

    /// How many sessions currently carry a user-chosen title (the persisted map's size,
    /// for the caller's entry-count bound).
    pub(crate) fn custom_thread_name_count(&self) -> usize {
        self.thread_custom_name.len()
    }

    /// Overlay the user's chosen title onto a provider-supplied summary. THE override
    /// point: the custom name always wins, because the provider re-derives its own
    /// title as the conversation grows and would otherwise clobber the user's choice
    /// on the next list refresh.
    pub(crate) fn apply_custom_thread_name(&self, thread: &mut ThreadSummaryView) {
        // Always stamp `renamed`, including the false case: these rows are rebuilt from
        // the providers, so leaving a stale `true` would tell the client a session is
        // still renamed after it was reset.
        match self.thread_custom_name.get(&thread.id) {
            Some(name) => {
                thread.name = Some(name.clone());
                thread.renamed = true;
            }
            None => thread.renamed = false,
        }
    }

    /// Remember how to route a thread a search surfaced from beyond the normal page.
    ///
    /// Called only from the search path. See the field's doc for why this is not simply
    /// pushed into `threads`.
    pub(super) fn remember_search_routing_hint(&mut self, thread: &ThreadSummaryView) {
        if thread.id.is_empty() {
            return;
        }
        if self
            .search_routing_hints
            .insert(thread.id.clone(), thread.clone())
            .is_none()
        {
            self.search_routing_hint_order.push_back(thread.id.clone());
        }
        while self.search_routing_hint_order.len() > MAX_SEARCH_ROUTING_HINTS {
            if let Some(evicted) = self.search_routing_hint_order.pop_front() {
                self.search_routing_hints.remove(&evicted);
            }
        }
    }

    /// Routing hint for a searched thread, if we still hold one.
    pub(super) fn search_routing_hint(&self, thread_id: &str) -> Option<&ThreadSummaryView> {
        self.search_routing_hints.get(thread_id)
    }

    /// Drop a hint when the thread goes away, so an archived/deleted id cannot be routed
    /// back to life by a stale search result.
    pub(super) fn forget_search_routing_hint(&mut self, thread_id: &str) {
        if self.search_routing_hints.remove(thread_id).is_some() {
            self.search_routing_hint_order.retain(|id| id != thread_id);
        }
    }

    /// Re-apply the override across the cached rows (`threads` + per-thread runtime
    /// summaries) for ONE thread, right after its override changed. Those rows were
    /// built from an older provider list, so without this they keep the previous title
    /// until the next list refresh or provider event.
    ///
    /// Clearing is the asymmetric case and the reason this takes the id. The overlay is
    /// destructive — installing an override overwrites the provider's own title in the
    /// cached row, and the relay keeps no shadow copy of it — so on a RESET there is
    /// nothing to restore and leaving `name` alone would keep showing the title the
    /// user just removed. `None` is the honest answer ("we no longer know what the
    /// agent calls it"): the authoritative `list_threads` rebuilds from the provider
    /// and re-overlays anyway, and `upsert_thread`'s merge refills the cache from the
    /// next provider event.
    fn refresh_custom_thread_name(&mut self, thread_id: &str) {
        let name = self.thread_custom_name.get(thread_id).cloned();
        let overlay = |thread: &mut ThreadSummaryView| {
            thread.renamed = name.is_some();
            thread.name = name.clone();
        };
        for thread in self.threads.iter_mut().filter(|row| row.id == thread_id) {
            overlay(thread);
        }
        if let Some(summary) = self
            .runtimes
            .get_mut(thread_id)
            .and_then(|runtime| runtime.summary.as_mut())
        {
            overlay(summary);
        }
    }

    /// The full, uncompacted Projects payload for the dedicated fetch channel.
    pub(crate) fn projects_response(&self) -> crate::protocol::ProjectsResponse {
        crate::protocol::ProjectsResponse {
            projects_revision: self.projects_revision,
            projects: self.projects_view(),
            thread_project_id: self.thread_project_id.clone(),
        }
    }

    /// Whether the ACTIVE thread's agent is mid-turn per its provider-reported
    /// status. Semantic mirror of the frontend `canRequestReview` gate: callers
    /// that need a "is the agent busy right now" check must use this, NOT a literal
    /// `current_status == "idle"` test, so providers that report a non-`idle` settled
    /// status (Codex's `unknown` / `completed`) aren't treated as busy.
    #[allow(dead_code)]
    pub(crate) fn active_agent_is_working(&self) -> bool {
        self.selected_runtime()
            .map(ThreadRuntime::is_working)
            .unwrap_or_else(|| thread_status_is_working(&self.current_status))
    }

    pub(crate) fn active_thread_has_live_turn(&self) -> bool {
        self.selected_runtime()
            .map(ThreadRuntime::has_live_turn)
            .unwrap_or_else(|| self.active_turn_id.is_some())
    }

    pub(crate) fn expire_stale_turn_liveness(&mut self, now: u64) -> Vec<String> {
        let mut expired = Vec::new();
        for (thread_id, runtime) in &mut self.runtimes {
            if runtime.expire_stale_liveness(now, STALE_TURN_PROGRESS_TIMEOUT_SECS) {
                expired.push(thread_id.clone());
            }
        }
        if !expired.is_empty() {
            self.sync_selected_runtime_to_fields();
            for thread_id in &expired {
                self.enqueue_error_push(
                    thread_id,
                    "stalled with no progress; the turn was stopped.",
                );
            }
        }
        expired
    }

    pub(crate) fn stale_turn_stop_candidates(&self) -> Vec<(String, String)> {
        self.runtimes
            .iter()
            .filter_map(|(thread_id, runtime)| {
                (runtime.liveness_timed_out && !runtime.liveness_stop_requested)
                    .then(|| {
                        runtime
                            .active_turn_id
                            .as_ref()
                            .map(|turn_id| (thread_id.clone(), turn_id.clone()))
                    })
                    .flatten()
            })
            .collect()
    }

    pub(crate) fn mark_stale_turn_stop_requested(&mut self, thread_id: &str, turn_id: &str) {
        let Some(runtime) = self.runtimes.get_mut(thread_id) else {
            return;
        };
        if runtime.liveness_timed_out && runtime.active_turn_id.as_deref() == Some(turn_id) {
            runtime.liveness_stop_requested = true;
        }
    }

    pub(crate) fn insert_review_job(&mut self, job: ReviewJob) {
        self.prune_review_jobs();
        self.review_jobs.insert(job.id.clone(), job);
    }

    pub(crate) fn remove_review_job(&mut self, id: &str) -> Option<ReviewJob> {
        self.review_jobs.remove(id)
    }

    /// Drop any review jobs whose reviewer thread is `reviewer_id` — called when
    /// that reviewer thread is deleted or promoted to a normal thread, so the
    /// Reviewer panel can't show a stale card pointing at it.
    pub(crate) fn drop_review_jobs_for_reviewer(&mut self, reviewer_id: &str) {
        self.review_jobs
            .retain(|_, job| job.reviewer_thread_id.as_deref() != Some(reviewer_id));
    }

    /// Drop terminal workflow cards whose owned reviewer thread was deleted or
    /// promoted to a normal thread. Non-terminal workflow runs are protected by
    /// `reviewers_to_evict` and by the workflow lock guards.
    pub(crate) fn drop_workflow_runs_for_reviewer(&mut self, reviewer_id: &str) {
        self.workflow_jobs.retain(|_, run| {
            !run.status.is_terminal()
                || !run
                    .step_threads
                    .values()
                    .any(|owned_thread_id| owned_thread_id == reviewer_id)
        });
    }

    /// Drop only the TERMINAL review jobs for `reviewer_id`. Used by `delete_review`,
    /// which collapses a reviewer's finished run-cards but must NOT delete a
    /// concurrently-started in-progress job for the same reviewer (created in the window
    /// between the delete's terminality check and this write) — doing so would orphan
    /// that run's orchestrator and unlock its threads mid-turn.
    pub(crate) fn drop_terminal_review_jobs_for_reviewer(&mut self, reviewer_id: &str) {
        self.review_jobs.retain(|_, job| {
            !(job.reviewer_thread_id.as_deref() == Some(reviewer_id) && job.status.is_terminal())
        });
    }

    /// Thread ids that are reviewer threads. The thread list filters these out so a
    /// reviewer never shows up as a peer session — it is owned by its review
    /// (surfaced through the Reviewer panel). Backed by the DURABLE `reviewer_threads`
    /// map (persisted), so hiding survives a relay restart and review-job eviction.
    /// Unioned with live `review_jobs` reviewer ids for safety (the map is populated
    /// atomically with thread registration, so this union is belt-and-suspenders).
    pub(crate) fn reviewer_thread_ids(&self) -> HashSet<String> {
        self.reviewer_threads
            .keys()
            .cloned()
            .chain(
                self.review_jobs
                    .values()
                    .filter_map(|job| job.reviewer_thread_id.clone()),
            )
            .chain(
                // Workflow reviewer threads are OWNED by their run (not the review
                // map), so review's per-parent FIFO eviction can never delete them.
                // Hide them by deriving from each run's step_threads.
                self.workflow_jobs
                    .values()
                    .flat_map(|run| run.step_threads.values().cloned()),
            )
            .collect()
    }

    /// Persistently record a reviewer thread's identity (reviewer id -> parent id),
    /// so it stays hidden from navigation across restarts and job eviction. Assigns a
    /// strictly increasing `seq` for FIFO eviction ordering.
    pub(crate) fn register_reviewer_thread(&mut self, reviewer_id: String, parent_id: String) {
        let seq = self.reviewer_thread_seq;
        self.reviewer_thread_seq += 1;
        self.reviewer_threads.insert(
            reviewer_id,
            ReviewerThread {
                parent_thread_id: parent_id,
                seq,
            },
        );
    }

    /// Stop hiding a reviewer thread — either because it was actually deleted, or
    /// because the user chose to keep it as a normal (visible) thread when deleting
    /// its parent. Returns the parent id it was associated with, if any.
    pub(crate) fn forget_reviewer_thread(&mut self, reviewer_id: &str) -> Option<String> {
        self.reviewer_threads
            .remove(reviewer_id)
            .map(|record| record.parent_thread_id)
    }

    /// After restoring `reviewer_threads` from a snapshot, resume the registration
    /// counter past the largest restored `seq`, so newly registered reviewers always
    /// sort after the restored ones (FIFO order survives a restart).
    fn recompute_reviewer_thread_seq(&mut self) {
        self.reviewer_thread_seq = self
            .reviewer_threads
            .values()
            .map(|record| record.seq)
            .max()
            .map_or(0, |max| max + 1);
    }

    /// Reviewer thread ids owned by `parent_id` (for the parent-delete prompt).
    pub(crate) fn reviewer_threads_of_parent(&self, parent_id: &str) -> Vec<String> {
        self.reviewer_threads
            .iter()
            .filter(|(_, record)| record.parent_thread_id == parent_id)
            .map(|(reviewer, _)| reviewer.clone())
            .collect()
    }

    /// Reviewer threads of `parent_id` to evict so it keeps at most `keep`: the
    /// oldest by registration `seq` beyond the cap, FIFO. Reviewers currently bound
    /// to a non-terminal review/workflow job are protected (never evicted mid-turn).
    /// Returns ids only; the caller performs the actual provider delete.
    pub(crate) fn reviewers_to_evict(&self, parent_id: &str, keep: usize) -> Vec<String> {
        let mut owned: Vec<(&String, u64)> = self
            .reviewer_threads
            .iter()
            .filter(|(_, record)| record.parent_thread_id == parent_id)
            .map(|(reviewer, record)| (reviewer, record.seq))
            .collect();
        if owned.len() <= keep {
            return Vec::new();
        }
        // Oldest first (seq is unique; id is a defensive tiebreak only).
        owned.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(b.0)));
        let protected: HashSet<String> = self
            .review_jobs
            .values()
            .filter(|job| !job.status.is_terminal())
            .filter_map(|job| job.reviewer_thread_id.clone())
            .chain(
                self.workflow_jobs
                    .values()
                    .filter(|run| !run.status.is_terminal())
                    .flat_map(|run| run.step_threads.values().cloned()),
            )
            .collect();
        let excess = owned.len() - keep;
        let mut evict = Vec::new();
        for (reviewer, _) in owned {
            if evict.len() >= excess {
                break;
            }
            if protected.contains(reviewer.as_str()) {
                continue;
            }
            evict.push(reviewer.clone());
        }
        evict
    }

    /// The in-process summary for a reviewer thread, preferring its live runtime
    /// and falling back to the cached thread row. `None` after a restart (runtimes
    /// and the thread cache are not persisted — only the reviewer→parent map is).
    fn reviewer_thread_summary(&self, reviewer_id: &str) -> Option<&ThreadSummaryView> {
        self.runtimes
            .get(reviewer_id)
            .and_then(|runtime| runtime.summary.as_ref())
            .or_else(|| self.threads.iter().find(|thread| thread.id == reviewer_id))
    }

    /// The provider key for a reviewer thread: its summary's `provider`, then the
    /// routing-cache row's `provider`. NEVER `source` — that is the session ORIGIN
    /// (e.g. "vscode" for codex running inside an editor), not a provider key. Surfacing
    /// the source made the re-review reuse picker filter the reviewer out (its "vscode"
    /// did not match the job's "codex") and the backend reuse-validation reject it. The
    /// cache row is consulted because codex's empty-provider refreshes can blank the live
    /// runtime summary's provider while the (stamped) cache row still carries it. `None`
    /// if no provider is known in-process (e.g. after a restart) — callers re-derive via
    /// `find_thread_provider`.
    pub(crate) fn reviewer_thread_provider(&self, reviewer_id: &str) -> Option<String> {
        self.reviewer_thread_summary(reviewer_id)
            .map(|summary| summary.provider.clone())
            .filter(|provider| !provider.is_empty())
            .or_else(|| {
                self.threads
                    .iter()
                    .find(|thread| thread.id == reviewer_id)
                    .map(|thread| thread.provider.clone())
                    .filter(|provider| !provider.is_empty())
            })
            .or_else(|| {
                // Last resort: the review job recorded the reviewer's provider definitively
                // at creation. Using it means a reviewer always groups under its REAL
                // provider in the reuse picker, instead of being left unknown (which would
                // leak it under every provider — e.g. a codex reviewer showing under Claude).
                self.review_jobs
                    .values()
                    .find(|job| job.reviewer_thread_id.as_deref() == Some(reviewer_id))
                    .map(|job| job.reviewer_provider.clone())
                    .filter(|provider| !provider.is_empty())
            })
    }

    /// Compact views of the reviewer→parent map for the snapshot. The local UI uses
    /// it both for the delete/archive prompt and the Phase 3 reuse picker, so each
    /// view is enriched (best-effort) with the reviewer thread's provider, name, and
    /// last-updated time from its in-process summary. After a restart those joins
    /// return `None` (the summary isn't persisted); the backend re-derives the
    /// provider on submit. Sorted for a stable snapshot.
    pub(crate) fn reviewer_thread_views(&self) -> Vec<crate::protocol::ReviewerThreadView> {
        let mut views: Vec<_> = self
            .reviewer_threads
            .iter()
            .map(|(reviewer, record)| {
                let summary = self.reviewer_thread_summary(reviewer);
                crate::protocol::ReviewerThreadView {
                    reviewer_thread_id: reviewer.clone(),
                    parent_thread_id: record.parent_thread_id.clone(),
                    reviewer_provider: self.reviewer_thread_provider(reviewer),
                    name: summary.and_then(|s| s.name.clone()),
                    updated_at: summary.map(|s| s.updated_at),
                }
            })
            .collect();
        views.sort_by(|a, b| a.reviewer_thread_id.cmp(&b.reviewer_thread_id));
        views
    }

    /// Promote a Claude thread from its synthetic `claude-pending-…` id to the
    /// real SDK session id. This moves the runtime, pending prompts, and any review
    /// job reference without assuming the thread is the current live projection.
    pub(crate) fn promote_background_thread(&mut self, pending_id: &str, real_id: &str) {
        if pending_id == real_id || pending_id.is_empty() || real_id.is_empty() {
            return;
        }
        // Record the lineage FIRST: it rides the snapshot
        // (`active_thread_promoted_from`) so every client — observers included —
        // can authoritatively tell this promotion apart from a normal thread
        // switch (the active-id sequence alone cannot).
        self.thread_promoted_from
            .insert(real_id.to_string(), pending_id.to_string());
        if let Some(mut runtime) = self.runtimes.remove(pending_id) {
            if let Some(summary) = runtime.summary.as_mut() {
                summary.id = real_id.to_string();
            }
            match self.runtimes.remove(real_id) {
                // The event stream already created a real-id runtime with more
                // transcript — keep it, but carry over the pending turn id if it
                // has none.
                Some(mut existing) if existing.transcript.len() >= runtime.transcript.len() => {
                    if existing.active_turn_id.is_none() {
                        existing.active_turn_id = runtime.active_turn_id.take();
                    }
                    existing.turn_revision = existing.turn_revision.max(runtime.turn_revision);
                    self.runtimes.insert(real_id.to_string(), existing);
                }
                Some(existing) => {
                    runtime.turn_revision = runtime.turn_revision.max(existing.turn_revision);
                    self.runtimes.insert(real_id.to_string(), runtime);
                }
                None => {
                    self.runtimes.insert(real_id.to_string(), runtime);
                }
            }
        }
        if let Some(settings) = self.thread_settings.remove(pending_id) {
            self.thread_settings
                .entry(real_id.to_string())
                .or_insert(settings);
        }
        // Carry the honest last-activity timestamp from the synthetic pending id
        // to the real session id, keeping the most recent of the two (either
        // could have logged a transcript write during the promotion handoff).
        // Without this the pending-id entry orphans (and leaks, since the map is
        // persisted) and a later un-hidden reviewer would fall back to mtime.
        if let Some(pending_activity) = self.thread_last_activity_at.remove(pending_id) {
            let entry = self
                .thread_last_activity_at
                .entry(real_id.to_string())
                .or_insert(pending_activity);
            *entry = (*entry).max(pending_activity);
        }
        // Move Project membership from the synthetic pending id to the real session id.
        // Without this an assigned pending session silently becomes "Unassigned" after
        // its first turn, leaving an orphan mapping under `claude-pending-*`. Preserve
        // any assignment the real id already has (conflict → keep the real one), and
        // bump the revision so clients refetch the changed membership.
        if let Some(pending_project) = self.thread_project_id.remove(pending_id) {
            self.thread_project_id
                .entry(real_id.to_string())
                .or_insert(pending_project);
            self.bump_projects_revision();
        }
        // Same orphan class for a user-chosen title. A Claude session can be renamed
        // BEFORE its first message — it is visible in the tab strip from the moment it
        // is created — and that rename is recorded against the synthetic
        // `claude-pending-…` id. Without this move the title silently reverts to the
        // provider's auto-derived name on the first send, and the entry orphans in a
        // persisted map. Conflict keeps the real id's own name.
        if let Some(pending_name) = self.thread_custom_name.remove(pending_id) {
            self.thread_custom_name
                .entry(real_id.to_string())
                .or_insert(pending_name);
        }
        // Same orphan class for fork lineage. A replay fork carrying pasted
        // images must withhold the prompt from `start_thread` (it cannot take
        // image bytes), which puts Claude on its deferred-start path — so the
        // fork is recorded against the pending id and would otherwise lose its
        // source here, leaving a stale key in this PERSISTED map. Conflict
        // keeps the real id's own lineage.
        if let Some(pending_source) = self.thread_forked_from.remove(pending_id) {
            self.thread_forked_from
                .entry(real_id.to_string())
                .or_insert(pending_source);
        }
        // Drop the stale pending row; the real row is upserted by the caller.
        self.threads.retain(|thread| thread.id != pending_id);
        for approval in self.pending_approvals.values_mut() {
            if approval.thread_id == pending_id {
                approval.thread_id = real_id.to_string();
            }
        }
        for question in self.pending_ask_user_questions.values_mut() {
            if question.thread_id == pending_id {
                question.thread_id = real_id.to_string();
            }
        }
        for job in self.review_jobs.values_mut() {
            if job.reviewer_thread_id.as_deref() == Some(pending_id) {
                job.reviewer_thread_id = Some(real_id.to_string());
            }
        }
        // A workflow step thread (a clean Claude reviewer) is promoted from its
        // synthetic pending id to the real session id once its first turn starts;
        // rewrite any workflow `step_threads` entry so the runner keeps tracking the
        // live thread instead of waiting on the removed pending runtime.
        for run in self.workflow_jobs.values_mut() {
            for thread_id in run.step_threads.values_mut() {
                if thread_id == pending_id {
                    *thread_id = real_id.to_string();
                }
            }
        }
        // Move the durable nav-hiding entry from the pending id to the real id
        // (carrying its parent + created_at, so FIFO order is preserved).
        if let Some(record) = self.reviewer_threads.remove(pending_id) {
            self.reviewer_threads.insert(real_id.to_string(), record);
        }
        // The reviewer's turn is in flight; mark the real runtime working until the
        // provider's `done`/`session_stopped` event flips it idle. This keeps the
        // orchestrator's per-thread idle wait correct regardless of turn-id timing.
        self.set_thread_status(real_id, "active".to_string(), Vec::new());
    }

    /// Whether any non-terminal review job exists. Used to enforce one active
    /// review at a time (the review no longer holds the global session guard).
    pub(crate) fn has_active_review(&self) -> bool {
        self.review_jobs
            .values()
            .any(|job| !job.status.is_terminal())
    }

    /// Resolve the non-terminal review targeted by a user stop. Legacy callers may
    /// omit `job_id` only while exactly one review is active; once reviews run
    /// concurrently the operation must be explicit.
    pub(crate) fn active_review_job_ids(
        &self,
        job_id: Option<&str>,
    ) -> Result<(String, String, Option<String>), String> {
        let active = self
            .review_jobs
            .values()
            .filter(|job| !job.status.is_terminal())
            .collect::<Vec<_>>();
        let job = match job_id {
            Some(job_id) => active
                .into_iter()
                .find(|job| job.id == job_id)
                .ok_or_else(|| "there is no active review with that id".to_string())?,
            None => match active.as_slice() {
                [] => return Err("there is no active review to stop".to_string()),
                [job] => *job,
                _ => {
                    return Err(
                        "review_job_id is required when more than one review is active".to_string(),
                    )
                }
            },
        };
        Ok((
            job.id.clone(),
            job.parent_thread_id.clone(),
            job.reviewer_thread_id.clone(),
        ))
    }

    /// Whether `thread_id` is owned by a non-terminal review (its parent OR its
    /// reviewer thread). Such a thread is frozen for send/stop while the review
    /// runs; all other threads stay fully usable. A Blocked job is non-terminal,
    /// so this keeps its threads locked with no held guard.
    pub(crate) fn is_thread_review_locked(&self, thread_id: &str) -> bool {
        self.review_jobs.values().any(|job| {
            !job.status.is_terminal()
                && (job.parent_thread_id == thread_id
                    || job.reviewer_thread_id.as_deref() == Some(thread_id))
        })
    }

    /// Whether `thread_id` is owned by a non-terminal workflow run (its parent OR
    /// any workflow-owned step thread). A `Blocked` workflow is intentionally
    /// non-terminal, so this lock remains until recovery/restart reconciliation.
    pub(crate) fn is_thread_workflow_locked(&self, thread_id: &str) -> bool {
        self.workflow_jobs.values().any(|run| {
            !run.status.is_terminal()
                && (run.parent_thread_id == thread_id
                    || run
                        .step_threads
                        .values()
                        .any(|owned_thread_id| owned_thread_id == thread_id))
        })
    }

    /// Whether a non-terminal workflow currently owns the workspace at `cwd`.
    /// Workflow author turns mutate the working tree, so the lock is workspace-
    /// scoped, not just parent-thread scoped.
    pub(crate) fn is_cwd_workflow_locked(&self, cwd: &str) -> bool {
        self.workflow_jobs
            .values()
            .any(|run| !run.status.is_terminal() && run.cwd == cwd)
    }

    pub(crate) fn is_thread_or_cwd_workflow_locked(&self, thread_id: &str) -> bool {
        self.is_thread_workflow_locked(thread_id)
            || self
                .thread_cwd(thread_id)
                .is_some_and(|cwd| self.is_cwd_workflow_locked(&cwd))
    }

    /// Hard-cap the total retained review jobs (evicting the oldest terminal jobs
    /// first) so review bodies can't pile up. Terminal jobs are NOT dropped by age
    /// — the persistent Reviewer panel keeps them until the user deletes them.
    fn prune_review_jobs(&mut self) {
        // Use strict `<` so there is always room for the caller's insertion:
        // prune when len == MAX_REVIEW_JOBS (not only when it exceeds it).
        if self.review_jobs.len() < MAX_REVIEW_JOBS {
            return;
        }
        let mut terminal: Vec<(String, u64)> = self
            .review_jobs
            .iter()
            .filter(|(_, job)| job.status.is_terminal())
            .map(|(id, job)| (id.clone(), job.updated_at))
            .collect();
        terminal.sort_by_key(|(_, updated_at)| *updated_at);
        for (id, _) in terminal {
            if self.review_jobs.len() < MAX_REVIEW_JOBS {
                break;
            }
            self.review_jobs.remove(&id);
        }
    }

    pub(crate) fn update_review_job<F: FnOnce(&mut ReviewJob)>(
        &mut self,
        id: &str,
        update: F,
    ) -> bool {
        match self.review_jobs.get_mut(id) {
            Some(job) => {
                update(job);
                true
            }
            None => false,
        }
    }

    pub(crate) fn review_job(&self, id: &str) -> Option<&ReviewJob> {
        self.review_jobs.get(id)
    }

    pub(crate) fn insert_workflow_run(&mut self, run: WorkflowRun) {
        self.prune_workflow_runs();
        self.workflow_jobs.insert(run.id.clone(), run);
    }

    #[allow(dead_code)]
    pub(crate) fn remove_workflow_run(&mut self, id: &str) -> Option<WorkflowRun> {
        self.workflow_jobs.remove(id)
    }

    pub(crate) fn update_workflow_run<F: FnOnce(&mut WorkflowRun)>(
        &mut self,
        id: &str,
        update: F,
    ) -> bool {
        match self.workflow_jobs.get_mut(id) {
            Some(run) => {
                update(run);
                true
            }
            None => false,
        }
    }

    pub(crate) fn workflow_run(&self, id: &str) -> Option<&WorkflowRun> {
        self.workflow_jobs.get(id)
    }

    pub(crate) fn begin_resolving_workflow_run(
        &mut self,
        run_id: Option<&str>,
        device_id: &str,
    ) -> Result<(String, String, String, Vec<String>), String> {
        let blocked = self.blocked_workflow_run_ids(run_id)?;
        let device_scope = self.device_path_scope(device_id);
        let run = self
            .workflow_jobs
            .get(&blocked)
            .ok_or_else(|| "blocked workflow was not found".to_string())?;
        ensure_path_within_device_scope(&run.cwd, &device_scope, &self.allowed_roots)?;

        let run = self
            .workflow_jobs
            .get_mut(&blocked)
            .ok_or_else(|| "blocked workflow was not found".to_string())?;
        if !run.begin_resolving_blocked() {
            return Err("workflow is already resolving or no longer blocked".to_string());
        }

        let mut owned_threads = vec![run.parent_thread_id.clone()];
        for thread_id in run.step_threads.values() {
            if !owned_threads.contains(thread_id) {
                owned_threads.push(thread_id.clone());
            }
        }
        Ok((
            blocked,
            run.parent_thread_id.clone(),
            run.cwd.clone(),
            owned_threads,
        ))
    }

    pub(crate) fn blocked_workflow_run_ids(&self, run_id: Option<&str>) -> Result<String, String> {
        if let Some(run_id) = run_id {
            return match self.workflow_jobs.get(run_id) {
                Some(run) if matches!(run.status, RunStatus::Blocked) => Ok(run.id.clone()),
                Some(run) if matches!(run.status, RunStatus::Resolving) => {
                    Err("workflow is already resolving".to_string())
                }
                Some(_) => Err("workflow is not blocked".to_string()),
                None => Err("there is no blocked workflow with that id".to_string()),
            };
        }

        let blocked = self
            .workflow_jobs
            .values()
            .filter(|run| matches!(run.status, RunStatus::Blocked))
            .collect::<Vec<_>>();
        match blocked.as_slice() {
            [] => Err("there is no blocked workflow to resolve".to_string()),
            [run] => Ok(run.id.clone()),
            _ => Err(
                "workflow_run_id is required when more than one workflow is blocked".to_string(),
            ),
        }
    }

    /// Whether any workflow run is still non-terminal. One workflow at a time
    /// (mirrors `has_active_review`); checked while holding the session slot so the
    /// check + insert is atomic against a concurrent start.
    pub(crate) fn has_active_workflow(&self) -> bool {
        self.workflow_jobs
            .values()
            .any(|run| !run.status.is_terminal())
    }

    pub(crate) fn insert_task_list_run(&mut self, run: TaskListRun) {
        self.prune_task_list_runs();
        self.task_list_jobs.insert(run.id.clone(), run);
    }

    pub(crate) fn task_list_run(&self, id: &str) -> Option<&TaskListRun> {
        self.task_list_jobs.get(id)
    }

    pub(crate) fn update_task_list_run<F: FnOnce(&mut TaskListRun)>(
        &mut self,
        id: &str,
        update: F,
    ) -> bool {
        match self.task_list_jobs.get_mut(id) {
            Some(run) => {
                update(run);
                true
            }
            None => false,
        }
    }

    /// Whether any task-list run is still non-terminal. One list at a time (mirrors
    /// `has_active_workflow`); checked under the session slot so check + insert is
    /// atomic against a concurrent start.
    pub(crate) fn has_active_task_list(&self) -> bool {
        self.task_list_jobs
            .values()
            .any(|run| !run.status.is_terminal())
    }

    /// Hard-cap retained task-list runs, evicting the oldest TERMINAL runs first
    /// (mirrors `prune_workflow_runs`). Non-terminal runs are never auto-evicted.
    fn prune_task_list_runs(&mut self) {
        if self.task_list_jobs.len() < MAX_WORKFLOW_RUNS {
            return;
        }
        let mut terminal: Vec<(String, u64)> = self
            .task_list_jobs
            .iter()
            .filter(|(_, run)| run.status.is_terminal())
            .map(|(id, run)| (id.clone(), run.updated_at))
            .collect();
        terminal.sort_by_key(|(_, updated_at)| *updated_at);
        for (id, _) in terminal {
            if self.task_list_jobs.len() < MAX_WORKFLOW_RUNS {
                break;
            }
            self.task_list_jobs.remove(&id);
        }
    }

    /// Hard-cap retained workflow runs, evicting the oldest TERMINAL runs first
    /// (mirrors `prune_review_jobs`). Non-terminal runs are never auto-evicted —
    /// they have a live or restart-recoverable orchestrator.
    fn prune_workflow_runs(&mut self) {
        if self.workflow_jobs.len() < MAX_WORKFLOW_RUNS {
            return;
        }
        let mut terminal: Vec<(String, u64)> = self
            .workflow_jobs
            .iter()
            .filter(|(_, run)| run.status.is_terminal())
            .map(|(id, run)| (id.clone(), run.updated_at))
            .collect();
        terminal.sort_by_key(|(_, updated_at)| *updated_at);
        for (id, _) in terminal {
            if self.workflow_jobs.len() < MAX_WORKFLOW_RUNS {
                break;
            }
            self.workflow_jobs.remove(&id);
        }
    }

    /// Clone persisted workflow runs for restore, reconciling any NON-terminal run
    /// to the terminal `Interrupted` state: after a restart there is no orchestrator
    /// to drive it, so it must never come back `Running` (the failure
    /// `persistence.rs` warns about for review jobs). Terminal runs restore as-is.
    fn restored_workflow_jobs(
        persisted: &HashMap<String, WorkflowRun>,
    ) -> HashMap<String, WorkflowRun> {
        persisted
            .iter()
            .map(|(id, run)| {
                let mut run = run.clone();
                run.mark_interrupted_if_stranded();
                (id.clone(), run)
            })
            .collect()
    }

    /// Compact views of retained review jobs for the snapshot. ONE card per reviewer
    /// thread: when a reviewer thread is reused across several reviews, only the
    /// most-recently-updated job for it is shown (older runs collapse into the latest);
    /// jobs not yet bound to a reviewer thread are each kept. Terminal jobs persist here
    /// (the Reviewer panel keeps them until deleted). Ordered newest-updated first so
    /// recently used reviewers stay at the top of the Reviewer panel.
    pub(crate) fn active_review_jobs_view(&self) -> Vec<crate::protocol::ReviewJobView> {
        let mut latest_by_reviewer: std::collections::HashMap<&str, &ReviewJob> =
            std::collections::HashMap::new();
        let mut unbound: Vec<&ReviewJob> = Vec::new();
        for job in self.review_jobs.values() {
            match job.reviewer_thread_id.as_deref() {
                Some(reviewer) => {
                    let newer = match latest_by_reviewer.get(reviewer) {
                        Some(existing) => {
                            // Prefer the most-recently-updated run; on a same-second tie,
                            // prefer a NON-terminal (in-progress) job so a live run is
                            // never hidden behind a just-completed one — the Stop /
                            // in-progress affordances read this deduped view.
                            (
                                job.updated_at,
                                u8::from(!job.status.is_terminal()),
                                job.id.as_str(),
                            ) > (
                                existing.updated_at,
                                u8::from(!existing.status.is_terminal()),
                                existing.id.as_str(),
                            )
                        }
                        None => true,
                    };
                    if newer {
                        latest_by_reviewer.insert(reviewer, job);
                    }
                }
                None => unbound.push(job),
            }
        }
        let mut views: Vec<_> = latest_by_reviewer
            .values()
            .copied()
            .chain(unbound)
            .map(|job| job.view())
            .collect();
        views.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| right.id.cmp(&left.id))
        });
        views
    }

    /// Content revision of the reviewer-panel data (review jobs + reviewer threads). A
    /// cheap order-independent hash over each card's identity + mutable facets (status,
    /// updated_at, verdict, round) and each reviewer thread's identity + provider. The
    /// reviewer panel re-fetches the uncompacted `reviews_response()` only when this
    /// changes, so it does NOT refetch on every snapshot frame. It's a plain scalar on the
    /// snapshot, so byte-budget compaction never drops it (unlike `active_review_jobs`).
    pub(crate) fn reviews_revision(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        // XOR per-entry hashes so the result is independent of map iteration order.
        let mut acc: u64 = 0;
        for job in self.active_review_jobs_view() {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            job.id.hash(&mut h);
            job.status.hash(&mut h);
            job.updated_at.hash(&mut h);
            job.round.hash(&mut h);
            job.max_rounds.hash(&mut h);
            job.verdict.hash(&mut h);
            job.reviewer_thread_id.hash(&mut h);
            job.reviewer_provider.hash(&mut h);
            acc ^= h.finish();
        }
        for view in self.reviewer_thread_views() {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            view.reviewer_thread_id.hash(&mut h);
            view.parent_thread_id.hash(&mut h);
            view.reviewer_provider.hash(&mut h);
            view.name.hash(&mut h);
            view.updated_at.hash(&mut h);
            // Rotate so a reviewer-thread change can't cancel an identical job hash.
            acc ^= h.finish().rotate_left(1);
        }
        acc
    }

    /// The full, UNCOMPACTED reviewer-panel payload (review cards + reviewer threads +
    /// the matching revision). Served on demand via `/api/session/reviews` (local) and the
    /// `fetch_reviews` broker action (remote), decoupled from the byte-budgeted snapshot so
    /// the panel stays populated even while a live turn drains `active_review_jobs`.
    pub(crate) fn reviews_response(
        &self,
        device_id: Option<&str>,
    ) -> crate::protocol::ReviewsResponse {
        // Scope the payload to the requesting device's workspace, exactly like the other
        // on-demand read channels (workspace diff, transcripts): a paired device must not
        // learn review metadata for parents outside its allowed paths. `None` (the local
        // operator) sees everything. `reviews_revision` stays global (it matches the
        // snapshot's — the client's cache key); only the lists are filtered.
        let scope = device_id
            .map(|id| self.device_path_scope(id))
            .unwrap_or_default();
        let in_scope = |parent_thread_id: &str| -> bool {
            match self.thread_cwd(parent_thread_id) {
                // `ensure_path_within_device_scope` enforces relay `allowed_roots` FIRST
                // (always), then the device scope (skipped when empty) — so even an unscoped
                // device / the local operator stays bounded by relay roots, matching
                // workspace_diff / transcripts.
                Some(cwd) => {
                    crate::state::ensure_path_within_device_scope(&cwd, &scope, &self.allowed_roots)
                        .is_ok()
                }
                // Unknown workspace: only a fully-unrestricted requester (no device scope AND
                // no relay roots) has no boundary to enforce, so it may still see the review;
                // otherwise exclude it (we can't prove it's in-bounds).
                None => scope.is_empty() && self.allowed_roots.is_empty(),
            }
        };
        crate::protocol::ReviewsResponse {
            reviews_revision: self.reviews_revision(),
            review_jobs: self
                .active_review_jobs_view()
                .into_iter()
                .filter(|job| in_scope(&job.parent_thread_id))
                .collect(),
            reviewer_threads: self
                .reviewer_thread_views()
                .into_iter()
                .filter(|view| in_scope(&view.parent_thread_id))
                .collect(),
        }
    }

    /// Minimal, non-terminal review state that must arrive synchronously with a
    /// session frame for locking and navigation decisions. Full cards and
    /// reviewer identities are fetched from `reviews_response()`.
    pub(crate) fn review_activity_view(&self) -> Vec<crate::protocol::ReviewActivityView> {
        let active_thread_id = self.active_thread_id.as_deref();
        let mut jobs = self
            .review_jobs
            .values()
            .filter(|job| !job.status.is_terminal())
            .collect::<Vec<_>>();
        jobs.sort_by(|left, right| {
            let involves_active = |job: &ReviewJob| {
                active_thread_id.is_some_and(|active| {
                    job.parent_thread_id == active
                        || job.reviewer_thread_id.as_deref() == Some(active)
                })
            };
            involves_active(right)
                .cmp(&involves_active(left))
                .then_with(|| {
                    (right.status.as_str() == "blocked").cmp(&(left.status.as_str() == "blocked"))
                })
                .then_with(|| right.updated_at.cmp(&left.updated_at))
                .then_with(|| right.id.cmp(&left.id))
        });
        jobs.truncate(crate::protocol::MAX_REVIEW_ACTIVITY_JOBS);
        jobs.into_iter()
            .map(|job| crate::protocol::ReviewActivityView {
                id: job.id.clone(),
                parent_thread_id: job.parent_thread_id.clone(),
                reviewer_thread_id: job.reviewer_thread_id.clone(),
                status: job.status.as_str().to_string(),
            })
            .collect()
    }

    pub(crate) fn review_activity_summary(&self) -> (usize, bool) {
        let mut total = 0;
        let mut blocked = false;
        for job in self
            .review_jobs
            .values()
            .filter(|job| !job.status.is_terminal())
        {
            total += 1;
            blocked |= job.status.as_str() == "blocked";
        }
        (total, blocked)
    }

    /// Compact views of retained workflow runs for the snapshot. Workflow runs
    /// are serialized one at a time in phase 1 but terminal runs remain visible
    /// briefly, mirroring review cards.
    pub(crate) fn active_workflow_runs_view(&self) -> Vec<crate::protocol::WorkflowRunView> {
        let mut views: Vec<_> = self
            .workflow_jobs
            .values()
            .map(|run| {
                let mut view = run.view();
                if !run.status.is_terminal() {
                    view.locked_thread_ids = self.workflow_locked_thread_ids(run);
                }
                view
            })
            .collect();
        views.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| right.id.cmp(&left.id))
        });
        views
    }

    pub(crate) fn workflows_revision(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut acc: u64 = 0;
        for run in self.active_workflow_runs_view() {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            run.id.hash(&mut h);
            run.workflow_id.hash(&mut h);
            run.parent_thread_id.hash(&mut h);
            run.status.hash(&mut h);
            run.current_step.hash(&mut h);
            run.round.hash(&mut h);
            run.reviewer_thread_id.hash(&mut h);
            run.locked_thread_ids.hash(&mut h);
            run.last_verdict.hash(&mut h);
            run.updated_at.hash(&mut h);
            run.error.hash(&mut h);
            acc ^= h.finish();
        }
        acc
    }

    /// Minimal, non-terminal workflow state retained in SessionSnapshot.
    pub(crate) fn workflow_activity_view(&self) -> Vec<crate::protocol::WorkflowActivityView> {
        let mut runs = self
            .workflow_jobs
            .values()
            .filter(|run| !run.status.is_terminal())
            .collect::<Vec<_>>();
        runs.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| right.id.cmp(&left.id))
        });
        runs.truncate(crate::protocol::MAX_WORKFLOW_ACTIVITY_RUNS);
        runs.into_iter()
            .map(|run| crate::protocol::WorkflowActivityView {
                id: run.id.clone(),
                parent_thread_id: run.parent_thread_id.clone(),
                status: run.status.as_str().to_string(),
                locked_thread_ids: self.workflow_activity_locked_thread_ids(run),
            })
            .collect()
    }

    /// Full workflow cards, served outside the byte-budgeted snapshot.
    pub(crate) fn workflows_response(
        &self,
        device_id: Option<&str>,
    ) -> crate::protocol::WorkflowsResponse {
        let scope = device_id
            .map(|id| self.device_path_scope(id))
            .unwrap_or_default();
        let in_scope = |parent_thread_id: &str| -> bool {
            match self.thread_cwd(parent_thread_id) {
                Some(cwd) => {
                    crate::state::ensure_path_within_device_scope(&cwd, &scope, &self.allowed_roots)
                        .is_ok()
                }
                None => scope.is_empty() && self.allowed_roots.is_empty(),
            }
        };
        crate::protocol::WorkflowsResponse {
            workflows_revision: self.workflows_revision(),
            workflow_runs: self
                .active_workflow_runs_view()
                .into_iter()
                .filter(|run| in_scope(&run.parent_thread_id))
                .collect(),
        }
    }

    fn workflow_locked_thread_ids(&self, run: &WorkflowRun) -> Vec<String> {
        let mut ids = vec![run.parent_thread_id.clone()];
        ids.extend(run.step_threads.values().cloned());
        ids.extend(
            self.runtimes
                .iter()
                .filter(|(thread_id, runtime)| {
                    runtime.current_cwd == run.cwd
                        && !self.locally_deleted_thread_ids.contains(thread_id.as_str())
                })
                .map(|(thread_id, _)| thread_id.clone()),
        );
        ids.extend(
            self.threads
                .iter()
                .filter(|thread| {
                    thread.cwd == run.cwd
                        && !self.locally_deleted_thread_ids.contains(thread.id.as_str())
                })
                .map(|thread| thread.id.clone()),
        );
        ids.sort();
        ids.dedup();
        ids
    }

    fn workflow_activity_locked_thread_ids(&self, run: &WorkflowRun) -> Vec<String> {
        let all_locked = self.workflow_locked_thread_ids(run);
        let mut prioritized = Vec::new();
        let mut add_if_locked = |candidate: Option<&String>| {
            let Some(candidate) = candidate else {
                return;
            };
            if all_locked.binary_search(candidate).is_ok()
                && !prioritized.iter().any(|existing| existing == candidate)
            {
                prioritized.push(candidate.clone());
            }
        };

        // Exact state for the workflow parent and the currently rendered thread
        // must survive the cap. Background/view-only threads get their exact
        // lock bit from the transcript channel's `thread_state.workflow_locked`.
        add_if_locked(Some(&run.parent_thread_id));
        add_if_locked(self.active_thread_id.as_ref());
        for thread_id in run.step_threads.values() {
            add_if_locked(Some(thread_id));
        }
        drop(add_if_locked);

        for thread_id in all_locked {
            if !prioritized.contains(&thread_id) {
                prioritized.push(thread_id);
            }
            if prioritized.len() >= crate::protocol::MAX_WORKFLOW_ACTIVITY_LOCKED_THREAD_IDS {
                break;
            }
        }
        prioritized.truncate(crate::protocol::MAX_WORKFLOW_ACTIVITY_LOCKED_THREAD_IDS);
        prioritized
    }

    pub(crate) fn ensure_runtime_for_thread(&mut self, thread_id: &str) -> &mut ThreadRuntime {
        if self.active_thread_id.as_deref() == Some(thread_id)
            && !self.runtimes.contains_key(thread_id)
        {
            self.materialize_selected_runtime_from_fields();
        }
        let now = unix_now();
        let summary = self
            .threads
            .iter()
            .find(|thread| thread.id == thread_id)
            .cloned();
        self.runtimes
            .entry(thread_id.to_string())
            .or_insert_with(|| {
                let mut runtime = ThreadRuntime::placeholder(thread_id, now);
                if let Some(summary) = summary {
                    runtime.current_status = summary.status.clone();
                    runtime.current_cwd = summary.cwd.clone();
                    runtime.summary = Some(summary);
                }
                // A lazily-materialized runtime carries no live turn (placeholder sets
                // active_turn_id = None), and its status is read-derived — from a
                // `self.threads` summary (which upsert_thread keeps at the raw provider
                // string) or, with no summary, the placeholder's own "active" default.
                // Neither is a liveness signal, so a working value here is a ghost
                // is_working() (mirrors from_sync_data / upsert_thread). Settle it; a
                // live turn/status event re-asserts working afterwards.
                if thread_status_is_working(&runtime.current_status) {
                    runtime.current_status = "idle".to_string();
                }
                runtime.model = self.model.clone();
                runtime.approval_policy = self.approval_policy.clone();
                runtime.sandbox = self.sandbox.clone();
                runtime.reasoning_effort = self.reasoning_effort.clone();
                runtime
            })
    }

    pub(crate) fn sync_selected_runtime_to_fields(&mut self) {
        let Some(runtime) = self.selected_runtime().cloned() else {
            self.transcript_revision = 0;
            self.active_turn_id = None;
            self.current_status = "idle".to_string();
            self.current_phase = None;
            self.current_tool = None;
            self.last_progress_at = None;
            self.active_flags.clear();
            self.transcript.clear();
            self.apply_states.clear();
            return;
        };
        self.transcript_revision = runtime.transcript_revision;
        self.active_turn_id = runtime.active_turn_id;
        self.current_status = runtime.current_status;
        self.current_phase = runtime.current_phase;
        self.current_tool = runtime.current_tool;
        self.last_progress_at = runtime.last_progress_at;
        self.active_flags = runtime.active_flags;
        self.current_cwd = runtime.current_cwd;
        self.model = runtime.model;
        self.approval_policy = runtime.approval_policy;
        self.sandbox = runtime.sandbox;
        self.reasoning_effort = runtime.reasoning_effort;
        self.transcript = runtime.transcript;
        self.apply_states = runtime.apply_states;
    }

    pub(crate) fn materialize_selected_runtime_from_fields(&mut self) {
        let Some(thread_id) = self.active_thread_id.clone() else {
            return;
        };
        if self.runtimes.contains_key(&thread_id) {
            return;
        }
        let now = unix_now();
        let mut runtime = ThreadRuntime::placeholder(&thread_id, now);
        if let Some(summary) = self
            .threads
            .iter()
            .find(|thread| thread.id == thread_id)
            .cloned()
        {
            runtime.summary = Some(summary.clone());
            runtime.current_cwd = if self.current_cwd.is_empty() {
                summary.cwd
            } else {
                self.current_cwd.clone()
            };
        } else {
            runtime.current_cwd = self.current_cwd.clone();
        }
        runtime.active_turn_id = self.active_turn_id.clone();
        runtime.current_status = self.current_status.clone();
        runtime.current_phase = self.current_phase.clone();
        runtime.current_tool = self.current_tool.clone();
        runtime.last_progress_at = self.last_progress_at;
        runtime.active_flags = self.active_flags.clone();
        runtime.model = self.model.clone();
        runtime.approval_policy = self.approval_policy.clone();
        runtime.sandbox = self.sandbox.clone();
        runtime.reasoning_effort = self.reasoning_effort.clone();
        runtime.transcript_revision = self.transcript_revision;
        runtime.transcript = self.transcript.clone();
        runtime.apply_states = self.apply_states.clone();
        runtime.pending_approvals = self
            .pending_approvals
            .iter()
            .filter(|(_, pending)| pending.thread_id == thread_id)
            .map(|(key, pending)| (key.clone(), pending.clone()))
            .collect();
        runtime.pending_ask_user_questions = self
            .pending_ask_user_questions
            .iter()
            .filter(|(_, pending)| pending.thread_id == thread_id)
            .map(|(key, pending)| (key.clone(), pending.clone()))
            .collect();
        self.runtimes.insert(thread_id, runtime);
    }

    /// Move the legacy control focus to an already-known runtime without
    /// resuming or re-reading the provider session. Viewing is client-local;
    /// this is used only after a targeted write has successfully started.
    pub(crate) fn focus_thread_runtime(&mut self, thread_id: &str, device_id: &str) {
        self.materialize_selected_runtime_from_fields();
        self.ensure_runtime_for_thread(thread_id);
        self.active_thread_id = Some(thread_id.to_string());
        self.assign_active_controller(device_id, unix_now());
        self.sync_selected_runtime_to_fields();
    }

    /// Live per-thread activity for the activity badges: the active thread (if
    /// it has an in-flight turn or progress phase) plus every backgrounded
    /// thread that still has a turn in flight. This is the only place the
    /// snapshot describes threads other than the active one.
    fn thread_activity_view(&self) -> Vec<ThreadActivityView> {
        let mut activity = Vec::new();
        for (thread_id, runtime) in &self.runtimes {
            if !runtime.is_working() {
                continue;
            }
            // A locally-deleted thread whose runtime was resurrected by a stray late
            // event must not show up as a working/ghost thread.
            if self.locally_deleted_thread_ids.contains(thread_id) {
                continue;
            }
            activity.push(ThreadActivityView {
                thread_id: thread_id.clone(),
                phase: runtime.current_phase.clone(),
                tool: runtime.current_tool.clone(),
            });
        }
        activity
    }

    fn device_views(
        &self,
        now: u64,
    ) -> (
        Vec<crate::protocol::DeviceRecordView>,
        Vec<crate::protocol::PairedDeviceView>,
        Vec<crate::protocol::PendingPairingRequestView>,
    ) {
        let live_requests = self
            .pending_pairing_requests
            .values()
            .filter(|request| request.expires_at > now);
        let mut device_records = self.device_records.clone();
        for request in live_requests.clone() {
            device_records.insert(
                request.device_id.clone(),
                DeviceRecord {
                    device_id: request.device_id.clone(),
                    label: request.label.clone(),
                    lifecycle_state: crate::protocol::DeviceLifecycleState::Pending,
                    created_at: request.requested_at,
                    state_changed_at: request.requested_at,
                    last_seen_at: None,
                    last_peer_id: Some(request.broker_peer_id.clone()),
                    device_verify_key: request.device_verify_key.clone(),
                    broker_join_ticket_expires_at: None,
                    path_scope: request.path_scope.clone(),
                },
            );
        }
        let mut device_records = device_records
            .values()
            .cloned()
            .map(|record| record.to_view())
            .collect::<Vec<_>>();
        device_records.sort_by(|left, right| {
            device_state_sort_key(left.lifecycle_state)
                .cmp(&device_state_sort_key(right.lifecycle_state))
                .then_with(|| left.label.cmp(&right.label))
                .then_with(|| left.device_id.cmp(&right.device_id))
        });
        let mut paired_devices = self
            .paired_devices
            .values()
            .cloned()
            .map(|device| device.to_view())
            .collect::<Vec<_>>();
        paired_devices.sort_by(|left, right| left.label.cmp(&right.label));
        let mut pending_pairing_requests = live_requests
            .cloned()
            .map(|request| request.to_view())
            .collect::<Vec<_>>();
        pending_pairing_requests.sort_by(|left, right| left.requested_at.cmp(&right.requested_at));
        (device_records, paired_devices, pending_pairing_requests)
    }

    fn devices_revision_for(
        device_records: &[crate::protocol::DeviceRecordView],
        paired_devices: &[crate::protocol::PairedDeviceView],
        pending_pairing_requests: &[crate::protocol::PendingPairingRequestView],
    ) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        device_records.hash(&mut hasher);
        paired_devices.hash(&mut hasher);
        pending_pairing_requests.hash(&mut hasher);
        hasher.finish()
    }

    pub(crate) fn devices_response(&self) -> crate::protocol::DevicesResponse {
        let (device_records, paired_devices, pending_pairing_requests) =
            self.device_views(unix_now());
        let devices_revision =
            Self::devices_revision_for(&device_records, &paired_devices, &pending_pairing_requests);
        crate::protocol::DevicesResponse {
            devices_revision,
            device_records,
            paired_devices,
            pending_pairing_requests,
        }
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        let devices_revision = {
            let (records, paired, pending) = self.device_views(unix_now());
            Self::devices_revision_for(&records, &paired, &pending)
        };
        let (review_activity_total, review_blocked) = self.review_activity_summary();
        let selected = self.selected_runtime();
        let transcript_revision = selected
            .map(|runtime| runtime.transcript_revision)
            .unwrap_or(self.transcript_revision);
        let active_turn_id = selected
            .filter(|runtime| runtime.has_live_turn())
            .and_then(|runtime| runtime.active_turn_id.clone())
            .or_else(|| {
                selected
                    .is_none()
                    .then(|| self.active_turn_id.clone())
                    .flatten()
            });
        let current_status = selected
            .map(|runtime| {
                if runtime.liveness_timed_out {
                    "idle".to_string()
                } else {
                    runtime.current_status.clone()
                }
            })
            .unwrap_or_else(|| self.current_status.clone());
        let current_phase = selected
            .and_then(|runtime| runtime.current_phase.clone())
            .or_else(|| self.current_phase.clone());
        let current_tool = selected
            .and_then(|runtime| runtime.current_tool.clone())
            .or_else(|| self.current_tool.clone());
        let last_progress_at = selected
            .and_then(|runtime| runtime.last_progress_at)
            .or(self.last_progress_at);
        let active_flags = selected
            .map(|runtime| runtime.active_flags.clone())
            .unwrap_or_else(|| self.active_flags.clone());
        let current_cwd = selected
            .map(|runtime| runtime.current_cwd.clone())
            .unwrap_or_else(|| self.current_cwd.clone());
        let model = selected
            .map(|runtime| runtime.model.clone())
            .unwrap_or_else(|| self.model.clone());
        let approval_policy = selected
            .map(|runtime| runtime.approval_policy.clone())
            .unwrap_or_else(|| self.approval_policy.clone());
        let sandbox = selected
            .map(|runtime| runtime.sandbox.clone())
            .unwrap_or_else(|| self.sandbox.clone());
        let reasoning_effort = selected
            .map(|runtime| runtime.reasoning_effort.clone())
            .unwrap_or_else(|| self.reasoning_effort.clone());
        let mut transcript = selected
            .map(|runtime| runtime.transcript_views())
            .unwrap_or_else(|| {
                self.transcript
                    .iter()
                    .map(|record| {
                        let mut view = record.to_view();
                        if let (Some(item_id), Some(tool)) =
                            (view.item_id.as_ref(), view.tool.as_mut())
                        {
                            if let Some(state) = self.apply_states.get(item_id) {
                                tool.apply_state = Some(*state);
                            }
                        }
                        view
                    })
                    .collect()
            });
        // Snapshots carry only a file-change summary; the full diffs ride the
        // entry-detail fetch so a large diff can't bloat the size-bounded
        // snapshot. The authoritative read/detail paths keep full diffs.
        crate::protocol::strip_file_change_diffs_for_snapshot(&mut transcript);

        SessionSnapshot {
            provider_fork_capabilities: self.provider_fork_capabilities.clone(),
            provider_status: self.provider_status_view(),
            revision: self.revision,
            transcript_revision,
            server_time: unix_now(),
            provider: self.provider_name.clone(),
            service_ready: true,
            provider_connected: self.provider_connected,
            broker_connected: self.broker_connected,
            broker_channel_id: self.broker_channel_id.clone(),
            broker_peer_id: self.broker_peer_id.clone(),
            security_mode: self.security.mode(),
            e2ee_enabled: self.security.e2ee_enabled(),
            broker_can_read_content: self.security.broker_can_read_content(),
            audit_enabled: self.security.audit_enabled(),
            active_thread_id: self.active_thread_id.clone(),
            active_thread_promoted_from: self
                .active_thread_id
                .as_ref()
                .and_then(|id| self.thread_promoted_from.get(id).cloned()),
            active_controller_device_id: self.active_controller_device_id.clone(),
            active_controller_last_seen_at: self.active_controller_last_seen_at,
            controller_lease_expires_at: self.controller_lease_expires_at(),
            controller_lease_seconds: CONTROLLER_LEASE_SECS,
            active_turn_id,
            current_status,
            current_phase,
            current_tool,
            last_progress_at,
            active_flags,
            thread_activity: self.thread_activity_view(),
            current_cwd,
            model,
            available_models: self.available_models.clone(),
            approval_policy,
            sandbox,
            reasoning_effort,
            allowed_roots: self.allowed_roots.clone(),
            device_records: Vec::new(),
            paired_devices: Vec::new(),
            pending_pairing_requests: Vec::new(),
            devices_revision,
            pending_approvals: self
                .pending_approvals
                .values()
                .cloned()
                .map(|approval| approval.to_view())
                .collect(),
            pending_ask_user_questions: {
                let mut views = self
                    .pending_ask_user_questions
                    .values()
                    .cloned()
                    .map(|pending| pending.to_view())
                    .collect::<Vec<_>>();
                // Stable ordering keeps the UI from reshuffling cards as
                // unrelated state updates trigger snapshot recomputations.
                views.sort_by(|a, b| {
                    a.requested_at
                        .cmp(&b.requested_at)
                        .then_with(|| a.request_id.cmp(&b.request_id))
                });
                views
            },
            transcript_truncated: false,
            transcript,
            logs: self.logs.clone(),
            active_review_jobs: Vec::new(),
            reviewer_threads: Vec::new(),
            review_activity: self.review_activity_view(),
            review_activity_total,
            review_blocked,
            reviews_revision: self.reviews_revision(),
            active_workflow_runs: Vec::new(),
            workflow_activity: self.workflow_activity_view(),
            workflows_revision: self.workflows_revision(),
            push_vapid_public_key: self.push_vapid_public_key.clone(),
            projects_revision: self.projects_revision,
            threads_revision: self.threads_revision,
        }
    }

    #[allow(dead_code)]
    pub fn activate_thread(
        &mut self,
        thread: ThreadSummaryView,
        cwd: &str,
        model: &str,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        device_id: &str,
    ) {
        let now = unix_now();
        let thread_id = thread.id.clone();
        self.materialize_selected_runtime_from_fields();
        self.assign_active_controller(device_id, now);
        self.active_thread_id = Some(thread_id.clone());
        self.runtimes.insert(
            thread_id.clone(),
            ThreadRuntime::new(
                thread.clone(),
                cwd,
                model,
                approval_policy,
                sandbox,
                effort,
                now,
            ),
        );
        self.remember_thread_settings(&thread_id, approval_policy, sandbox, effort, model);
        self.sync_selected_runtime_to_fields();
        self.upsert_thread(thread);
    }

    pub(crate) fn activate_started_thread(
        &mut self,
        mut thread: ThreadSummaryView,
        cwd: &str,
        model: &str,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        device_id: &str,
    ) {
        let now = unix_now();
        let thread_id = thread.id.clone();
        self.materialize_selected_runtime_from_fields();
        self.assign_active_controller(device_id, now);
        self.active_thread_id = Some(thread_id.clone());
        if let Some(runtime) = self.runtimes.get_mut(&thread_id) {
            // Provider events can race the start response and create this runtime
            // before start_session activates it. Keep their transcript and turn
            // lifecycle instead of replacing a completed turn with fresh active state.
            thread.status = runtime.current_status.clone();
            runtime.summary = Some(thread.clone());
            runtime.current_cwd = cwd.to_string();
            runtime.model = model.to_string();
            runtime.approval_policy = approval_policy.to_string();
            runtime.sandbox = sandbox.to_string();
            runtime.reasoning_effort = effort.to_string();
            runtime.touch(now);
        } else {
            self.runtimes.insert(
                thread_id.clone(),
                ThreadRuntime::new(
                    thread.clone(),
                    cwd,
                    model,
                    approval_policy,
                    sandbox,
                    effort,
                    now,
                ),
            );
        }
        self.remember_thread_settings(&thread_id, approval_policy, sandbox, effort, model);
        self.sync_selected_runtime_to_fields();
        self.upsert_thread(thread);
    }

    /// Register a thread as a BACKGROUND runtime without touching the active
    /// thread, controller, provider, or model. Used to spin up a reviewer thread
    /// that runs concurrently with (and never disturbs) the user's active
    /// conversation. The thread summary is added to `relay.threads` so
    /// `find_thread_provider` can route to it; it is hidden from navigation by
    /// `reviewer_thread_ids()` filtering.
    pub fn register_background_thread(
        &mut self,
        thread: ThreadSummaryView,
        cwd: &str,
        model: &str,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
    ) {
        let now = unix_now();
        let thread_id = thread.id.clone();
        self.runtimes.insert(
            thread_id.clone(),
            ThreadRuntime::new(
                thread.clone(),
                cwd,
                model,
                approval_policy,
                sandbox,
                effort,
                now,
            ),
        );
        self.remember_thread_settings(&thread_id, approval_policy, sandbox, effort, model);
        self.upsert_thread(thread);
    }

    /// Re-attach a BACKGROUND runtime for an existing thread from freshly-read
    /// provider data, WITHOUT touching the active thread/controller. Used to revive
    /// a reused reviewer thread that lost its runtime (e.g. after a relay restart):
    /// the orchestrator needs a runtime so `wait_for_thread_idle_outcome` can
    /// observe the re-review turn and the read-back can bind to a *fresh* assistant
    /// message instead of replaying the thread's prior review. No-op if a runtime
    /// already exists. The hydrated transcript supplies the read-back baseline.
    pub(crate) fn hydrate_background_runtime(
        &mut self,
        data: ThreadSyncData,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        model: &str,
    ) {
        self.hydrate_background_runtime_inner(data, approval_policy, sandbox, effort, model, true);
    }

    pub(crate) fn hydrate_background_runtime_without_remembering_settings(
        &mut self,
        data: ThreadSyncData,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        model: &str,
    ) {
        self.hydrate_background_runtime_inner(data, approval_policy, sandbox, effort, model, false);
    }

    fn hydrate_background_runtime_inner(
        &mut self,
        data: ThreadSyncData,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        model: &str,
        remember_settings: bool,
    ) {
        let thread_id = data.thread.id.clone();
        if self.runtimes.contains_key(&thread_id) {
            return;
        }
        let now = unix_now();
        let runtime = ThreadRuntime::from_sync_data(
            data.clone(),
            approval_policy,
            sandbox,
            effort,
            model,
            now,
        );
        self.runtimes.insert(thread_id.clone(), runtime);
        if remember_settings {
            self.remember_thread_settings(&thread_id, approval_policy, sandbox, effort, model);
        }
        self.upsert_thread(data.thread);
    }

    pub fn set_available_models(&mut self, models: Vec<ModelOptionView>) {
        let preferred = models
            .iter()
            .find(|model| model.is_default)
            .or_else(|| models.first())
            .cloned();
        self.available_models = models;

        let current_model_known = self
            .available_models
            .iter()
            .any(|option| option.model == self.model);

        if let Some(default_model) = preferred {
            if self.model == DEFAULT_MODEL || !current_model_known {
                self.model = default_model.model.clone();
            }

            // Only resolve the effort when it is the unset sentinel. A
            // deliberately chosen effort (e.g. Claude "max") must survive a
            // catalog (re)load — otherwise switching/resuming, or a startup
            // refresh, silently rewrites the user's choice to the model
            // default. The send/resume paths handle the rare case where the
            // chosen effort isn't valid for the active model.
            if self.reasoning_effort == DEFAULT_EFFORT {
                self.reasoning_effort = default_model.default_reasoning_effort;
            }
        }
        // Push the resolved model/effort down to the active thread — but ONLY if
        // that thread belongs to the provider this catalog describes.
        //
        // `start_session` loads the NEW provider's catalog and calls this while
        // `active_thread_id` still points at the OUTGOING provider's thread
        // (`activate_started_thread` runs after). Unguarded, starting a codex
        // session therefore stamps codex's default model onto the Claude thread
        // the user just left; switching back to it then shows — and sends — a
        // codex model id on a Claude thread. A model id is only meaningful to
        // the provider that published it.
        //
        // An unknown provider on either side keeps the old unconditional
        // behaviour, so a thread whose summary hasn't been stamped yet (e.g.
        // codex's empty-provider refreshes) still gets synced.
        let catalog_provider = self
            .available_models
            .iter()
            .map(|option| option.provider.clone())
            .find(|provider| !provider.is_empty());
        if let Some(thread_id) = self.active_thread_id.clone() {
            let model = self.model.clone();
            let effort = self.reasoning_effort.clone();
            if let Some(runtime) = self.runtimes.get_mut(&thread_id) {
                let runtime_provider = runtime
                    .summary
                    .as_ref()
                    .map(|summary| summary.provider.clone())
                    .filter(|provider| !provider.is_empty());
                let crosses_providers = matches!(
                    (&catalog_provider, &runtime_provider),
                    (Some(catalog), Some(thread)) if catalog != thread
                );
                if !crosses_providers {
                    runtime.model = model;
                    runtime.reasoning_effort = effort;
                }
            }
        }
    }

    pub fn load_thread_data(
        &mut self,
        data: ThreadSyncData,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        model: &str,
        device_id: &str,
    ) {
        let now = unix_now();
        let thread_id = data.thread.id.clone();
        let model_for_runtime = if model.is_empty() {
            self.model.clone()
        } else {
            model.to_string()
        };
        self.materialize_selected_runtime_from_fields();
        self.assign_active_controller(device_id, now);
        self.active_thread_id = Some(thread_id.clone());
        let runtime = ThreadRuntime::from_sync_data(
            data.clone(),
            approval_policy,
            sandbox,
            effort,
            &model_for_runtime,
            now,
        );
        if let Some(existing) = self.runtimes.get_mut(&thread_id) {
            existing.merge_fresh_history(runtime);
        } else {
            self.runtimes.insert(thread_id.clone(), runtime);
        }
        self.remember_thread_settings(
            &thread_id,
            approval_policy,
            sandbox,
            effort,
            &model_for_runtime,
        );
        self.sync_selected_runtime_to_fields();
        self.upsert_thread(data.thread);
    }

    pub(super) fn restore_thread_data(
        &mut self,
        data: ThreadSyncData,
        persisted: &PersistedRelayState,
    ) {
        let now = unix_now();
        let thread_id = data.thread.id.clone();
        self.active_thread_id = Some(thread_id.clone());
        self.active_controller_device_id = persisted.active_controller_device_id.clone();
        self.active_controller_last_seen_at = persisted.active_controller_last_seen_at;
        let settings = persisted.settings_for_thread(&data.thread.id);
        let model = if settings.model.is_empty() {
            persisted.model.clone()
        } else {
            settings.model.clone()
        };
        let runtime = ThreadRuntime::from_sync_data(
            data.clone(),
            &settings.approval_policy,
            &settings.sandbox,
            &settings.reasoning_effort,
            &model,
            now,
        );
        self.runtimes.insert(thread_id.clone(), runtime);
        self.thread_settings = persisted.thread_settings.clone();
        let mut materialized = settings;
        if materialized.model.is_empty() {
            materialized.model = model;
        }
        self.thread_settings
            .entry(data.thread.id.clone())
            .or_insert(materialized);
        self.thread_forked_from = persisted.thread_forked_from.clone();
        self.thread_promoted_from = persisted.thread_promoted_from.clone();
        self.projects = persisted.projects.clone();
        self.thread_project_id = persisted.thread_project_id.clone();
        self.thread_custom_name = persisted.thread_custom_name.clone();
        self.projects_revision = persisted.projects_revision;
        // Normalize: a state file written before `projects_revision` existed restores
        // it as 0 while carrying projects; a fresh client (also 0) would then never
        // fetch them. Advertise a nonzero revision whenever project data is present.
        if self.projects_revision == 0
            && (!self.projects.is_empty() || !self.thread_project_id.is_empty())
        {
            self.projects_revision = 1;
        }
        self.allowed_roots = persisted.allowed_roots.clone();
        self.device_records = persisted.device_records.clone();
        self.paired_devices = persisted.paired_devices.clone();
        self.push_subscriptions = persisted.push_subscriptions.clone();
        self.prune_orphaned_push_subscriptions();
        // Durable reviewer-thread identity + completed (terminal) review-job cards
        // survive restart. The writer only persists terminal jobs, and we re-apply the
        // same filter here (defense-in-depth): a non-terminal job from a corrupt or
        // future-build snapshot must never be restored, or it would re-lock its parent
        // with no orchestrator left to release it.
        self.reviewer_threads = persisted.reviewer_threads.clone();
        self.review_jobs = persisted
            .review_jobs
            .iter()
            .filter(|(_, job)| job.status.is_terminal())
            .map(|(id, job)| (id.clone(), job.clone()))
            .collect();
        // Workflow runs persist NON-terminal too; reconcile any stranded run to the
        // terminal `Interrupted` here — no orchestrator survives a restart (see
        // workflow.rs / `restored_workflow_jobs`).
        self.workflow_jobs = Self::restored_workflow_jobs(&persisted.workflow_jobs);
        self.recompute_reviewer_thread_seq();
        self.online_surface_peer_ids.clear();
        self.online_surface_peer_devices.clear();
        self.backfill_device_records_from_paired_devices();
        self.pending_pairings.clear();
        self.pending_pairing_requests.clear();
        self.completed_pairings.clear();
        self.pending_claim_challenges.clear();
        self.pending_broker_messages.clear();
        self.pending_approvals.clear();
        self.pending_ask_user_questions.clear();
        self.recent_remote_actions.clear();
        self.locally_deleted_thread_ids.clear();
        self.sync_selected_runtime_to_fields();
        self.upsert_thread(data.thread);
    }

    pub fn upsert_thread(&mut self, mut thread: ThreadSummaryView) {
        if self.locally_deleted_thread_ids.contains(&thread.id) {
            return;
        }
        // A user-renamed session keeps its title through every provider event. This is
        // the live-event funnel (a turn finishing re-derives Claude's summary), so
        // without the override here a rename would visibly revert mid-conversation
        // even though the persisted map still held it.
        self.apply_custom_thread_name(&mut thread);
        if let Some(existing) = self
            .threads
            .iter()
            .find(|existing| existing.id == thread.id)
        {
            if thread.name.is_none() {
                thread.name = existing.name.clone();
            }
            if thread.preview.is_empty() {
                thread.preview = existing.preview.clone();
            }
            if thread.cwd.is_empty() {
                thread.cwd = existing.cwd.clone();
            }
            if thread.source.is_empty() {
                thread.source = existing.source.clone();
            }
            if thread.model_provider.is_empty() {
                thread.model_provider = existing.model_provider.clone();
            }
        }
        // Codex thread summaries carry an empty `provider` key (see codex.rs
        // `parse_thread_summary`). Routing a BACKGROUND thread relies on that key —
        // a reviewer thread is never the active thread, so the active-provider
        // fallback in `find_thread_provider` can't save it. We stamp the provider
        // when a reviewer thread is registered, but the provider's own event stream
        // later upserts the same thread with an empty provider, which would clobber
        // the stamp and make the reviewer unroutable mid-review ("thread '…' was not
        // found on any provider"). Preserve a previously-known provider whenever the
        // incoming summary doesn't carry one. (A thread never changes providers, so
        // this can only ever restore the correct value.)
        if thread.provider.is_empty() {
            if let Some(known) = self
                .runtimes
                .get(&thread.id)
                .and_then(|runtime| runtime.summary.as_ref())
                .map(|summary| summary.provider.clone())
                .filter(|provider| !provider.is_empty())
                .or_else(|| {
                    self.threads
                        .iter()
                        .find(|existing| existing.id == thread.id)
                        .map(|existing| existing.provider.clone())
                        .filter(|provider| !provider.is_empty())
                })
            {
                thread.provider = known;
            }
        }
        if let Some(runtime) = self.runtimes.get_mut(&thread.id) {
            runtime.summary = Some(thread.clone());
            // A thread summary (a provider list/read row) is NOT a liveness signal —
            // only live turn/status events are. A summary that reports a working status
            // for a thread with no live turn must not overwrite the runtime into
            // "working": that is the read-status ghost (Codex's read/list surfaces a
            // stale `status.type`; the same status from_sync_data just settled would be
            // resurrected here, e.g. via restore_thread_data's closing upsert). Keep a
            // working status only when a turn is actually in flight; otherwise settle to
            // idle. A settled string (idle/viewing/completed/unknown) applies verbatim.
            // The display row in `self.threads` below keeps the raw status; list working
            // badges read `runtime.is_working()`, not the summary string.
            runtime.current_status =
                if runtime.active_turn_id.is_some() || !thread_status_is_working(&thread.status) {
                    thread.status.clone()
                } else {
                    "idle".to_string()
                };
            if runtime.current_cwd.is_empty() {
                runtime.current_cwd = thread.cwd.clone();
            }
        }
        if let Some(existing) = self.threads.iter_mut().find(|item| item.id == thread.id) {
            *existing = thread;
        } else {
            self.threads.insert(0, thread);
        }
    }

    /// Record genuine activity for a thread (user send, agent output, tool /
    /// file-change entry). Always advances to now — real activity is, by
    /// definition, the most recent thing to happen to the thread.
    pub(super) fn touch_thread_last_activity(&mut self, thread_id: &str) {
        self.thread_last_activity_at
            .insert(thread_id.to_string(), unix_now());
    }

    /// Fold a resume-HONEST activity timestamp into the tracked value, keeping
    /// the most recent. Only call this with a value that a no-prompt resume
    /// can't inflate — i.e. a provider whose `read_thread.updated_at` is the
    /// transcript's last real message time (`read_thread_reports_activity_time`
    /// == true, currently Claude). Because the input is never resume-polluted,
    /// the max is safe (can't reintroduce click-to-top reordering) AND heals
    /// activity the relay never witnessed (e.g. CLI use between views) on open.
    pub(super) fn observe_thread_last_activity(&mut self, thread_id: &str, activity_at: u64) {
        let entry = self
            .thread_last_activity_at
            .entry(thread_id.to_string())
            .or_insert(activity_at);
        *entry = (*entry).max(activity_at);
    }

    /// Seed a thread's activity baseline WITHOUT clobbering an existing value.
    /// Used on resume for providers whose `read_thread.updated_at` may be a
    /// session-file mtime that resume bumps (anything other than Claude). The
    /// or-insert freeze means a polluted mtime is recorded at most once, so
    /// repeated selection can't creep the thread up the list — the same
    /// provider-agnostic safety the non-Claude path had before honest sourcing.
    pub(super) fn seed_thread_last_activity(&mut self, thread_id: &str, updated_at: u64) {
        self.thread_last_activity_at
            .entry(thread_id.to_string())
            .or_insert(updated_at);
    }

    /// Honest sort/display timestamp for a thread: the tracked activity time if
    /// we have one, else the provider-reported `updated_at` (which is only ever
    /// polluted for threads we've resumed, and those are exactly the ones we
    /// have a tracked value for).
    pub(super) fn thread_last_activity_or(&self, thread_id: &str, provider_updated_at: u64) -> u64 {
        self.thread_last_activity_at
            .get(thread_id)
            .copied()
            .unwrap_or(provider_updated_at)
    }

    pub fn thread_settings(&self, thread_id: &str) -> Option<ThreadSessionSettings> {
        self.remembered_thread_settings(thread_id)
            .or_else(|| self.runtimes.get(thread_id).map(ThreadRuntime::settings))
    }

    pub fn remembered_thread_settings(&self, thread_id: &str) -> Option<ThreadSessionSettings> {
        self.thread_settings.get(thread_id).cloned()
    }

    pub fn set_provider_fork_capabilities(
        &mut self,
        capabilities: Vec<crate::protocol::ProviderForkCapabilityView>,
    ) {
        self.provider_fork_capabilities = capabilities;
    }

    pub fn set_provider_status_base(&mut self, base: Vec<crate::provider::ProviderStatusBase>) {
        self.provider_status_base = base;
    }

    /// Derive the live per-provider status panel: static spawn outcome folded
    /// with the current connection map. Recomputed on every snapshot so a
    /// disconnect/reconnect streams to clients without any extra plumbing.
    fn provider_status_view(&self) -> Vec<crate::protocol::ProviderStatusView> {
        use crate::protocol::{ProviderStatusKind, ProviderStatusView};
        self.provider_status_base
            .iter()
            .map(|base| {
                let (status, connected, reason) = match &base.spawn_error {
                    // Spawn failed: classify why, and carry the raw reason.
                    Some(reason) => (
                        crate::provider::classify_spawn_error(reason),
                        false,
                        Some(reason.clone()),
                    ),
                    // Spawn succeeded: fold in the live connection signal.
                    None => match self.provider_connections.get(&base.provider_key) {
                        Some(true) => (ProviderStatusKind::Connected, true, None),
                        Some(false) => (ProviderStatusKind::Disconnected, false, None),
                        None => (ProviderStatusKind::Starting, false, None),
                    },
                };
                ProviderStatusView {
                    provider: base.provider_key.clone(),
                    display_name: base.display_name.clone(),
                    status,
                    connected,
                    reason,
                }
            })
            .collect()
    }

    pub fn set_thread_forked_from(&mut self, thread_id: &str, source_thread_id: &str) {
        if thread_id.is_empty() || source_thread_id.is_empty() {
            return;
        }
        self.thread_forked_from
            .insert(thread_id.to_string(), source_thread_id.to_string());
    }

    pub fn thread_forked_from(&self, thread_id: &str) -> Option<String> {
        self.thread_forked_from.get(thread_id).cloned()
    }

    /// Drop a lineage row for a fork that never started. The map is persisted,
    /// so a row pointing at a thread that was created but never given its first
    /// turn would otherwise outlive every restart.
    ///
    /// Notifies on a real removal: the persistence task only saves in response
    /// to a watch-channel change, so a silent in-memory removal would never
    /// reach disk and the stale row would return on the next restart. A no-op
    /// removal stays silent rather than waking every client for nothing.
    pub fn clear_thread_forked_from(&mut self, thread_id: &str) {
        if self.thread_forked_from.remove(thread_id).is_some() {
            self.notify();
        }
    }

    pub fn remember_thread_settings(
        &mut self,
        thread_id: &str,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        model: &str,
    ) {
        self.thread_settings.insert(
            thread_id.to_string(),
            ThreadSessionSettings::new(approval_policy, sandbox, effort, model),
        );
        if let Some(runtime) = self.runtimes.get_mut(thread_id) {
            runtime.approval_policy = approval_policy.to_string();
            runtime.sandbox = sandbox.to_string();
            runtime.reasoning_effort = effort.to_string();
            runtime.model = model.to_string();
        }
    }

    pub fn remember_active_thread_settings(&mut self) {
        let Some(thread_id) = self.active_thread_id.clone() else {
            return;
        };
        let approval_policy = self.approval_policy.clone();
        let sandbox = self.sandbox.clone();
        let reasoning_effort = self.reasoning_effort.clone();
        let model = self.model.clone();
        self.remember_thread_settings(
            &thread_id,
            &approval_policy,
            &sandbox,
            &reasoning_effort,
            &model,
        );
    }

    pub fn can_archive_thread(&self, thread_id: &str) -> Result<bool, String> {
        let is_active = self.active_thread_id.as_deref() == Some(thread_id);
        let running = self
            .runtimes
            .get(thread_id)
            .is_some_and(ThreadRuntime::has_live_turn)
            || (is_active && self.active_thread_has_live_turn());
        if running {
            return Err(
                "cannot archive the active session while Codex is still running".to_string(),
            );
        }

        Ok(is_active)
    }

    pub fn can_delete_thread(&self, thread_id: &str) -> Result<bool, String> {
        let is_active = self.active_thread_id.as_deref() == Some(thread_id);
        let running = self
            .runtimes
            .get(thread_id)
            .is_some_and(ThreadRuntime::has_live_turn)
            || (is_active && self.active_thread_has_live_turn());
        if running {
            return Err(
                "cannot permanently delete the active session while Codex is still running"
                    .to_string(),
            );
        }

        Ok(is_active)
    }

    pub fn remove_thread(&mut self, thread_id: &str) -> bool {
        let before_len = self.threads.len();
        self.threads.retain(|thread| thread.id != thread_id);
        self.thread_settings.remove(thread_id);
        self.thread_last_activity_at.remove(thread_id);
        // The user's title goes with the session, on ARCHIVE as well as delete — this is
        // the shared path. The relay has no un-archive, so an override left behind here
        // could never be reached again: it would hold a slot under the persisted cap
        // forever and wait to be inherited by a reused id. It joins the two persisted
        // per-thread maps this function already clears, rather than being a special case.
        self.thread_custom_name.remove(thread_id);
        // Same reasoning: a hint left behind would keep an archived/deleted session
        // routable from a stale search result the client still has on screen.
        self.forget_search_routing_hint(thread_id);
        self.runtimes.remove(thread_id);
        self.drop_pending_requests_for_thread(thread_id);
        self.threads.len() != before_len
    }

    pub fn mark_thread_deleted(&mut self, thread_id: &str) {
        self.locally_deleted_thread_ids
            .insert(thread_id.to_string());
        // Clear project membership on PERMANENT deletion specifically (not in the
        // shared `remove_thread`, which archive also uses): otherwise the persisted
        // `thread_project_id` keeps a durable orphan entry, and a reused id could
        // silently regain its old project. Bump the Projects revision when membership
        // actually changed so passive clients drop the stale mapping (a reused id
        // would otherwise still render under its former Project).
        if self.thread_project_id.remove(thread_id).is_some() {
            self.bump_projects_revision();
        }
        // The user's title is cleared by `remove_thread` below, which archive shares —
        // unlike project membership above, it needs no permanent-delete-only placement.
        self.remove_thread(thread_id);
    }

    fn drop_pending_requests_for_thread(&mut self, thread_id: &str) {
        self.pending_approvals
            .retain(|_, pending| pending.thread_id != thread_id);
        self.pending_ask_user_questions
            .retain(|_, pending| pending.thread_id != thread_id);
        if let Some(runtime) = self.runtimes.get_mut(thread_id) {
            runtime.pending_approvals.clear();
            runtime.pending_ask_user_questions.clear();
        }
    }

    pub fn add_pending_approval(&mut self, pending: PendingApproval) {
        if !pending.thread_id.is_empty() {
            self.ensure_runtime_for_thread(&pending.thread_id)
                .pending_approvals
                .insert(pending.request_id.clone(), pending.clone());
        }
        self.pending_approvals
            .insert(pending.request_id.clone(), pending);
    }

    pub fn remove_pending_approval(&mut self, request_id: &str) -> Option<PendingApproval> {
        let pending = self.pending_approvals.remove(request_id)?;
        if !pending.thread_id.is_empty() {
            if let Some(runtime) = self.runtimes.get_mut(&pending.thread_id) {
                runtime.pending_approvals.remove(request_id);
            }
        }
        Some(pending)
    }

    pub fn add_pending_ask_user_question(&mut self, pending: PendingAskUserQuestion) {
        if !pending.thread_id.is_empty() {
            self.ensure_runtime_for_thread(&pending.thread_id)
                .pending_ask_user_questions
                .insert(pending.request_id.clone(), pending.clone());
        }
        self.pending_ask_user_questions
            .insert(pending.request_id.clone(), pending);
    }

    pub fn remove_pending_ask_user_question(
        &mut self,
        request_id: &str,
    ) -> Option<PendingAskUserQuestion> {
        let pending = self.pending_ask_user_questions.remove(request_id)?;
        if !pending.thread_id.is_empty() {
            if let Some(runtime) = self.runtimes.get_mut(&pending.thread_id) {
                runtime.pending_ask_user_questions.remove(request_id);
            }
        }
        Some(pending)
    }

    pub fn filter_deleted_threads(
        &self,
        threads: Vec<ThreadSummaryView>,
    ) -> Vec<ThreadSummaryView> {
        threads
            .into_iter()
            .filter(|thread| !self.locally_deleted_thread_ids.contains(&thread.id))
            .collect()
    }

    pub fn set_provider_connection(&mut self, provider: &str, connected: bool) {
        self.provider_connections
            .insert(provider.to_string(), connected);
        self.provider_connected = self.provider_connections.values().any(|c| *c);
    }

    pub fn set_provider_name(&mut self, name: String) {
        // A genuine provider switch invalidates the shared model catalog: it was
        // loaded for the OLD provider, so leaving it in place makes the snapshot
        // report `provider=<new>` with `available_models=<old provider's catalog>`
        // — the cross-provider model leak (Codex showing Claude's models when a
        // persisted Codex session is restored on top of a boot-time Claude
        // catalog, and the Codex catalog load hasn't landed yet). Drop it; the
        // next catalog load (start/resume/refresh, or the client's per-provider
        // fetch) repopulates it for the new provider. The initial assignment (from
        // an empty provider) keeps any prewarmed catalog.
        if !self.provider_name.is_empty() && self.provider_name != name {
            self.available_models.clear();
        }
        self.provider_name = name;
    }

    pub fn set_broker_connection(&mut self, connected: bool) {
        self.broker_connected = connected;
        if !connected {
            self.online_surface_peer_ids.clear();
            self.online_surface_peer_devices.clear();
            // Broker surfaces are gone with the connection, so their watch sets go too
            // (the client re-declares on reconnect). LOCAL tabs are NOT affected — they
            // are still connected over SSE, and wiping them here would silently
            // downgrade the local live tail to polling every time the broker blipped.
            let broker_surfaces = std::mem::take(&mut self.broker_surface_ids);
            self.watched_threads
                .retain(|surface_id, _| !broker_surfaces.contains(surface_id));
        }
    }

    pub fn set_broker_target(&mut self, channel_id: Option<String>, peer_id: Option<String>) {
        self.broker_channel_id = channel_id;
        self.broker_peer_id = peer_id;
    }

    pub fn set_active_turn(&mut self, turn_id: Option<String>) {
        let now = unix_now();
        if let Some(thread_id) = self.active_thread_id.clone() {
            let runtime = self.ensure_runtime_for_thread(&thread_id);
            runtime.active_turn_id = turn_id;
            runtime.liveness_timed_out = false;
            runtime.liveness_stop_requested = false;
            runtime.last_progress_at = runtime.active_turn_id.as_ref().map(|_| now);
            runtime.note_turn_event();
            runtime.touch(now);
        }
        self.sync_selected_runtime_to_fields();
    }

    /// A provider worker died mid-turn (its stream closed). Any turn it was running
    /// can never emit a terminal event, so settle every thread that belongs to this
    /// provider and still carries a live `active_turn_id` to idle. The worker's death
    /// IS the authoritative terminal signal here — this is where the "idle + stale
    /// turn" ghost is killed, NOT in `merge_fresh_history` (C5: a history re-read is
    /// never authoritative about turn liveness). Without this a ghost `active_turn_id`
    /// keeps is_working() true forever, blocking reviews in that cwd until restart.
    pub fn fail_in_flight_turns_for_provider(&mut self, provider: &str) {
        let now = unix_now();
        let stuck_threads: Vec<String> = self
            .runtimes
            .iter()
            .filter(|(_, runtime)| {
                runtime.active_turn_id.is_some()
                    && runtime
                        .summary
                        .as_ref()
                        .is_some_and(|summary| summary.provider == provider)
            })
            .map(|(thread_id, _)| thread_id.clone())
            .collect();
        for thread_id in stuck_threads {
            if self.active_thread_id.as_deref() == Some(thread_id.as_str()) {
                self.set_active_turn(None);
                self.set_thread_status(&thread_id, "idle".to_string(), Vec::new());
                self.clear_progress();
            } else {
                self.bg_set_active_turn(&thread_id, None, now);
                self.bg_set_thread_status(&thread_id, "idle".to_string(), Vec::new(), now);
            }
            // A running turn died — notify remote devices (and suppress the
            // work→idle "completed" the snapshot diff would otherwise emit).
            self.enqueue_error_push(&thread_id, "stopped unexpectedly — the agent exited.");
        }
    }

    pub fn mark_surface_peer_online(&mut self, peer_id: &str) -> bool {
        self.online_surface_peer_ids.insert(peer_id.to_string())
    }

    pub fn mark_surface_peer_offline(&mut self, peer_id: &str) -> bool {
        self.online_surface_peer_devices.remove(peer_id);
        let removed = self.online_surface_peer_ids.remove(peer_id);
        self.prune_offline_broker_surfaces();
        removed
    }

    pub fn replace_online_surface_peers<I>(&mut self, peer_ids: I)
    where
        I: IntoIterator<Item = String>,
    {
        self.online_surface_peer_ids = peer_ids.into_iter().collect();
        self.online_surface_peer_devices
            .retain(|peer_id, _| self.online_surface_peer_ids.contains(peer_id));
        self.prune_offline_broker_surfaces();
    }

    /// Drop watch sets for BROKER surfaces whose peer has gone.
    ///
    /// Scoped to surfaces keyed by a broker peer id. A local browser tab is also a
    /// surface but has no broker peer, so a blanket "retain only surfaces with an
    /// online peer" would delete every local tab's subscription the moment any phone
    /// joined or left — silently downgrading the local live tail to polling.
    fn prune_offline_broker_surfaces(&mut self) {
        // Retain by VALUE first so the closures below don't borrow `self` twice.
        let online = self.online_surface_peer_ids.clone();
        let broker_surfaces = std::mem::take(&mut self.broker_surface_ids);
        self.watched_threads.retain(|surface_id, _| {
            !broker_surfaces.contains(surface_id) || online.contains(surface_id)
        });
        // Also drop the departed ids themselves: a phone that reconnects mints a new
        // peer id every time, so keeping the old ones grows this set without bound for
        // as long as the relay's own broker connection stays up.
        self.broker_surface_ids = broker_surfaces
            .into_iter()
            .filter(|surface_id| online.contains(surface_id))
            .collect();
    }

    /// Replace a surface's watch set, keeping only threads the DEVICE is allowed to
    /// read. Returns true when the stored set changed.
    ///
    /// Scope is enforced here because a watch declaration is a content grant: the relay
    /// streams the thread's transcript to whoever declares it. Every other content path
    /// (transcript pages, approvals, fork, review, workflow) checks
    /// `ensure_path_within_device_scope`, and a subscription must not be the one way
    /// around it. E2EE does not mitigate this — the declaring device holds the key.
    ///
    /// A thread whose runtime is not loaded has no known cwd, so it cannot be proven
    /// in scope and is refused. Unscoped devices (empty `path_scope`) are unaffected.
    pub fn set_watched_threads(
        &mut self,
        surface_id: &str,
        device_id: &str,
        thread_ids: Vec<String>,
    ) -> bool {
        self.set_watched_threads_for_generation(surface_id, device_id, thread_ids, None)
    }

    /// As `set_watched_threads`, but refuses a declaration from a superseded connection.
    ///
    /// `generation` is what the caller's SSE stream was given. `None` means the client
    /// did not supply one (an older client), in which case the declaration is accepted —
    /// the same backwards-compatible posture as a missing watch set.
    pub fn set_watched_threads_for_generation(
        &mut self,
        surface_id: &str,
        device_id: &str,
        thread_ids: Vec<String>,
        generation: Option<u64>,
    ) -> bool {
        if let Some(generation) = generation {
            let current = self
                .surface_generations
                .get(surface_id)
                .copied()
                .unwrap_or(0);
            if generation < current {
                // A stale page's POST arriving after its replacement declared.
                return false;
            }
        }
        let device_scope = self.device_path_scope(device_id);
        let allowed_roots = self.allowed_roots.clone();
        let next: HashSet<String> = thread_ids
            .into_iter()
            .filter(|id| !id.is_empty())
            // Reject only what is PROVABLY out of bounds. A thread whose runtime is not
            // loaded has no cwd to judge, and local navigation declares the watch BEFORE
            // the transcript fetch loads it — filtering it here muted that thread until
            // the next reconnect, because the client has already recorded the declaration
            // as delivered and dedupes the retry.
            //
            // Nothing is lost by admitting it: delivery re-checks readability on every
            // frame (`thread_is_readable_by_device`), so an unloaded or out-of-scope
            // thread still sends nothing. Declaration-time filtering is an early reject;
            // delivery is the gate.
            .filter(|thread_id| match self.runtime_for_thread(thread_id) {
                Some(runtime) if !runtime.current_cwd.trim().is_empty() => {
                    Self::thread_is_readable_by(
                        Some(runtime.current_cwd.as_str()),
                        &device_scope,
                        &allowed_roots,
                    )
                }
                _ => true,
            })
            .collect();

        // An explicit declaration ALWAYS replaces, including an empty one. Removing the
        // entry instead would restore the never-declared fallback (the active thread),
        // which is how a fully-filtered-out declaration used to hand a scoped device the
        // very content the filter had just refused.
        match self.watched_threads.get(surface_id) {
            Some(current)
                if current.thread_ids == next
                    && current.device_id == device_id
                    && current.generation
                        == self
                            .surface_generations
                            .get(surface_id)
                            .copied()
                            .unwrap_or(0) =>
            {
                false
            }
            _ => {
                let generation = self
                    .surface_generations
                    .get(surface_id)
                    .copied()
                    .unwrap_or(0);
                self.watched_threads.insert(
                    surface_id.to_string(),
                    WatchedSurface {
                        device_id: device_id.to_string(),
                        thread_ids: next,
                        generation,
                    },
                );
                true
            }
        }
    }

    /// Mark a surface id as belonging to a broker peer, so it is pruned when that peer
    /// goes offline. Local surfaces are never registered here.
    pub fn register_broker_surface(&mut self, surface_id: &str) {
        self.broker_surface_ids.insert(surface_id.to_string());
    }

    /// Test hook: whether a surface id is still tracked as a broker surface.
    #[cfg(test)]
    pub fn broker_surface_id_is_tracked(&self, surface_id: &str) -> bool {
        self.broker_surface_ids.contains(surface_id)
    }

    /// Record a connection generation for a surface id, returning the one now in force.
    /// A reconnect on the same surface id supersedes the previous connection.
    ///
    /// `claimed` is the client's own value (its connect timestamp), which survives a page
    /// reload — a purely server-minted counter would restart at 1 and could not tell a
    /// reloaded page from its predecessor. An older or absent claim never lowers what is
    /// already in force.
    pub fn open_surface_generation(&mut self, surface_id: &str, claimed: Option<u64>) -> u64 {
        let current = self
            .surface_generations
            .get(surface_id)
            .copied()
            .unwrap_or(0);
        let next = match claimed {
            Some(claimed) if claimed > current => claimed,
            Some(_) => current,
            None => current.saturating_add(1),
        };
        self.surface_generations
            .insert(surface_id.to_string(), next);
        next
    }

    /// Drop a surface's watch set ONLY if `generation` is still the current one.
    ///
    /// The teardown of a closed connection races the setup of its replacement (a page
    /// refresh reuses the surface id). Unconditional removal here would silently
    /// unsubscribe the live connection.
    pub fn drop_watched_surface_generation(&mut self, surface_id: &str, generation: u64) -> bool {
        if self.surface_generations.get(surface_id).copied() != Some(generation) {
            return false;
        }
        self.surface_generations.remove(surface_id);
        self.broker_surface_ids.remove(surface_id);
        self.watched_threads.remove(surface_id).is_some()
    }

    /// Drop one surface's watch set unconditionally (peer left; no generation race).
    pub fn drop_watched_surface(&mut self, surface_id: &str) -> bool {
        self.surface_generations.remove(surface_id);
        self.broker_surface_ids.remove(surface_id);
        self.watched_threads.remove(surface_id).is_some()
    }

    /// Drop every watch set belonging to a device (device revoked / unpaired).
    pub fn clear_watched_threads_for_device(&mut self, device_id: &str) -> bool {
        let before = self.watched_threads.len();
        self.watched_threads
            .retain(|_, watched| watched.device_id != device_id);
        before != self.watched_threads.len()
    }

    /// Whether a specific SURFACE should receive deltas for `thread_id`. This is the
    /// filter a local SSE connection uses, so two tabs get exactly what each is showing.
    pub fn surface_watches_thread(&self, surface_id: &str, thread_id: &str) -> bool {
        match self.watched_threads.get(surface_id) {
            Some(watched) => {
                watched.thread_ids.contains(thread_id)
                    && self.thread_is_readable_by_device(thread_id, &watched.device_id)
            }
            // Never declared: the pre-subscription behavior was the active thread — but
            // still only if this device may read it.
            None => self.active_thread_id.as_deref() == Some(thread_id),
        }
    }

    /// Whether a device may read a thread's content at all, re-derived from CURRENT
    /// scope and roots. Checked on every delivery, not just at declaration time: a
    /// device whose scope (or the relay's allowed roots) is tightened afterwards must
    /// stop receiving a thread it was already watching.
    pub fn thread_is_readable_by_device(&self, thread_id: &str, device_id: &str) -> bool {
        Self::thread_is_readable_by(
            self.runtime_for_thread(thread_id)
                .map(|r| r.current_cwd.as_str()),
            &self.device_path_scope(device_id),
            &self.allowed_roots,
        )
    }

    /// A thread is readable when its cwd is inside the relay's allowed roots AND (when
    /// the device is scoped) inside that device's grant.
    ///
    /// An unknown cwd — no runtime loaded yet, or a runtime with a blank cwd — cannot be
    /// PROVEN in scope, so it is refused whenever there is a restriction to enforce.
    /// When neither a device scope nor relay roots exist there is nothing to violate, so
    /// an unloaded thread stays declarable (a client may legitimately declare a thread
    /// before its runtime materializes).
    fn thread_is_readable_by(
        cwd: Option<&str>,
        device_scope: &[String],
        allowed_roots: &[String],
    ) -> bool {
        let unrestricted = device_scope.is_empty() && allowed_roots.is_empty();
        match cwd.map(str::trim).filter(|cwd| !cwd.is_empty()) {
            Some(cwd) => {
                crate::state::ensure_path_within_device_scope(cwd, device_scope, allowed_roots)
                    .is_ok()
            }
            None => unrestricted,
        }
    }

    /// Whether a DEVICE should receive deltas for `thread_id` — true when any of its
    /// surfaces is watching. Broker delivery is per device (the payload secret is), so
    /// one device with two surfaces gets the union.
    pub fn device_watches_thread(&self, device_id: &str, thread_id: &str) -> bool {
        let mut declared = false;
        let mut wants = false;
        for watched in self.watched_threads.values() {
            if watched.device_id != device_id {
                continue;
            }
            declared = true;
            if watched.thread_ids.contains(thread_id) {
                wants = true;
                break;
            }
        }
        if !declared {
            // No declaration from this device at all -> pre-subscription behavior.
            wants = self.active_thread_id.as_deref() == Some(thread_id);
        }
        // Re-derived every time, so tightening a scope revokes an existing watch.
        wants && self.thread_is_readable_by_device(thread_id, device_id)
    }

    /// True when at least one surface wants deltas for this thread. Providers use this
    /// to skip queueing entirely for a thread nobody is looking at.
    pub fn any_device_watches_thread(&self, thread_id: &str) -> bool {
        if self.active_thread_id.as_deref() == Some(thread_id) {
            return true;
        }
        self.watched_threads
            .values()
            .any(|watched| watched.thread_ids.contains(thread_id))
    }

    pub fn bind_surface_peer_to_device(&mut self, device_id: &str, peer_id: &str) {
        self.online_surface_peer_devices
            .insert(peer_id.to_string(), device_id.to_string());
    }

    /// Queue a message for the broker publisher to drain. Transcript deltas are only
    /// ever consumed by that publisher, so when no broker is configured (local-only)
    /// they are dropped at the door instead of growing an unconsumed queue forever;
    /// when a broker IS configured the delta backlog is capped (dropped deltas are
    /// recoverable — the broker republishes an authoritative snapshot on reconnect).
    /// Pairing results have their own retention semantics and are always kept.
    pub fn queue_broker_message(&mut self, message: BrokerPendingMessage) {
        if let BrokerPendingMessage::TranscriptDelta(delta) = &message {
            // Tee to the local SSE subscribers FIRST — before the broker-only guard
            // below. A relay with no broker still has a local surface, and that
            // surface still wants a live tail. Every provider funnels its deltas
            // through here, so this is the one place that has to be right.
            self.emit_local_transcript_delta(delta);
            if !self.broker_configured {
                return;
            }
        }
        self.pending_broker_messages.push(message);
        self.bound_pending_transcript_deltas();
    }

    /// Cap the number of queued transcript deltas, dropping the oldest beyond the
    /// bound. Pairing results are never dropped.
    fn bound_pending_transcript_deltas(&mut self) {
        const MAX_PENDING_DELTAS: usize = 4096;
        let delta_count = self
            .pending_broker_messages
            .iter()
            .filter(|m| matches!(m, BrokerPendingMessage::TranscriptDelta(_)))
            .count();
        let Some(mut to_drop) = delta_count.checked_sub(MAX_PENDING_DELTAS) else {
            return;
        };
        if to_drop == 0 {
            return;
        }
        self.pending_broker_messages.retain(|m| {
            if to_drop > 0 && matches!(m, BrokerPendingMessage::TranscriptDelta(_)) {
                to_drop -= 1;
                false
            } else {
                true
            }
        });
    }

    pub fn drain_pending_broker_messages(&mut self) -> Vec<BrokerPendingMessage> {
        std::mem::take(&mut self.pending_broker_messages)
    }

    #[allow(dead_code)]
    pub fn can_device_send_message(&self, device_id: &str) -> bool {
        if self.active_thread_id.is_none() {
            return false;
        }

        match self.active_controller_device_id.as_deref() {
            Some(active_device_id) => active_device_id == device_id,
            None => true,
        }
    }

    #[allow(dead_code)]
    pub fn ensure_device_can_send_message(&self, device_id: &str) -> Result<(), String> {
        if self.active_thread_id.is_none() {
            return Err("there is no active Codex thread to send to".to_string());
        }

        if self.can_device_send_message(device_id) {
            Ok(())
        } else {
            Err("another device currently has control. Take over on this device before sending a message.".to_string())
        }
    }

    pub fn can_device_approve(&self, _device_id: &str) -> bool {
        self.active_thread_id.is_some()
    }

    pub fn ensure_device_can_approve(&self, device_id: &str) -> Result<(), String> {
        if self.can_device_approve(device_id) {
            Ok(())
        } else {
            Err("there is no active session to approve for".to_string())
        }
    }

    #[allow(dead_code)]
    pub fn set_active_controller(&mut self, device_id: &str) -> bool {
        self.assign_active_controller(device_id, unix_now())
    }

    pub fn refresh_controller_lease(&mut self, device_id: &str, now: u64) -> bool {
        if self.active_thread_id.is_none() {
            return false;
        }

        if self.active_controller_device_id.as_deref() != Some(device_id) {
            return false;
        }

        if self.active_controller_last_seen_at == Some(now) {
            return false;
        }

        self.active_controller_last_seen_at = Some(now);
        true
    }

    pub fn controller_lease_expires_at(&self) -> Option<u64> {
        self.active_controller_last_seen_at
            .map(|last_seen| last_seen.saturating_add(CONTROLLER_LEASE_SECS))
    }

    pub fn expire_stale_controller(&mut self, now: u64) -> Option<String> {
        if self.active_thread_id.is_none() {
            self.active_controller_device_id = None;
            self.active_controller_last_seen_at = None;
            return None;
        }

        let active_device_id = self.active_controller_device_id.clone()?;
        let Some(expires_at) = self.controller_lease_expires_at() else {
            self.active_controller_device_id = None;
            self.active_controller_last_seen_at = None;
            return Some(active_device_id);
        };

        if now < expires_at {
            return None;
        }

        self.active_controller_device_id = None;
        self.active_controller_last_seen_at = None;
        Some(active_device_id)
    }

    pub fn set_thread_status(
        &mut self,
        thread_id: &str,
        status: String,
        active_flags: Vec<String>,
    ) {
        {
            let runtime = self.ensure_runtime_for_thread(thread_id);
            runtime.current_status = status.clone();
            runtime.active_flags = active_flags.clone();
            // A SETTLED status means the turn is over: drop any lingering phase/tool so it
            // can't go stale. Phase is only refreshed for the ACTIVE thread, so a background
            // thread that finished a turn would otherwise keep a ghost "thinking"/"tool"
            // phase forever. Use the strict settled set (not merely `!working`) so an
            // indeterminate `unknown`/`completed` doesn't wipe a still-relevant phase.
            if thread_status_is_settled(&status) {
                runtime.current_phase = None;
                runtime.current_tool = None;
            }
            runtime.touch(unix_now());
        }

        // The same "turn is over" signal also means any approval / ask-user
        // request the agent paused on is now orphaned: there is no live turn to
        // consume an answer. Drop them so a cancelled or abnormally-ended turn
        // doesn't leave an unanswerable prompt pinned — which clients surface
        // forever as a "needs input" badge with nothing to resolve it.
        //
        // SAFETY CONTRACT: this only drops genuinely-orphaned requests because
        // every provider sets a *working* status BEFORE adding a pending request
        // (claude.rs `approval_requested`/`ask_user_question_requested`, codex
        // `requestApproval`) and keeps the turn suspended while it is pending. So
        // a non-working status here always means the request can no longer be
        // answered. A future handler that adds a pending request without first
        // marking the thread active would break this and must not.
        //
        // Gated on the strict SETTLED set, not merely `!working`: an indeterminate
        // `unknown` (a stray refresh / malformed event) must NEVER orphan-drop a live
        // approval. Only a definitively-over status (idle / viewing / empty) drops.
        if thread_status_is_settled(&status) {
            self.drop_pending_requests_for_thread(thread_id);
        }

        if let Some(thread) = self.threads.iter_mut().find(|item| item.id == thread_id) {
            thread.status = status;
        }
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
    }

    pub(super) fn apply_persisted(&mut self, persisted: &PersistedRelayState) {
        self.active_thread_id = persisted.active_thread_id.clone();
        self.active_controller_device_id = persisted.active_controller_device_id.clone();
        self.active_controller_last_seen_at = persisted.active_controller_last_seen_at;
        self.current_cwd = persisted.current_cwd.clone();
        self.model = persisted.model.clone();
        self.approval_policy = persisted.approval_policy.clone();
        self.sandbox = persisted.sandbox.clone();
        self.reasoning_effort = persisted.reasoning_effort.clone();
        self.thread_settings = persisted.thread_settings.clone();
        self.thread_last_activity_at = persisted.thread_last_activity_at.clone();
        if let Some(thread_id) = self.active_thread_id.clone() {
            let mut settings = self
                .thread_settings
                .get(&thread_id)
                .cloned()
                .unwrap_or_else(|| {
                    ThreadSessionSettings::new(
                        &self.approval_policy,
                        &self.sandbox,
                        &self.reasoning_effort,
                        &self.model,
                    )
                });
            if settings.model.is_empty() {
                settings.model = self.model.clone();
            }
            self.approval_policy = settings.approval_policy.clone();
            self.sandbox = settings.sandbox.clone();
            self.reasoning_effort = settings.reasoning_effort.clone();
            self.model = settings.model.clone();
            self.thread_settings.entry(thread_id).or_insert(settings);
        }
        self.thread_forked_from = persisted.thread_forked_from.clone();
        self.thread_promoted_from = persisted.thread_promoted_from.clone();
        self.projects = persisted.projects.clone();
        self.thread_project_id = persisted.thread_project_id.clone();
        self.thread_custom_name = persisted.thread_custom_name.clone();
        self.projects_revision = persisted.projects_revision;
        // Normalize: a state file written before `projects_revision` existed restores
        // it as 0 while carrying projects; a fresh client (also 0) would then never
        // fetch them. Advertise a nonzero revision whenever project data is present.
        if self.projects_revision == 0
            && (!self.projects.is_empty() || !self.thread_project_id.is_empty())
        {
            self.projects_revision = 1;
        }
        self.allowed_roots = persisted.allowed_roots.clone();
        self.device_records = persisted.device_records.clone();
        self.paired_devices = persisted.paired_devices.clone();
        self.push_subscriptions = persisted.push_subscriptions.clone();
        self.prune_orphaned_push_subscriptions();
        // Durable reviewer-thread identity + completed (terminal) review-job cards
        // survive restart. The writer only persists terminal jobs, and we re-apply the
        // same filter here (defense-in-depth): a non-terminal job from a corrupt or
        // future-build snapshot must never be restored, or it would re-lock its parent
        // with no orchestrator left to release it.
        self.reviewer_threads = persisted.reviewer_threads.clone();
        self.review_jobs = persisted
            .review_jobs
            .iter()
            .filter(|(_, job)| job.status.is_terminal())
            .map(|(id, job)| (id.clone(), job.clone()))
            .collect();
        // Workflow runs persist NON-terminal too; reconcile any stranded run to the
        // terminal `Interrupted` here — no orchestrator survives a restart (see
        // workflow.rs / `restored_workflow_jobs`).
        self.workflow_jobs = Self::restored_workflow_jobs(&persisted.workflow_jobs);
        self.recompute_reviewer_thread_seq();
        self.online_surface_peer_ids.clear();
        self.online_surface_peer_devices.clear();
        self.backfill_device_records_from_paired_devices();
        self.pending_pairings.clear();
        self.pending_pairing_requests.clear();
        self.completed_pairings.clear();
        self.pending_broker_messages.clear();
        self.pending_approvals.clear();
        self.pending_ask_user_questions.clear();
        self.recent_remote_actions.clear();
        self.locally_deleted_thread_ids.clear();
        self.runtimes.clear();
    }

    pub fn clear_active_session(&mut self) {
        if let Some(thread_id) = self.active_thread_id.clone() {
            self.runtimes.remove(&thread_id);
        }
        self.active_thread_id = None;
        self.active_controller_device_id = None;
        self.active_controller_last_seen_at = None;
        self.active_turn_id = None;
        self.current_status = "idle".to_string();
        self.current_phase = None;
        self.current_tool = None;
        self.last_progress_at = None;
        self.active_flags.clear();
        self.transcript_revision = 0;
        self.transcript.clear();
        self.apply_states.clear();
        self.pending_approvals.clear();
        self.pending_ask_user_questions.clear();
    }

    /// Worker emitted a real event or a progress_tick. `phase` and `tool`
    /// are advisory; pass None to leave them unchanged.
    pub fn touch_progress(&mut self, phase: Option<&str>, tool: Option<&str>) {
        if let Some(thread_id) = self.active_thread_id.clone() {
            self.touch_thread_progress(&thread_id, phase, tool);
        } else {
            self.last_progress_at = Some(unix_now());
            if let Some(p) = phase {
                self.current_phase = Some(p.to_string());
            }
            if let Some(t) = tool {
                self.current_tool = Some(t.to_string());
            }
        }
    }

    pub fn touch_thread_progress(
        &mut self,
        thread_id: &str,
        phase: Option<&str>,
        tool: Option<&str>,
    ) {
        let now = unix_now();
        let runtime = self.ensure_runtime_for_thread(thread_id);
        runtime.last_progress_at = Some(now);
        runtime.liveness_timed_out = false;
        runtime.liveness_stop_requested = false;
        runtime.touch(now);
        if let Some(p) = phase {
            runtime.current_phase = Some(p.to_string());
        }
        if let Some(t) = tool {
            runtime.current_tool = Some(t.to_string());
        }
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
    }

    pub fn clear_progress(&mut self) {
        if let Some(thread_id) = self.active_thread_id.clone() {
            self.clear_thread_progress(&thread_id);
        } else {
            self.current_phase = None;
            self.current_tool = None;
            self.last_progress_at = None;
        }
    }

    pub fn clear_thread_progress(&mut self, thread_id: &str) {
        let runtime = self.ensure_runtime_for_thread(thread_id);
        runtime.current_phase = None;
        runtime.current_tool = None;
        runtime.last_progress_at = None;
        runtime.liveness_timed_out = false;
        runtime.liveness_stop_requested = false;
        runtime.touch(unix_now());
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
    }

    pub(super) fn assign_active_controller(&mut self, device_id: &str, now: u64) -> bool {
        let changed = self.active_controller_device_id.as_deref() != Some(device_id)
            || self.active_controller_last_seen_at != Some(now);
        self.active_controller_device_id = Some(device_id.to_string());
        self.active_controller_last_seen_at = Some(now);
        changed
    }

    fn backfill_device_records_from_paired_devices(&mut self) {
        for device in self.paired_devices.values() {
            self.device_records
                .entry(device.device_id.clone())
                .or_insert_with(|| DeviceRecord::approved_from(device));
        }
    }

    pub fn broker_targets(&self) -> Vec<(String, String, String)> {
        self.online_surface_peer_ids
            .iter()
            .filter_map(|peer_id| {
                let device_id = self.online_surface_peer_devices.get(peer_id)?;
                let device = self.paired_devices.get(device_id)?;
                Some((
                    device.device_id.clone(),
                    peer_id.clone(),
                    device.payload_secret.clone(),
                ))
            })
            .collect()
    }

    /// Broker targets narrowed to the devices watching `thread_id`. This is what makes
    /// "stream every thread" affordable: without it, opening N background threads on
    /// one phone would fan every thread's deltas out to every other paired surface.
    pub fn broker_targets_for_thread(&self, thread_id: &str) -> Vec<(String, String, String)> {
        self.broker_targets()
            .into_iter()
            .filter(|(device_id, peer_id, _)| {
                // Filter by the PEER's own declaration, not the device's union: two tabs
                // on one phone are two peers, and sending each of them both tabs' threads
                // defeats the point of declaring. Permission is still device-level —
                // surface_watches_thread re-checks scope via the surface's device.
                if self.watched_threads.contains_key(peer_id) {
                    return self.surface_watches_thread(peer_id, thread_id);
                }
                // Peer has not declared (an older client). Its fallback must be
                // INDEPENDENT — the active thread, subject to the current ACL. Using the
                // device-level answer would union in whatever a NEWER tab on the same
                // device declared, so that tab opening a background thread would both
                // push B at the legacy tab and stop sending it the active thread A it is
                // actually rendering — i.e. its live tail would just stop.
                self.active_thread_id.as_deref() == Some(thread_id)
                    && self.thread_is_readable_by_device(thread_id, device_id)
            })
            .collect()
    }

    pub fn set_allowed_roots(&mut self, allowed_roots: Vec<String>) -> bool {
        if self.allowed_roots == allowed_roots {
            return false;
        }
        self.allowed_roots = allowed_roots;
        true
    }

    pub fn reserve_remote_action(
        &mut self,
        device_id: &str,
        action_id: &str,
        action_kind: &str,
        now: u64,
    ) -> Result<RemoteActionReplayDecision, String> {
        self.prune_remote_action_replays(now);
        let key = remote_action_cache_key(device_id, action_id);
        let Some(entry) = self.recent_remote_actions.get(&key) else {
            self.recent_remote_actions.insert(
                key,
                CachedRemoteActionState::InFlight {
                    action_kind: action_kind.to_string(),
                    seen_at: now,
                },
            );
            return Ok(RemoteActionReplayDecision::Execute);
        };

        match entry {
            CachedRemoteActionState::InFlight {
                action_kind: existing_kind,
                ..
            } => {
                if existing_kind != action_kind {
                    return Err(
                        "action_id is already in use for a different remote action".to_string()
                    );
                }
                Ok(RemoteActionReplayDecision::InFlight)
            }
            CachedRemoteActionState::Completed { result, .. } => {
                if result.action_kind != action_kind {
                    return Err(
                        "action_id has already been used for a different remote action".to_string(),
                    );
                }
                Ok(RemoteActionReplayDecision::Replay(result.clone()))
            }
        }
    }

    pub fn store_remote_action_result(
        &mut self,
        device_id: &str,
        action_id: &str,
        result: CachedRemoteActionResult,
        now: u64,
    ) {
        self.prune_remote_action_replays(now);
        self.recent_remote_actions.insert(
            remote_action_cache_key(device_id, action_id),
            CachedRemoteActionState::Completed {
                result,
                seen_at: now,
            },
        );
        self.trim_remote_action_replays();
    }

    fn prune_remote_action_replays(&mut self, now: u64) {
        self.recent_remote_actions.retain(|_, entry| match entry {
            CachedRemoteActionState::InFlight { seen_at, .. }
            | CachedRemoteActionState::Completed { seen_at, .. } => {
                seen_at.saturating_add(REMOTE_ACTION_REPLAY_TTL_SECS) > now
            }
        });
    }

    fn trim_remote_action_replays(&mut self) {
        if self.recent_remote_actions.len() <= MAX_REMOTE_ACTION_REPLAY_ENTRIES {
            return;
        }

        let mut overflow = self.recent_remote_actions.len() - MAX_REMOTE_ACTION_REPLAY_ENTRIES;
        let mut entries = self
            .recent_remote_actions
            .iter()
            .map(|(key, entry)| {
                let seen_at = match entry {
                    CachedRemoteActionState::InFlight { seen_at, .. }
                    | CachedRemoteActionState::Completed { seen_at, .. } => *seen_at,
                };
                (key.clone(), seen_at)
            })
            .collect::<Vec<_>>();
        entries.sort_by_key(|(_, seen_at)| *seen_at);
        for (key, _) in entries {
            if overflow == 0 {
                break;
            }
            if self.recent_remote_actions.remove(&key).is_some() {
                overflow -= 1;
            }
        }
    }
}

fn device_state_sort_key(state: crate::protocol::DeviceLifecycleState) -> u8 {
    match state {
        crate::protocol::DeviceLifecycleState::Pending => 0,
        crate::protocol::DeviceLifecycleState::Approved => 1,
        crate::protocol::DeviceLifecycleState::Rejected => 2,
        crate::protocol::DeviceLifecycleState::Revoked => 3,
    }
}

fn remote_action_cache_key(device_id: &str, action_id: &str) -> String {
    format!("{device_id}:{action_id}")
}

#[cfg(test)]
mod tests {
    use super::{
        BrokerPendingMessage, PendingPairingResult, PendingTranscriptDelta, PersistedRelayState,
        RelayState, ReviewJob, SecurityProfile, TranscriptDeltaKind, WorkflowRun,
        MAX_WORKFLOW_RUNS,
    };
    use crate::protocol::ThreadSummaryView;
    use crate::state::{ReviewMode, RunStatus};
    use std::collections::HashMap;
    use tokio::sync::watch;

    fn test_relay() -> RelayState {
        let (tx, _rx) = watch::channel(0_u64);
        RelayState::new("/tmp/project".to_string(), tx, SecurityProfile::private())
    }

    fn dummy_delta() -> BrokerPendingMessage {
        BrokerPendingMessage::TranscriptDelta(PendingTranscriptDelta {
            thread_id: "t1".to_string(),
            base_revision: 0,
            revision: 1,
            entry_seq: 0,
            server_time: 0,
            item_id: "i1".to_string(),
            turn_id: None,
            delta: "x".to_string(),
            kind: TranscriptDeltaKind::AgentText,
            text_offset: None,
        })
    }

    fn dummy_pairing() -> BrokerPendingMessage {
        BrokerPendingMessage::PairingResult(PendingPairingResult {
            pairing_id: "p1".to_string(),
            target_peer_id: "peer".to_string(),
            pairing_secret: "s".to_string(),
            device: None,
            payload_secret: None,
            relay_id: None,
            relay_label: None,
            client_id: None,
            client_refresh_token: None,
            device_refresh_token: None,
            device_join_ticket: None,
            device_join_ticket_expires_at: None,
            error: None,
        })
    }

    // A local-only relay (no broker) must not accumulate transcript deltas: nothing
    // ever drains them, so they are dropped at enqueue instead of leaking memory.
    #[test]
    fn local_only_relay_drops_transcript_deltas() {
        let mut relay = test_relay();
        assert!(
            !relay.broker_configured,
            "test relay defaults to local-only"
        );
        for _ in 0..1000 {
            relay.queue_broker_message(dummy_delta());
        }
        assert_eq!(
            relay.pending_broker_messages.len(),
            0,
            "no broker configured → transcript deltas must not accumulate"
        );
    }

    // With a broker configured, deltas are retained for the publisher, but the
    // backlog is capped so a long broker outage can't grow memory without bound.
    #[test]
    fn configured_relay_retains_but_bounds_transcript_deltas() {
        let mut relay = test_relay();
        relay.broker_configured = true;
        for _ in 0..5000 {
            relay.queue_broker_message(dummy_delta());
        }
        assert_eq!(
            relay.pending_broker_messages.len(),
            4096,
            "a configured broker retains deltas but caps the backlog"
        );
    }

    // Pairing results have their own retention semantics and are never dropped,
    // even with no broker configured.
    #[test]
    fn pairing_results_are_never_dropped() {
        let mut relay = test_relay();
        assert!(!relay.broker_configured);
        relay.queue_broker_message(dummy_pairing());
        assert_eq!(
            relay.pending_broker_messages.len(),
            1,
            "pairing results are kept regardless of broker configuration"
        );
    }

    // When the delta cap evicts the oldest deltas, an interleaved pairing result
    // must survive — eviction only removes TranscriptDelta entries.
    #[test]
    fn delta_eviction_preserves_interleaved_pairing_results() {
        let mut relay = test_relay();
        relay.broker_configured = true;
        relay.queue_broker_message(dummy_pairing());
        for _ in 0..5000 {
            relay.queue_broker_message(dummy_delta());
        }
        let pairings = relay
            .pending_broker_messages
            .iter()
            .filter(|m| matches!(m, BrokerPendingMessage::PairingResult(_)))
            .count();
        let deltas = relay
            .pending_broker_messages
            .iter()
            .filter(|m| matches!(m, BrokerPendingMessage::TranscriptDelta(_)))
            .count();
        assert_eq!(pairings, 1, "pairing result must survive delta eviction");
        assert_eq!(deltas, 4096, "deltas are capped at the bound");
    }

    #[test]
    fn stale_turn_liveness_enqueues_error_push() {
        let (push_tx, mut push_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut relay = test_relay();
        relay.set_push_runtime(push_tx, "test-key".to_string());
        relay.active_thread_id = Some("t1".to_string());
        relay.set_thread_status("t1", "active".to_string(), Vec::new());
        relay.set_active_turn(Some("turn-1".to_string()));
        // Advance well past the no-progress timeout so the watchdog trips.
        let now = super::unix_now() + super::STALE_TURN_PROGRESS_TIMEOUT_SECS + 60;
        let expired = relay.expire_stale_turn_liveness(now);
        assert_eq!(expired, vec!["t1".to_string()]);
        let job = push_rx
            .try_recv()
            .expect("a stalled turn must enqueue a push");
        assert_eq!(job.kind, super::PushKind::Error);
        assert_eq!(job.thread_id, "t1");
    }

    #[test]
    fn unregister_push_subscription_is_scoped_to_the_device() {
        let mut relay = test_relay();
        let sub = |endpoint: &str, device: &str| super::PushSubscription {
            endpoint: endpoint.to_string(),
            p256dh: "p".to_string(),
            auth: "a".to_string(),
            device_id: device.to_string(),
            created_at: 0,
        };
        relay.push_subscriptions.insert(
            "deviceA".to_string(),
            vec![sub("https://push/A", "deviceA")],
        );
        relay.push_subscriptions.insert(
            "deviceB".to_string(),
            vec![sub("https://push/B", "deviceB")],
        );
        // deviceB must not be able to unregister deviceA's endpoint.
        relay.unregister_push_subscription("deviceB", "https://push/A");
        assert!(
            relay.push_subscriptions.contains_key("deviceA"),
            "A's subscription must survive B's cross-device unregister"
        );
        // deviceA can unregister its own.
        relay.unregister_push_subscription("deviceA", "https://push/A");
        assert!(!relay.push_subscriptions.contains_key("deviceA"));
    }

    fn run_with_status(id: &str, status: RunStatus) -> WorkflowRun {
        let mut run = WorkflowRun::new(
            id.to_string(),
            "wf".to_string(),
            "parent".to_string(),
            "anchor".to_string(),
            "/tmp/project".to_string(),
            "device".to_string(),
        );
        run.set_status(status);
        run
    }

    fn test_thread(id: &str, cwd: &str) -> ThreadSummaryView {
        ThreadSummaryView {
            id: id.to_string(),
            name: None,
            preview: id.to_string(),
            cwd: cwd.to_string(),
            updated_at: 0,
            source: "fake".to_string(),
            status: "idle".to_string(),
            model_provider: "fake".to_string(),
            provider: "fake".to_string(),
            forked_from: None,
            renamed: false,
        }
    }

    #[test]
    fn workflow_run_view_exposes_same_cwd_locked_threads() {
        let mut relay = test_relay();
        relay.threads = vec![
            test_thread("parent", "/tmp/project"),
            test_thread("same-cwd", "/tmp/project"),
            test_thread("other-cwd", "/tmp/other"),
        ];
        relay.insert_workflow_run(run_with_status("running", RunStatus::Running));

        let view = relay
            .active_workflow_runs_view()
            .into_iter()
            .find(|run| run.id == "running")
            .expect("running workflow view");
        assert!(view.locked_thread_ids.contains(&"parent".to_string()));
        assert!(view.locked_thread_ids.contains(&"same-cwd".to_string()));
        assert!(!view.locked_thread_ids.contains(&"other-cwd".to_string()));
        let activity = relay.workflow_activity_view();
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].id, "running");
        assert!(activity[0]
            .locked_thread_ids
            .contains(&"same-cwd".to_string()));

        relay.insert_workflow_run(run_with_status("done", RunStatus::Done));
        let done = relay
            .active_workflow_runs_view()
            .into_iter()
            .find(|run| run.id == "done")
            .expect("terminal workflow view");
        assert!(
            done.locked_thread_ids.is_empty(),
            "terminal runs should not publish live lock metadata"
        );
        assert!(
            relay
                .workflow_activity_view()
                .iter()
                .all(|run| run.id != "done"),
            "terminal workflow cards stay on the dedicated channel, not the gating projection"
        );
    }

    #[test]
    fn workflow_activity_bounds_same_cwd_locks_and_prioritizes_active_thread() {
        let mut relay = test_relay();
        relay.threads = (0..500)
            .map(|index| test_thread(&format!("same-cwd-{index:03}"), "/tmp/project"))
            .chain(std::iter::once(test_thread("parent", "/tmp/project")))
            .collect();
        relay.active_thread_id = Some("same-cwd-499".to_string());
        relay.insert_workflow_run(run_with_status("running", RunStatus::Running));

        let full = relay
            .active_workflow_runs_view()
            .into_iter()
            .find(|run| run.id == "running")
            .expect("full workflow view");
        assert!(
            full.locked_thread_ids.len() > 500,
            "the dedicated workflow channel retains the complete lock set"
        );

        let activity = relay.workflow_activity_view();
        assert_eq!(activity.len(), 1);
        assert!(
            activity[0].locked_thread_ids.len()
                <= crate::protocol::MAX_WORKFLOW_ACTIVITY_LOCKED_THREAD_IDS
        );
        assert!(activity[0]
            .locked_thread_ids
            .contains(&"parent".to_string()));
        assert!(
            activity[0]
                .locked_thread_ids
                .contains(&"same-cwd-499".to_string()),
            "the currently rendered thread must survive the bounded live projection"
        );
    }

    #[test]
    fn review_activity_bounds_concurrent_jobs_and_prioritizes_active_thread() {
        let mut relay = test_relay();
        relay.active_thread_id = Some("parent-63".to_string());
        for index in 0..64 {
            let mut job = ReviewJob::new(
                format!("review-{index:02}"),
                format!("parent-{index:02}"),
                "codex".to_string(),
                "codex".to_string(),
                None,
                ReviewMode::CleanThread,
                "/tmp/project".to_string(),
                "device".to_string(),
                None,
                1,
            );
            job.reviewer_thread_id = Some(format!("reviewer-{index:02}"));
            relay.insert_review_job(job);
        }

        let activity = relay.review_activity_view();
        let (total, blocked) = relay.review_activity_summary();
        assert_eq!(total, 64);
        assert!(!blocked);
        assert!(
            activity.len() <= crate::protocol::MAX_REVIEW_ACTIVITY_JOBS,
            "the full concurrent set belongs on the Reviews channel"
        );
        assert!(
            activity
                .iter()
                .any(|job| job.parent_thread_id == "parent-63"),
            "the active thread's exact lock identity must survive the bounded projection"
        );
    }

    #[test]
    fn restore_reconciles_non_terminal_workflow_runs() {
        // A run persisted while non-terminal must come back terminal `Interrupted`
        // (no orchestrator survives a restart); a terminal run restores unchanged.
        // This is the persistence-boundary half of the restart-recovery design.
        let mut running = WorkflowRun::new(
            "r1".to_string(),
            "wf".to_string(),
            "parent".to_string(),
            "anchor".to_string(),
            "/tmp".to_string(),
            "device".to_string(),
        );
        running.set_status(RunStatus::Running);
        let mut done = WorkflowRun::new(
            "r2".to_string(),
            "wf".to_string(),
            "parent".to_string(),
            "anchor".to_string(),
            "/tmp".to_string(),
            "device".to_string(),
        );
        done.set_status(RunStatus::Done);

        let mut persisted = HashMap::new();
        persisted.insert("r1".to_string(), running);
        persisted.insert("r2".to_string(), done);

        // Round-trip through JSON to mirror the persistence layer, then restore.
        let json = serde_json::to_string(&persisted).expect("serialize runs");
        let decoded: HashMap<String, WorkflowRun> =
            serde_json::from_str(&json).expect("deserialize runs");
        let restored = RelayState::restored_workflow_jobs(&decoded);

        assert_eq!(restored["r1"].status, RunStatus::Interrupted);
        assert!(restored["r1"].error.is_some());
        assert_eq!(restored["r2"].status, RunStatus::Done);
        assert!(restored["r2"].error.is_none());
    }

    #[test]
    fn workflow_runs_persist_and_reconcile_end_to_end() {
        // The fuller round-trip the reviewers asked for: through
        // PersistedRelayState::from_relay (writer) and apply_persisted (restore),
        // not just the inner map. A non-terminal run survives persistence and comes
        // back Interrupted; a terminal run round-trips unchanged.
        let mut relay = test_relay();
        relay.insert_workflow_run(run_with_status("r1", RunStatus::Running));
        relay.insert_workflow_run(run_with_status("r2", RunStatus::Done));

        let persisted = PersistedRelayState::from_relay(&relay);
        assert_eq!(
            persisted.workflow_jobs.len(),
            2,
            "the writer persists non-terminal runs too (unlike review jobs)",
        );

        let mut restored = test_relay();
        restored.apply_persisted(&persisted);
        assert_eq!(
            restored.workflow_run("r1").unwrap().status,
            RunStatus::Interrupted,
        );
        assert!(restored.workflow_run("r1").unwrap().error.is_some());
        assert_eq!(restored.workflow_run("r2").unwrap().status, RunStatus::Done);
    }

    #[test]
    fn projects_persist_round_trip_and_pre_projects_files_still_load() {
        use crate::protocol::ProjectView;

        let mut relay = test_relay();
        relay.projects.insert(
            "proj_a".to_string(),
            ProjectView {
                id: "proj_a".to_string(),
                name: "Sealwire".to_string(),
                instructions: None,
            },
        );
        relay
            .thread_project_id
            .insert("thread-1".to_string(), "proj_a".to_string());

        // Writer carries the new fields.
        let persisted = PersistedRelayState::from_relay(&relay);
        assert_eq!(persisted.projects.len(), 1);

        // Restore preserves projects + membership, and the accessors work.
        let mut restored = test_relay();
        restored.apply_persisted(&persisted);
        let project = restored
            .project_for_thread("thread-1")
            .expect("thread-1 maps to its project");
        assert_eq!(project.name, "Sealwire");
        assert!(restored.project_for_thread("unknown-thread").is_none());

        // Back-compat: a state file written before Projects (no keys) still loads,
        // with empty maps.
        let mut value = serde_json::to_value(&persisted).expect("serialize");
        let obj = value.as_object_mut().unwrap();
        obj.remove("projects");
        obj.remove("thread_project_id");
        let legacy: PersistedRelayState =
            serde_json::from_value(value).expect("pre-Projects state files must still load");
        assert!(legacy.projects.is_empty());
        assert!(legacy.thread_project_id.is_empty());
    }

    /// `ProjectView::workspace_bindings` was removed (a project is not bound to a
    /// cwd). State files written before that removal still carry the key, so this
    /// pins the one real risk of the deletion: they must load, not fail.
    #[test]
    fn state_files_carrying_the_removed_workspace_bindings_key_still_load() {
        let mut relay = test_relay();
        relay.projects.insert(
            "proj_a".to_string(),
            crate::protocol::ProjectView {
                id: "proj_a".to_string(),
                name: "Sealwire".to_string(),
                instructions: None,
            },
        );
        let persisted = PersistedRelayState::from_relay(&relay);

        // Re-insert the legacy key exactly as an older build wrote it.
        let mut value = serde_json::to_value(&persisted).expect("serialize");
        value
            .pointer_mut("/projects/proj_a")
            .and_then(serde_json::Value::as_object_mut)
            .expect("the persisted project is an object")
            .insert(
                "workspace_bindings".to_string(),
                serde_json::json!([{ "host_id": "LOCAL", "cwd": "/srv/sealwire" }]),
            );

        let legacy: PersistedRelayState = serde_json::from_value(value)
            .expect("state files with the removed workspace_bindings key must still load");
        assert_eq!(
            legacy
                .projects
                .get("proj_a")
                .map(|project| project.name.as_str()),
            Some("Sealwire"),
        );
    }

    #[test]
    fn persisted_projects_restore_a_nonzero_revision_for_fresh_clients() {
        use crate::protocol::ProjectView;
        let mut relay = test_relay();
        relay.projects.insert(
            "proj_a".to_string(),
            ProjectView {
                id: "proj_a".to_string(),
                name: "P".to_string(),
                instructions: None,
            },
        );
        relay.bump_projects_revision(); // as a real mutation does
        assert!(relay.projects_revision > 0);

        let persisted = PersistedRelayState::from_relay(&relay);
        let mut restored = test_relay();
        restored.apply_persisted(&persisted);

        // Restored nonzero, and the snapshot advertises it — so a fresh client (which
        // starts at revision 0) sees a mismatch and fetches the persisted projects,
        // instead of matching 0 and leaving them invisible until the next mutation.
        assert_eq!(restored.projects_revision, relay.projects_revision);
        assert!(restored.projects_revision > 0);
        assert_eq!(
            restored.snapshot().projects_revision,
            restored.projects_revision
        );
    }

    #[test]
    fn promotion_moves_project_membership_to_the_real_id() {
        let mut relay = test_relay();
        relay.create_project("proj_x".to_string(), "P".to_string());
        relay
            .assign_thread_to_project("claude-pending-1", "proj_x")
            .unwrap();
        let rev_before = relay.projects_revision;

        relay.promote_background_thread("claude-pending-1", "real-1");

        assert!(
            relay.thread_project_id.get("claude-pending-1").is_none(),
            "the synthetic pending membership must not orphan"
        );
        assert_eq!(relay.project_for_thread("real-1").unwrap().id, "proj_x");
        assert!(
            relay.projects_revision > rev_before,
            "promotion that moves membership bumps the revision"
        );

        // Conflict: an assignment the real id ALREADY has is preserved.
        let mut relay = test_relay();
        relay.create_project("proj_x".to_string(), "X".to_string());
        relay.create_project("proj_y".to_string(), "Y".to_string());
        relay
            .assign_thread_to_project("claude-pending-2", "proj_x")
            .unwrap();
        relay.assign_thread_to_project("real-2", "proj_y").unwrap();
        relay.promote_background_thread("claude-pending-2", "real-2");
        assert_eq!(
            relay.project_for_thread("real-2").unwrap().id,
            "proj_y",
            "an existing real-id assignment wins over the pending one"
        );
        assert!(relay.thread_project_id.get("claude-pending-2").is_none());
    }

    /// A rename that did not survive a relay restart would be worse than no rename:
    /// the tab would silently snap back to whatever the agent last called the thread,
    /// which is the exact complaint the feature exists to fix. Also pins backward
    /// compatibility — a state file written before this map existed must still load.
    #[test]
    fn custom_thread_names_round_trip_through_persistence() {
        let mut source = test_relay();
        source.set_thread_custom_name("t1", Some("Auth work".to_string()));

        let persisted = PersistedRelayState::from_relay(&source);
        let mut restored = test_relay();
        restored.apply_persisted(&persisted);
        assert_eq!(
            restored.thread_custom_name("t1"),
            Some("Auth work".to_string()),
            "a rename must survive a relay restart"
        );

        // A pre-feature state file (field absent) loads with no overrides rather than
        // failing to parse — every other per-thread map takes the same `serde(default)`.
        let mut value = serde_json::to_value(&persisted).expect("serialize");
        value
            .as_object_mut()
            .unwrap()
            .remove("thread_custom_name")
            .expect("field should have been serialized");
        let legacy: PersistedRelayState =
            serde_json::from_value(value).expect("pre-rename state file must still load");
        assert!(legacy.thread_custom_name.is_empty());
    }

    /// A Claude session is renamable the moment it appears — it has a tab before it has
    /// a real SDK id. That rename is recorded against the synthetic `claude-pending-…`
    /// id, so the promotion on first send must carry it over, or the title reverts
    /// exactly when the user starts working and orphans a key in a PERSISTED map.
    #[test]
    fn promotion_carries_the_custom_name_to_the_real_thread_id() {
        let mut relay = test_relay();
        relay.set_thread_custom_name("claude-pending-1", Some("Auth work".to_string()));
        relay.promote_background_thread("claude-pending-1", "real-1");
        assert_eq!(
            relay.thread_custom_name("real-1"),
            Some("Auth work".to_string()),
            "a rename made before the first message must survive promotion"
        );
        assert!(
            relay.thread_custom_name("claude-pending-1").is_none(),
            "the pending key would otherwise orphan in a persisted map"
        );

        // Conflict: a name the real id ALREADY has wins, mirroring project membership.
        let mut relay = test_relay();
        relay.set_thread_custom_name("claude-pending-2", Some("Pending name".to_string()));
        relay.set_thread_custom_name("real-2", Some("Real name".to_string()));
        relay.promote_background_thread("claude-pending-2", "real-2");
        assert_eq!(
            relay.thread_custom_name("real-2"),
            Some("Real name".to_string())
        );
    }

    /// The cached rows are what `relay.threads` readers see between provider refreshes,
    /// so they have to track a rename immediately — and, on a RESET, must not keep
    /// showing the title the user just removed. The overlay is destructive (no shadow
    /// copy of the provider's title survives it), so clearing leaves `None` rather than
    /// a stale name; the provider refills it on the next list/event.
    #[test]
    fn renaming_updates_the_cached_row_and_clearing_does_not_leave_it_stale() {
        let mut relay = test_relay();
        relay.upsert_thread(ThreadSummaryView {
            id: "t1".to_string(),
            name: Some("Agent Title".to_string()),
            preview: "hello".to_string(),
            cwd: "/tmp/project".to_string(),
            updated_at: 1,
            source: "fake".to_string(),
            status: "idle".to_string(),
            model_provider: "fake".to_string(),
            provider: "fake".to_string(),
            forked_from: None,
            renamed: false,
        });

        relay.set_thread_custom_name("t1", Some("Auth work".to_string()));
        let cached = relay
            .threads
            .iter()
            .find(|thread| thread.id == "t1")
            .expect("cached row");
        assert_eq!(cached.name, Some("Auth work".to_string()));
        assert!(cached.renamed);

        relay.set_thread_custom_name("t1", None);
        let cached = relay
            .threads
            .iter()
            .find(|thread| thread.id == "t1")
            .expect("cached row");
        assert_eq!(
            cached.renamed, false,
            "a stale `renamed` would keep advertising the session as renamed"
        );
        assert_eq!(
            cached.name, None,
            "the removed title must not linger; the provider refills this"
        );
    }

    /// Removing a session — archived OR permanently deleted — must drop its override.
    ///
    /// The relay has no un-archive path, so a title left behind by archive could never be
    /// reached again: it would occupy a slot under the persisted cap forever and wait to
    /// be inherited by a reused id. Clearing on both is also what the other persisted
    /// per-thread maps in `remove_thread` (`thread_settings`, `thread_last_activity_at`)
    /// already do, so the title is not a special case.
    #[test]
    fn removing_a_session_clears_its_custom_name_on_archive_and_on_delete() {
        let mut relay = test_relay();
        relay.set_thread_custom_name("t1", Some("Auth work".to_string()));
        relay.set_thread_custom_name("t2", Some("Archived work".to_string()));

        relay.mark_thread_deleted("t1");
        assert!(relay.thread_custom_name("t1").is_none());

        // `remove_thread` is the shared archive path.
        relay.remove_thread("t2");
        assert!(
            relay.thread_custom_name("t2").is_none(),
            "an archived session's title has no way back, so it must not linger"
        );
    }

    #[test]
    fn permanent_deletion_bumps_revision_only_when_membership_changed() {
        let mut relay = test_relay();
        relay.create_project("proj_x".to_string(), "P".to_string());
        relay.assign_thread_to_project("t1", "proj_x").unwrap();

        // Deleting an ASSIGNED thread bumps the revision (membership changed) so
        // passive clients drop the stale mapping.
        let rev = relay.projects_revision;
        relay.mark_thread_deleted("t1");
        assert!(relay.projects_revision > rev);

        // Deleting an UNASSIGNED thread does not (no membership change).
        let rev = relay.projects_revision;
        relay.mark_thread_deleted("t-unassigned");
        assert_eq!(relay.projects_revision, rev);
    }

    #[test]
    fn restoring_pre_revision_projects_state_advertises_a_nonzero_revision() {
        use crate::protocol::ProjectView;
        let mut source = test_relay();
        source.projects.insert(
            "proj_a".to_string(),
            ProjectView {
                id: "proj_a".to_string(),
                name: "P".to_string(),
                instructions: None,
            },
        );
        source
            .thread_project_id
            .insert("t1".to_string(), "proj_a".to_string());

        // Simulate a state file written before `projects_revision` existed: it carries
        // projects but the field is absent (loads as 0).
        let persisted = PersistedRelayState::from_relay(&source);
        let mut value = serde_json::to_value(&persisted).expect("serialize");
        value.as_object_mut().unwrap().remove("projects_revision");
        let pre_revision: PersistedRelayState =
            serde_json::from_value(value).expect("pre-revision file loads");
        assert_eq!(pre_revision.projects_revision, 0);

        let mut restored = test_relay();
        restored.apply_persisted(&pre_revision);
        assert!(
            restored.projects_revision > 0,
            "restored projects must advertise a nonzero revision so fresh clients fetch"
        );
        assert_eq!(
            restored.snapshot().projects_revision,
            restored.projects_revision
        );
    }

    #[test]
    fn project_crud_mutators() {
        let mut relay = test_relay();

        // Create.
        let project = relay.create_project("proj_x".to_string(), "Sealwire".to_string());
        assert_eq!(project.name, "Sealwire");
        assert_eq!(relay.projects_view().len(), 1);

        // Assign a session; membership resolves via the accessor.
        relay.assign_thread_to_project("t1", "proj_x").unwrap();
        assert_eq!(relay.project_for_thread("t1").unwrap().id, "proj_x");

        // Assigning to a missing project errors and leaves membership untouched.
        assert!(relay.assign_thread_to_project("t2", "ghost").is_err());
        assert!(relay.project_for_thread("t2").is_none());

        // Rename.
        relay
            .rename_project("proj_x", "Renamed".to_string())
            .unwrap();
        assert_eq!(relay.projects.get("proj_x").unwrap().name, "Renamed");
        assert!(relay.rename_project("ghost", "x".to_string()).is_err());

        // Unassign → Unassigned; idempotent.
        assert!(relay.unassign_thread_from_project("t1"));
        assert!(relay.project_for_thread("t1").is_none());
        assert!(!relay.unassign_thread_from_project("t1"));

        // Delete drops the project AND unassigns its remaining members.
        relay.assign_thread_to_project("t3", "proj_x").unwrap();
        relay.delete_project("proj_x").unwrap();
        assert!(relay.projects_view().is_empty());
        assert!(
            relay.project_for_thread("t3").is_none(),
            "deleting a project falls its members back to Unassigned"
        );
        assert!(relay.delete_project("proj_x").is_err());
    }

    #[test]
    fn permanent_thread_deletion_clears_project_membership() {
        let mut relay = test_relay();
        relay.create_project("proj_x".to_string(), "P".to_string());
        relay.assign_thread_to_project("t1", "proj_x").unwrap();
        assert!(relay.project_for_thread("t1").is_some());

        // Permanent deletion clears the membership...
        relay.mark_thread_deleted("t1");
        assert!(
            relay.thread_project_id.get("t1").is_none(),
            "a permanently deleted session must not leave an orphan project membership"
        );

        // ...and the cleared state survives a persistence round-trip (no durable orphan).
        let persisted = PersistedRelayState::from_relay(&relay);
        let mut restored = test_relay();
        restored.apply_persisted(&persisted);
        assert!(restored.thread_project_id.get("t1").is_none());
    }

    #[test]
    fn assign_rejects_reviewer_threads() {
        let mut relay = test_relay();
        relay.create_project("proj_x".to_string(), "P".to_string());
        relay.register_reviewer_thread("reviewer-1".to_string(), "parent-1".to_string());
        assert!(relay
            .assign_thread_to_project("reviewer-1", "proj_x")
            .is_err());
        assert!(relay.project_for_thread("reviewer-1").is_none());
    }

    #[test]
    fn unloaded_ordinary_session_is_assignable() {
        // Intended leniency: membership is metadata, so an ordinary session id that
        // isn't in the in-memory thread list can still be assigned.
        let mut relay = test_relay();
        relay.create_project("proj_x".to_string(), "P".to_string());
        assert!(relay.threads.is_empty());
        assert!(relay
            .assign_thread_to_project("not-loaded", "proj_x")
            .is_ok());
        assert_eq!(relay.project_for_thread("not-loaded").unwrap().id, "proj_x");
    }

    #[test]
    fn project_action_input_deserializes_local_http_body() {
        use crate::protocol::{ProjectAction, ProjectActionInput};
        // The POST /api/projects body is a bare ProjectActionInput (internally-tagged
        // action, no wrapper). This locks the endpoint's wire contract.
        let create: ProjectActionInput = serde_json::from_value(serde_json::json!({
            "action": "create",
            "name": "Sealwire"
        }))
        .expect("create body parses");
        assert!(create.device_id.is_none());
        assert_eq!(
            create.action,
            ProjectAction::Create {
                name: "Sealwire".to_string()
            }
        );

        let assign: ProjectActionInput = serde_json::from_value(serde_json::json!({
            "action": "assign",
            "thread_id": "t1",
            "project_id": "proj_x"
        }))
        .expect("assign body parses");
        assert_eq!(
            assign.action,
            ProjectAction::Assign {
                thread_id: "t1".to_string(),
                project_id: "proj_x".to_string()
            }
        );
    }

    #[test]
    fn prune_caps_terminal_runs_but_never_evicts_non_terminal() {
        // Terminal runs are capped at MAX_WORKFLOW_RUNS (oldest evicted first).
        let mut relay = test_relay();
        for i in 0..=MAX_WORKFLOW_RUNS {
            relay.insert_workflow_run(run_with_status(&format!("t{i}"), RunStatus::Done));
        }
        assert_eq!(
            relay.workflow_jobs.len(),
            MAX_WORKFLOW_RUNS,
            "terminal runs are capped",
        );

        // When every retained run is non-terminal there is nothing evictable, so the
        // map exceeds the cap rather than dropping a still-recoverable run.
        let mut relay = test_relay();
        for i in 0..=MAX_WORKFLOW_RUNS {
            relay.insert_workflow_run(run_with_status(&format!("n{i}"), RunStatus::Running));
        }
        assert_eq!(
            relay.workflow_jobs.len(),
            MAX_WORKFLOW_RUNS + 1,
            "non-terminal runs are never auto-evicted",
        );
    }
}
