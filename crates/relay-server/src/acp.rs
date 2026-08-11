//! Generic ACP (Agent Client Protocol) provider bridge.
//!
//! ACP is a protocol, not a vendor: `cursor-agent acp` speaks it, and so do
//! several other agents. This bridge is therefore parameterized by binary name
//! and launch args rather than being a `CursorBridge`, so a second ACP agent is
//! a registry row rather than a second bridge.
//!
//! Transport is JSON-RPC 2.0 over stdio with newline framing and server→client
//! requests — the same shape as `codex app-server`, which is why the reader and
//! response-correlation plumbing mirrors `codex/rpc.rs`.
//!
//! Wire shapes here were measured against `cursor-agent 2026.08.04-aaa8809`;
//! see `markdown/cursor-acp-provider-plan.md`.

use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::{
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex, RwLock},
    time::{timeout, Duration},
};

use crate::{
    codex_local::LocalThreadDeleteSummary,
    protocol::{ApprovalDecisionInput, ModelOptionView, ThreadSummaryView, TranscriptEntryView},
    provider::{ProviderBridge, ProviderImage, StartThreadResult, ThreadSyncData},
    state::{PendingApproval, RelayState},
};

mod protocol;
mod rpc;

#[cfg(test)]
mod tests;

pub(crate) type PendingResponses =
    Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

/// The bridge's outbound pipe.
///
/// A trait object rather than `ChildStdin` so tests can drive the real request
/// and turn-lifecycle code over `tokio::io::duplex` instead of a real
/// `cursor-agent` — which is the only way to exercise send failures and stream
/// death, neither of which a live agent can be asked to produce on cue.
pub(crate) type Outbound = Arc<Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>>;
pub(crate) type Inbound = Box<dyn tokio::io::AsyncRead + Send + Unpin>;

const ACP_REQUEST_TIMEOUT_SECS: u64 = 60;
/// `session/prompt` runs for as long as the agent works, so it gets no deadline
/// from the request layer — the turn ends when the agent says it does, or when
/// the stream dies.
const ACP_PROMPT_TIMEOUT_SECS: u64 = 60 * 60;
/// Backstop on `session/list` pagination so an agent that always hands back a
/// cursor cannot spin the bridge forever.
const MAX_LIST_PAGES: usize = 50;

/// Per-session bookkeeping the stdout reader needs in order to translate
/// events. Keyed by ACP `sessionId`, which is also the relay thread id.
#[derive(Debug, Default)]
pub(crate) struct SessionRuntime {
    pub(crate) cwd: String,
    pub(crate) approval_policy: String,
    /// The ACP model id this session is currently configured with.
    ///
    /// ACP models are *session* config (`session/set_model`), not a per-turn
    /// argument the way `ProviderBridge::start_turn` passes them — so the bridge
    /// tracks the session's model and pushes a change only when the relay's
    /// selection actually differs.
    pub(crate) model: String,
    /// The turn the relay minted for the in-flight `session/prompt`. ACP has no
    /// turn concept of its own — a prompt is one request/response — so turn ids
    /// are relay-owned.
    pub(crate) turn_id: Option<String>,
    /// Per-kind ordinal counters backing `protocol::item_id`. Ordinals are used
    /// instead of ACP's own ids because a live `toolCallId` embeds a raw newline
    /// and `session/load` reassigns ids on replay; see `protocol::item_id`.
    pub(crate) ordinals: HashMap<&'static str, u64>,
    /// ACP `toolCallId` → the stable relay item id minted for it.
    pub(crate) tool_items: HashMap<String, String>,
    /// Accumulated view of each tool call, keyed by the minted item id.
    ///
    /// ACP tool updates are *partial*: `tool_call` carries the title and input,
    /// `tool_call_update` carries only the id, status and output. Emitting one
    /// event's fields alone would blank out whatever the other event supplied,
    /// so the merge happens here — where the session state lives — and every
    /// emitted op is a complete snapshot.
    pub(crate) tool_meta: HashMap<String, ToolMeta>,
    /// The open agent message, if one is streaming.
    pub(crate) agent_item: Option<String>,
    pub(crate) agent_text: String,
    /// The open reasoning entry, if one is streaming.
    pub(crate) thought_item: Option<String>,
    pub(crate) thought_text: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ToolMeta {
    pub(crate) title: String,
    pub(crate) command: Option<String>,
    pub(crate) output: Option<String>,
    /// Last status the agent actually reported.
    ///
    /// Held here rather than recomputed per event because ACP allows every
    /// field but `toolCallId` to be omitted from a `tool_call_update` — so a
    /// trailing content-only update would otherwise read as "no status" and
    /// regress a finished tool back to pending.
    pub(crate) status: String,
}

impl Default for ToolMeta {
    fn default() -> Self {
        Self {
            title: String::new(),
            command: None,
            output: None,
            status: "pending".to_string(),
        }
    }
}

impl SessionRuntime {
    pub(crate) fn next_item_id(&mut self, kind: &'static str) -> String {
        let counter = self.ordinals.entry(kind).or_insert(0);
        *counter += 1;
        protocol::item_id(kind, *counter)
    }

    /// The model id to push to the agent, or `None` if nothing needs sending.
    ///
    /// Placeholders are not selections: the relay passes `""` (and codex's
    /// literal `"default"`) to mean "whatever the provider picks", and forwarding
    /// those as a model id would either be rejected or accepted as a bogus model.
    pub(crate) fn model_change_needed(&self, requested: &str) -> Option<String> {
        if requested.is_empty() || requested == "default" || requested == self.model {
            return None;
        }
        Some(requested.to_string())
    }

    /// Whether it is safe to run a `session/load` replay through this session.
    ///
    /// A replay renumbers items from the start, and the counters are shared with
    /// whatever turn is streaming — so replaying under a live turn makes the
    /// turn resume minting `acp-msg-1` on top of the ids the replay just
    /// produced, overwriting settled entries. Losing the tail of a turn would be
    /// bad; corrupting the history behind it is worse.
    pub(crate) fn can_replay_into(&self) -> bool {
        self.turn_id.is_none()
    }

    /// Clear transcript numbering ahead of a replay, keeping the session
    /// identity (cwd, policy, model) that outlives any single transcript.
    pub(crate) fn reset_for_replay(&mut self) {
        self.close_streams();
        self.ordinals.clear();
        self.tool_items.clear();
        self.tool_meta.clear();
    }

    /// Drop the streaming cursors so the next chunk opens a fresh entry. Called
    /// at turn boundaries and before a replay.
    pub(crate) fn close_streams(&mut self) {
        self.agent_item = None;
        self.agent_text.clear();
        self.thought_item = None;
        self.thought_text.clear();
    }
}

pub(crate) type Sessions = Arc<Mutex<HashMap<String, SessionRuntime>>>;

/// Transcript captured out of a `session/load` replay instead of being applied
/// to `RelayState`.
///
/// `session/load` answers by replaying the whole conversation as `session/update`
/// notifications and only then returning — but `read_thread` has to *return* a
/// transcript rather than mutate live state. Installing a capture for the
/// session id redirects the replay into a buffer.
pub(crate) type Captures = Arc<Mutex<HashMap<String, Vec<TranscriptEntryView>>>>;

pub struct AcpBridge {
    /// `None` in tests, where the peer is an in-memory duplex rather than a
    /// process.
    _child: Option<Arc<Mutex<Child>>>,
    stdin: Outbound,
    pending_responses: PendingResponses,
    next_request_id: AtomicU64,
    next_turn_id: AtomicU64,
    state: Arc<RwLock<RelayState>>,
    provider_name: &'static str,
    display_name: &'static str,
    sessions: Sessions,
    captures: Captures,
    /// Catalog captured from the first `session/new`, which returns the full
    /// model list — ACP has no standalone catalog method.
    models: Arc<Mutex<Vec<ModelOptionView>>>,
    /// One lock per session, held across a `session/load`.
    ///
    /// A replay is a session-wide side effect on a shared notification channel,
    /// so two of them at once would overwrite each other's capture buffer and
    /// spill replayed events into live state.
    load_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    /// What the agent advertised at `initialize`. ACP makes session load, list
    /// and image prompts optional and requires clients to check first.
    capabilities: Arc<Mutex<protocol::AgentCapabilities>>,
    authenticated: AtomicBool,
}

impl AcpBridge {
    pub async fn spawn(
        state: Arc<RwLock<RelayState>>,
        binary_name: &'static str,
        launch_args: &'static [&'static str],
        display_name: &'static str,
        provider_key: &'static str,
    ) -> Result<Self, String> {
        let mut command = Command::new(binary_name);
        command
            .args(launch_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command.spawn().map_err(|error| {
            format!(
                "failed to start `{binary_name} {}`: {error}",
                launch_args.join(" ")
            )
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("failed to capture {binary_name} stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("failed to capture {binary_name} stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| format!("failed to capture {binary_name} stderr"))?;

        let child = Arc::new(Mutex::new(child));
        let pending_responses: PendingResponses = Arc::new(Mutex::new(HashMap::new()));
        let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
        let captures: Captures = Arc::new(Mutex::new(HashMap::new()));
        let stdin: Outbound = Arc::new(Mutex::new(Box::new(stdin)));

        rpc::spawn_stdout_reader(rpc::ReaderContext {
            stdout: Box::new(stdout),
            stdin: stdin.clone(),
            pending_responses: pending_responses.clone(),
            state: state.clone(),
            sessions: sessions.clone(),
            captures: captures.clone(),
            provider_key,
        });
        rpc::spawn_stderr_reader(stderr, state.clone(), provider_key);

        let bridge = Self {
            _child: Some(child),
            stdin,
            pending_responses,
            next_request_id: AtomicU64::new(1),
            next_turn_id: AtomicU64::new(1),
            state,
            provider_name: provider_key,
            display_name,
            sessions,
            captures,
            models: Arc::new(Mutex::new(read_cached_models(&models_cache_path(
                provider_key,
            )))),
            load_locks: Arc::new(Mutex::new(HashMap::new())),
            capabilities: Arc::new(Mutex::new(protocol::AgentCapabilities::default())),
            authenticated: AtomicBool::new(false),
        };

        bridge.initialize().await?;

        {
            let mut relay = bridge.state.write().await;
            relay.set_provider_connection(provider_key, true);
            relay.push_log("info", format!("Connected to {display_name} (ACP)."));
            relay.notify();
        }

        Ok(bridge)
    }

    /// Handshake, then authenticate if the agent advertises an auth method.
    ///
    /// A not-logged-in agent is a *live connection with no sessions*, not a
    /// spawn failure — the binary is installed and speaking. Treating it as a
    /// hard error would report the provider as `NotInstalled` and tell the user
    /// to install something they already have; instead the bridge connects and
    /// surfaces the login instruction, and session calls fail with the agent's
    /// own "Authentication required" text until `agent login` is run.
    async fn initialize(&self) -> Result<(), String> {
        let result = self
            .send_request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        // The agent does its own file and terminal IO; the relay
                        // is a transport, not an editor host.
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false
                    },
                    "clientInfo": {
                        "name": "agent-relay",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
            .await?;

        *self.capabilities.lock().await = protocol::AgentCapabilities::from_initialize(&result);

        let auth_methods = result
            .get("authMethods")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        if auth_methods.is_empty() {
            self.authenticated.store(true, Ordering::Relaxed);
            return Ok(());
        }

        let method_id = auth_methods
            .first()
            .and_then(|method| method.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        match self
            .send_request("authenticate", json!({ "methodId": method_id }))
            .await
        {
            Ok(_) => {
                self.authenticated.store(true, Ordering::Relaxed);
                Ok(())
            }
            Err(error) => {
                // Not fatal: connect anyway and tell the user what to run.
                let mut relay = self.state.write().await;
                relay.push_log(
                    self.provider_name,
                    format!(
                        "{} is not authenticated ({error}). Run `{} login`, then reconnect.",
                        self.display_name, self.provider_name
                    ),
                );
                relay.notify();
                Ok(())
            }
        }
    }

    pub(crate) async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.send_request_with_timeout(method, params, ACP_REQUEST_TIMEOUT_SECS)
            .await
    }

    async fn send_request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout_secs: u64,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let request_id_key = request_id.to_string();
        let (sender, receiver) = oneshot::channel();

        self.pending_responses
            .lock()
            .await
            .insert(request_id_key.clone(), sender);

        if let Err(error) = self
            .send_json(json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params,
            }))
            .await
        {
            self.pending_responses.lock().await.remove(&request_id_key);
            return Err(error);
        }

        match timeout(Duration::from_secs(timeout_secs), receiver).await {
            Ok(result) => result.map_err(|_| {
                format!(
                    "{} dropped the response channel for `{method}`",
                    self.display_name
                )
            })?,
            Err(_) => {
                self.pending_responses.lock().await.remove(&request_id_key);
                Err(format!(
                    "{} timed out waiting for `{method}`",
                    self.display_name
                ))
            }
        }
    }

    /// Fire a JSON-RPC notification (no id, no response expected).
    pub(crate) async fn send_notification(
        &self,
        method: &str,
        params: Value,
    ) -> Result<(), String> {
        self.send_json(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .await
    }

    async fn send_json(&self, value: Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        rpc::write_line(&mut **stdin, &value, self.display_name).await
    }

    fn mint_turn_id(&self) -> String {
        format!(
            "acp-turn-{}",
            self.next_turn_id.fetch_add(1, Ordering::Relaxed)
        )
    }

    /// Cache the model catalog that rides along on `session/new` / `session/load`.
    async fn absorb_catalog(&self, result: &Value) {
        let Some(models) = result.get("models") else {
            return;
        };
        let available = models
            .get("availableModels")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if available.is_empty() {
            return;
        }
        let current = models.get("currentModelId").and_then(Value::as_str);
        let options = protocol::model_options(&available, current, self.provider_name);
        write_cached_models(&models_cache_path(self.provider_name), &options);
        *self.models.lock().await = options;
    }

    /// The absolute cwd for a session, hydrating from `session/list` if the
    /// relay has not seen this session in this process.
    ///
    /// `session/load` requires an absolute cwd, and after a restart the session
    /// map is empty — so a cold thread has to recover its cwd from the listing
    /// rather than silently sending `""`, which loads an empty, path-scope
    /// invalid session.
    async fn resolve_cwd(&self, thread_id: &str) -> Result<String, String> {
        if let Some(cwd) = self
            .sessions
            .lock()
            .await
            .get(thread_id)
            .map(|session| session.cwd.clone())
            .filter(|cwd| !cwd.is_empty())
        {
            return Ok(cwd);
        }

        // Cold: refresh the listing, which caches every cwd it reports.
        self.list_threads(usize::MAX).await?;

        self.sessions
            .lock()
            .await
            .get(thread_id)
            .map(|session| session.cwd.clone())
            .filter(|cwd| !cwd.is_empty())
            .ok_or_else(|| {
                format!(
                    "{} did not report a working directory for session `{thread_id}`",
                    self.display_name
                )
            })
    }
}

impl AcpBridge {
    /// Build a bridge whose peer is an in-memory duplex instead of a process.
    ///
    /// Exists so the request/turn lifecycle can be driven against a scripted
    /// agent: send failures and stream death are the two paths a live
    /// `cursor-agent` cannot be asked to produce on demand, and they are exactly
    /// where a turn can be stranded.
    #[cfg(test)]
    pub(crate) fn for_test(
        state: Arc<RwLock<RelayState>>,
        outbound: impl tokio::io::AsyncWrite + Send + Unpin + 'static,
        inbound: impl tokio::io::AsyncRead + Send + Unpin + 'static,
        provider_key: &'static str,
    ) -> Self {
        let pending_responses: PendingResponses = Arc::new(Mutex::new(HashMap::new()));
        let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
        let captures: Captures = Arc::new(Mutex::new(HashMap::new()));
        let stdin: Outbound = Arc::new(Mutex::new(Box::new(outbound)));

        rpc::spawn_stdout_reader(rpc::ReaderContext {
            stdout: Box::new(inbound),
            stdin: stdin.clone(),
            pending_responses: pending_responses.clone(),
            state: state.clone(),
            sessions: sessions.clone(),
            captures: captures.clone(),
            provider_key,
        });

        Self {
            _child: None,
            stdin,
            pending_responses,
            next_request_id: AtomicU64::new(1),
            next_turn_id: AtomicU64::new(1),
            state,
            provider_name: provider_key,
            display_name: "TestAgent",
            sessions,
            captures,
            models: Arc::new(Mutex::new(Vec::new())),
            load_locks: Arc::new(Mutex::new(HashMap::new())),
            capabilities: Arc::new(Mutex::new(protocol::AgentCapabilities::default())),
            authenticated: AtomicBool::new(true),
        }
    }

    #[cfg(test)]
    pub(crate) async fn seed_session_for_test(&self, thread_id: &str, cwd: &str) {
        self.sessions.lock().await.insert(
            thread_id.to_string(),
            SessionRuntime {
                cwd: cwd.to_string(),
                approval_policy: "on-request".to_string(),
                ..Default::default()
            },
        );
    }

    #[cfg(test)]
    pub(crate) async fn session_turn_for_test(&self, thread_id: &str) -> Option<String> {
        self.sessions
            .lock()
            .await
            .get(thread_id)
            .and_then(|session| session.turn_id.clone())
    }

    async fn load_lock(&self, thread_id: &str) -> Arc<Mutex<()>> {
        self.load_locks
            .lock()
            .await
            .entry(thread_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Push the relay's model selection onto the session, if it differs.
    ///
    /// Measured: `session/set_model {sessionId, modelId}` is the method Cursor
    /// implements (`session/set_config` and `session/select_model` both answer
    /// "Method not found"). Failure is surfaced rather than swallowed — the
    /// relay records the selection as applied, so silently running a different
    /// model would make the UI lie about what answered.
    async fn apply_model(&self, thread_id: &str, model: &str) -> Result<(), String> {
        let Some(target) = self
            .sessions
            .lock()
            .await
            .get(thread_id)
            .map(|session| session.model_change_needed(model))
            .unwrap_or_else(|| SessionRuntime::default().model_change_needed(model))
        else {
            return Ok(());
        };

        // A model this agent does not offer is not a selection for it — the
        // relay's session defaults carry another provider's id until this
        // provider's picker has been populated. Skip rather than fail the turn.
        if !protocol::model_is_known(&self.models.lock().await, &target) {
            return Ok(());
        }

        self.send_request(
            "session/set_model",
            json!({ "sessionId": thread_id, "modelId": target }),
        )
        .await
        .map_err(|error| {
            format!(
                "{} could not switch `{thread_id}` to model `{target}`: {error}",
                self.display_name
            )
        })?;

        self.sessions
            .lock()
            .await
            .entry(thread_id.to_string())
            .or_default()
            .model = target;
        Ok(())
    }

    /// Put the session into the mode the relay's policy demands.
    ///
    /// Failing to *restrict* is fatal: the caller (a reviewer thread, a workflow
    /// step) is relying on the thread being read-only, and running it as a full
    /// agent instead would let it edit the very artifact it was asked to judge.
    /// Failing to *relax* is only an inconvenience, so it warns and continues.
    ///
    /// Note this is prompt/tool-level containment, not OS isolation — see the
    /// provider capability note in `state/app/review.rs`.
    async fn apply_mode(
        &self,
        thread_id: &str,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<(), String> {
        let mode = protocol::acp_mode_for_policy(approval_policy, sandbox);
        let outcome = self
            .send_request(
                "session/set_mode",
                json!({ "sessionId": thread_id, "modeId": mode }),
            )
            .await;

        match outcome {
            Ok(_) => Ok(()),
            Err(error) if mode == protocol::MODE_AGENT => {
                let mut relay = self.state.write().await;
                relay.push_log(
                    self.provider_name,
                    format!("Could not restore full agent mode on `{thread_id}`: {error}"),
                );
                relay.notify();
                Ok(())
            }
            Err(error) => Err(format!(
                "{} could not enter read-only `{mode}` mode for `{thread_id}` ({error}); \
                 refusing to start an unconfined session for a read-only request",
                self.display_name
            )),
        }
    }
}

/// Read a previously harvested model catalog.
///
/// ACP has no standalone catalog method — `availableModels` rides on
/// `session/new` — so a fresh process has nothing to show in the model picker
/// until the user has already created a thread. Caching the catalog moves that
/// empty window to the very first ACP session ever, instead of the first one
/// after every restart.
///
/// A missing or unreadable cache is *absence*, never an error: it degrades to
/// exactly the uncached behaviour, and a stale file must not block startup.
pub(crate) fn read_cached_models(path: &std::path::Path) -> Vec<ModelOptionView> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Persist the catalog harvested from `session/new`. Best-effort: a failed write
/// only costs the next process an empty picker.
pub(crate) fn write_cached_models(path: &std::path::Path, models: &[ModelOptionView]) {
    if models.is_empty() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(encoded) = serde_json::to_string(models) {
        let _ = std::fs::write(path, encoded);
    }
}

/// Where a provider's catalog cache lives — beside the relay's own state file.
pub(crate) fn models_cache_path(provider_key: &str) -> std::path::PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    crate::state_paths::state_dir(&cwd).join(format!("acp-models-{provider_key}.json"))
}

/// Seed session cwds from a `session/list` response.
///
/// Fills gaps only: a session the relay opened itself already knows its cwd
/// first-hand, and a listing must not overwrite that (or reset the approval
/// policy that rides on the same record).
pub(crate) fn absorb_thread_cwds(
    sessions: &mut HashMap<String, SessionRuntime>,
    threads: &[ThreadSummaryView],
) {
    for thread in threads {
        if thread.cwd.is_empty() {
            continue;
        }
        let entry = sessions.entry(thread.id.clone()).or_default();
        if entry.cwd.is_empty() {
            entry.cwd = thread.cwd.clone();
        }
    }
}

#[async_trait]
impl ProviderBridge for AcpBridge {
    async fn list_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
        // Optional in ACP. An agent without it simply has no history to offer;
        // the relay still drives sessions it starts itself, so this is an empty
        // list rather than an error.
        if !self.capabilities.lock().await.list_sessions {
            return Ok(Vec::new());
        }
        let now = crate::state::unix_now();
        let mut threads: Vec<ThreadSummaryView> = Vec::new();
        let mut cursor: Option<String> = None;

        // `session/list` is cursor-paginated. Stopping at the first page hides
        // later threads AND leaves their cwd uncached, so `resolve_cwd` cannot
        // reload them after a restart. Bounded so an agent that always hands
        // back a cursor cannot spin the bridge forever.
        for _ in 0..MAX_LIST_PAGES {
            let params = match &cursor {
                Some(cursor) => json!({ "cursor": cursor }),
                None => json!({}),
            };
            let result = self.send_request("session/list", params).await?;
            threads.extend(
                result
                    .get("sessions")
                    .and_then(Value::as_array)
                    .map(|sessions| {
                        sessions
                            .iter()
                            .filter_map(|session| {
                                protocol::thread_summary(session, self.provider_name, now)
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
            );
            match protocol::next_list_cursor(&result) {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        threads.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

        // Cache before truncating: a session outside the requested window still
        // needs its cwd on hand for a later `session/load`.
        absorb_thread_cwds(&mut *self.sessions.lock().await, &threads);

        threads.truncate(limit);
        Ok(threads)
    }

    async fn list_models(&self) -> Result<Vec<ModelOptionView>, String> {
        Ok(self.models.lock().await.clone())
    }

    async fn start_thread(
        &self,
        cwd: &str,
        model: &str,
        approval_policy: &str,
        sandbox: &str,
        _initial_prompt: Option<&str>,
    ) -> Result<StartThreadResult, String> {
        let result = self
            .send_request("session/new", json!({ "cwd": cwd, "mcpServers": [] }))
            .await?;

        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{} returned no sessionId", self.display_name))?
            .to_string();

        self.absorb_catalog(&result).await;

        self.sessions.lock().await.insert(
            session_id.clone(),
            SessionRuntime {
                cwd: cwd.to_string(),
                approval_policy: approval_policy.to_string(),
                // Whatever `session/new` chose, until the relay says otherwise.
                model: result
                    .get("models")
                    .and_then(|models| models.get("currentModelId"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                ..Default::default()
            },
        );

        self.apply_mode(&session_id, approval_policy, sandbox)
            .await?;
        self.apply_model(&session_id, model).await?;

        Ok(StartThreadResult {
            thread: ThreadSummaryView {
                id: session_id,
                name: None,
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: crate::state::unix_now(),
                source: self.provider_name.to_string(),
                status: "idle".to_string(),
                model_provider: self.provider_name.to_string(),
                provider: self.provider_name.to_string(),
                forked_from: None,
                renamed: false,
            },
            consumed_initial_prompt: false,
            initial_user_message: None,
            started_turn_id: None,
        })
    }

    async fn resume_thread(
        &self,
        thread_id: &str,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<(), String> {
        // Same lock as `read_thread`: two replays into one session would
        // overwrite each other's capture and leak replay events into live state.
        let lock = self.load_lock(thread_id).await;
        let _guard = lock.lock().await;

        // A resume is "re-attach, then apply policy". The re-attach is only
        // needed for a session this process is not already streaming. Replaying
        // one that IS streaming would swallow the live turn's updates into the
        // capture AND advance the shared item ordinals, so the next live id
        // would no longer match the id the same item gets on a cold read — the
        // fork anchors drift. Policy is applied either way.
        let needs_load = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(thread_id)
                .map(|session| session.can_replay_into())
                .unwrap_or(true)
        };

        if needs_load {
            let cwd = self.resolve_cwd(thread_id).await?;
            {
                // Reset before replaying, exactly as `read_thread` does: the
                // replay renumbers from 1, so the counters must start there or a
                // resumed thread's next live id drifts past the id the same item
                // gets on a cold read.
                let mut sessions = self.sessions.lock().await;
                let session = sessions.entry(thread_id.to_string()).or_default();
                session.reset_for_replay();
                if session.cwd.is_empty() {
                    session.cwd = cwd.clone();
                }
            }
            // A resume replays the whole conversation; capture and discard it so
            // it does not double-write the transcript the relay already holds.
            self.captures
                .lock()
                .await
                .insert(thread_id.to_string(), Vec::new());

            let result = self
                .send_request(
                    "session/load",
                    json!({ "sessionId": thread_id, "cwd": cwd, "mcpServers": [] }),
                )
                .await;

            self.captures.lock().await.remove(thread_id);
            let result = result?;
            self.absorb_catalog(&result).await;
        }

        // Unconditional: a resume that relaxes a thread from read-only back to
        // workspace-write has to move the session out of `plan`, and only
        // setting the non-default mode would strand it there forever.
        self.apply_mode(thread_id, approval_policy, sandbox).await?;

        let mut sessions = self.sessions.lock().await;
        sessions
            .entry(thread_id.to_string())
            .or_default()
            .approval_policy = approval_policy.to_string();
        Ok(())
    }

    async fn read_thread(&self, thread_id: &str) -> Result<ThreadSyncData, String> {
        // Codex and Claude both answer `read_thread` out of an RPC *response*,
        // so a read never disturbs the live event stream. ACP has no such
        // method — `session/load` answers by replaying over the same
        // notification channel a running turn is using — so the equivalent
        // guarantee has to be reconstructed here.
        //
        // While a turn is in flight, the relay's own runtime already holds this
        // session's complete transcript (the bridge wrote every event into it),
        // and every caller of `ThreadSyncData.transcript` either merges by item
        // id or prefers `runtime.transcript_views()` already. So serve that,
        // and leave the wire alone.
        let lock = self.load_lock(thread_id).await;
        let _guard = lock.lock().await;

        // Checked before the capability gate on purpose: serving the relay's own
        // runtime issues no `session/load`, so an agent without `loadSession`
        // can still have a streaming thread read.
        if let Some(data) =
            rpc::sync_data_from_runtime(&*self.state.read().await, thread_id, self.provider_name)
        {
            return Ok(data);
        }

        if !self.capabilities.lock().await.load_session {
            return Err(format!(
                "{} does not support loading a session, so its history cannot be read",
                self.display_name
            ));
        }

        let cwd = self.resolve_cwd(thread_id).await?;

        {
            let mut sessions = self.sessions.lock().await;
            let session = sessions.entry(thread_id.to_string()).or_default();
            if !session.can_replay_into() {
                return Err(format!(
                    "{} cannot reload `{thread_id}` while its turn is still running",
                    self.display_name
                ));
            }
            session.reset_for_replay();
        }
        self.captures
            .lock()
            .await
            .insert(thread_id.to_string(), Vec::new());

        let result = self
            .send_request(
                "session/load",
                json!({ "sessionId": thread_id, "cwd": cwd, "mcpServers": [] }),
            )
            .await;

        let transcript = self
            .captures
            .lock()
            .await
            .remove(thread_id)
            .unwrap_or_default();
        let result = result?;
        self.absorb_catalog(&result).await;

        let preview = transcript
            .iter()
            .rev()
            .find_map(|entry| entry.text.clone())
            .unwrap_or_default();

        Ok(ThreadSyncData {
            thread: ThreadSummaryView {
                id: thread_id.to_string(),
                name: None,
                preview,
                cwd,
                updated_at: crate::state::unix_now(),
                source: self.provider_name.to_string(),
                status: "idle".to_string(),
                model_provider: self.provider_name.to_string(),
                provider: self.provider_name.to_string(),
                forked_from: None,
                renamed: false,
            },
            status: "idle".to_string(),
            active_flags: Vec::new(),
            transcript,
        })
    }

    async fn read_thread_entry_detail(
        &self,
        thread_id: &str,
        item_id: &str,
    ) -> Result<Option<TranscriptEntryView>, String> {
        // ACP has no per-item read; the whole conversation is the unit. Reload
        // and pick the item out of the replay.
        let data = self.read_thread(thread_id).await?;
        Ok(data
            .transcript
            .into_iter()
            .find(|entry| entry.item_id.as_deref() == Some(item_id)))
    }

    async fn archive_thread(&self, _thread_id: &str) -> Result<(), String> {
        // No ACP method. Claude's bridge is a no-op here too — the relay hides
        // the thread on its own side.
        Ok(())
    }

    async fn delete_thread_permanently(
        &self,
        _thread_id: &str,
    ) -> Result<LocalThreadDeleteSummary, String> {
        Err(format!(
            "{} does not support deleting sessions over ACP",
            self.display_name
        ))
    }

    async fn start_turn(
        &self,
        thread_id: &str,
        text: &str,
        model: &str,
        _effort: &str,
        images: &[ProviderImage],
    ) -> Result<Option<String>, String> {
        // `promptCapabilities.image` is optional. Dropping the blocks silently
        // would leave "[Attached image]" in the transcript beside an answer the
        // agent gave without ever seeing the image — refuse the turn rather than
        // succeed on a different question than the user asked. Checked before
        // anything is recorded so a rejected turn leaves no trace.
        if !images.is_empty() && !self.capabilities.lock().await.prompt_images {
            return Err(format!(
                "{} did not negotiate image prompts, so it cannot accept attachments",
                self.display_name
            ));
        }

        // Before the prompt, not after: the model is session config, so it has
        // to be in place for this turn rather than the next one. Reasoning
        // effort has no separate axis here — ACP model ids encode it (see
        // `protocol::model_effort`), so it rides along inside `model`.
        self.apply_model(thread_id, model).await?;

        let turn_id = self.mint_turn_id();

        let user_item_id = {
            let mut sessions = self.sessions.lock().await;
            let session = sessions.entry(thread_id.to_string()).or_default();
            session.turn_id = Some(turn_id.clone());
            session.close_streams();
            session.next_item_id("user")
        };

        // ACP emits `user_message_chunk` only on replay, so the live user turn
        // is the relay's to record.
        if let Some(display) = crate::provider::user_message_transcript_text(text, images.len()) {
            let mut relay = self.state.write().await;
            rpc::apply_user_message(
                &mut relay,
                thread_id,
                user_item_id,
                display,
                turn_id.clone(),
                self.provider_name,
            );
            relay.notify();
        }

        let mut blocks = vec![json!({ "type": "text", "text": text })];
        for image in images {
            blocks.push(json!({
                "type": "image",
                "mimeType": image.media_type,
                "data": image.data,
            }));
        }

        Ok(Some(
            self.dispatch_prompt(thread_id, turn_id, blocks).await?,
        ))
    }

    async fn request_turn_stop(
        &self,
        thread_id: &str,
        _turn_id: Option<&str>,
    ) -> Result<(), String> {
        // Session-scoped, like Claude: ACP cancels the session's in-flight turn
        // and there is no turn addressing to pass along.
        self.send_notification("session/cancel", json!({ "sessionId": thread_id }))
            .await
    }

    async fn respond_to_approval(
        &self,
        pending: &PendingApproval,
        input: &ApprovalDecisionInput,
    ) -> Result<(), String> {
        let options = pending
            .requested_permissions
            .as_ref()
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let outcome = match protocol::approval_option_id(input, &options) {
            Some(option_id) => json!({ "outcome": "selected", "optionId": option_id }),
            // Nothing matched — cancel rather than leave the agent parked.
            None => json!({ "outcome": "cancelled" }),
        };

        self.send_json(json!({
            "jsonrpc": "2.0",
            "id": pending.raw_request_id,
            "result": { "outcome": outcome },
        }))
        .await
    }

    async fn respond_to_ask_user_question(
        &self,
        _request_id: &str,
        _answers: &serde_json::Map<String, Value>,
    ) -> Result<(), String> {
        Err(format!(
            "{} does not support AskUserQuestion over ACP",
            self.display_name
        ))
    }

    fn provider_name(&self) -> &'static str {
        self.provider_name
    }
}

impl AcpBridge {
    /// Fire `session/prompt` without awaiting it.
    ///
    /// Unlike codex's `turn/start`, an ACP prompt is a long-running *request*
    /// that only answers when the turn ends. Awaiting it inline would block the
    /// caller for the whole turn, so the response is finalized on a task and the
    /// turn id is handed back immediately.
    async fn dispatch_prompt(
        &self,
        thread_id: &str,
        turn_id: String,
        blocks: Vec<Value>,
    ) -> Result<String, String> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let request_id_key = request_id.to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending_responses
            .lock()
            .await
            .insert(request_id_key.clone(), sender);

        {
            let mut relay = self.state.write().await;
            rpc::apply_turn_started(&mut relay, thread_id, &turn_id, self.provider_name);
            relay.notify();
        }

        if let Err(error) = self
            .send_json(json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "session/prompt",
                "params": { "sessionId": thread_id, "prompt": blocks },
            }))
            .await
        {
            // The relay was already marked working and the session already
            // holds this turn id, so a failed write has to undo both — otherwise
            // the thread is stuck "working" on a turn the agent never received,
            // with no event coming to settle it.
            self.pending_responses.lock().await.remove(&request_id_key);
            {
                let mut sessions = self.sessions.lock().await;
                if let Some(session) = sessions.get_mut(thread_id) {
                    if session.turn_id.as_deref() == Some(turn_id.as_str()) {
                        session.turn_id = None;
                    }
                    session.close_streams();
                }
            }
            let mut relay = self.state.write().await;
            rpc::apply_turn_finished(
                &mut relay,
                thread_id,
                &turn_id,
                Err(error.clone()),
                self.provider_name,
            );
            relay.notify();
            return Err(error);
        }

        let state = self.state.clone();
        let sessions = self.sessions.clone();
        let pending_responses = self.pending_responses.clone();
        let provider_key = self.provider_name;
        let display_name = self.display_name;
        let thread = thread_id.to_string();
        let finished_turn = turn_id.clone();

        tokio::spawn(async move {
            let outcome =
                match timeout(Duration::from_secs(ACP_PROMPT_TIMEOUT_SECS), receiver).await {
                    Ok(Ok(result)) => result,
                    Ok(Err(_)) => Err(format!(
                        "{display_name} dropped the turn before it finished"
                    )),
                    Err(_) => {
                        pending_responses.lock().await.remove(&request_id_key);
                        Err(format!("{display_name} turn exceeded its time limit"))
                    }
                };

            {
                let mut sessions = sessions.lock().await;
                if let Some(session) = sessions.get_mut(&thread) {
                    if session.turn_id.as_deref() == Some(finished_turn.as_str()) {
                        session.turn_id = None;
                    }
                    session.close_streams();
                }
            }

            let mut relay = state.write().await;
            rpc::apply_turn_finished(&mut relay, &thread, &finished_turn, outcome, provider_key);
            relay.notify();
        });

        Ok(turn_id)
    }
}
