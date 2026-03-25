use std::{
    collections::HashMap,
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};
use tokio::sync::{watch, RwLock};

use crate::{
    codex::{CodexBridge, ThreadSyncData},
    protocol::{
        ApprovalDecision, ApprovalDecisionInput, ApprovalReceipt, ApprovalRequestView,
        ApprovalScope, HeartbeatInput, LogEntryView, ResumeSessionInput, SendMessageInput,
        SessionSnapshot, StartSessionInput, TakeOverInput, ThreadSummaryView, ThreadsResponse,
        TranscriptEntryView,
    },
};

pub const DEFAULT_MODEL: &str = "gpt-5-codex";
pub const DEFAULT_APPROVAL_POLICY: &str = "untrusted";
pub const DEFAULT_SANDBOX: &str = "workspace-write";
pub const DEFAULT_EFFORT: &str = "medium";
pub const CONTROLLER_LEASE_SECS: u64 = 15;
const MAX_LOG_LINES: usize = 200;
const THREAD_SCAN_LIMIT: usize = 200;

#[derive(Clone)]
pub struct AppState {
    relay: Arc<RwLock<RelayState>>,
    codex: Arc<CodexBridge>,
    change_tx: watch::Sender<u64>,
}

impl AppState {
    pub async fn new() -> Result<Self, String> {
        let cwd = std::env::current_dir()
            .map_err(|error| format!("failed to resolve current directory: {error}"))?
            .display()
            .to_string();
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(cwd, change_tx.clone())));
        let codex = Arc::new(CodexBridge::spawn(relay.clone()).await?);

        Ok(Self {
            relay,
            codex,
            change_tx,
        })
    }

    pub async fn snapshot(&self) -> SessionSnapshot {
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
        relay.snapshot()
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.change_tx.subscribe()
    }

    pub async fn list_threads(
        &self,
        limit: usize,
        cwd: Option<String>,
    ) -> Result<ThreadsResponse, String> {
        let cwd = non_empty(cwd);
        let scan_limit = if cwd.is_some() {
            limit.max(THREAD_SCAN_LIMIT)
        } else {
            limit
        };
        let threads = self.codex.list_threads(scan_limit).await?;
        let response_threads = filter_threads(threads.clone(), cwd.as_deref(), limit);
        let mut relay = self.relay.write().await;
        relay.threads = threads;
        relay.notify();
        Ok(ThreadsResponse {
            threads: response_threads,
        })
    }

    pub async fn start_session(&self, input: StartSessionInput) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let defaults = self.defaults().await;
        let cwd = non_empty(input.cwd).unwrap_or(defaults.current_cwd);
        let model = non_empty(input.model).unwrap_or(defaults.model);
        let approval_policy = non_empty(input.approval_policy).unwrap_or(defaults.approval_policy);
        let sandbox = non_empty(input.sandbox).unwrap_or(defaults.sandbox);
        let effort = non_empty(input.effort).unwrap_or(defaults.reasoning_effort);

        let thread = self
            .codex
            .start_thread(&cwd, &model, &approval_policy, &sandbox)
            .await?;

        {
            let mut relay = self.relay.write().await;
            relay.activate_thread(
                thread,
                &cwd,
                &model,
                &approval_policy,
                &sandbox,
                &effort,
                &device_id,
            );
            relay.push_log(
                "info",
                format!(
                    "Started a new Codex thread in {cwd}. Control is now on {}.",
                    short_device_id(&device_id)
                ),
            );
            relay.notify();
        }

        if let Some(initial_prompt) = non_empty(input.initial_prompt) {
            return self
                .send_message(SendMessageInput {
                    text: initial_prompt,
                    effort: Some(effort),
                    device_id: Some(device_id),
                })
                .await;
        }

        let _ = self.list_threads(20, None).await;
        Ok(self.snapshot().await)
    }

    pub async fn resume_session(
        &self,
        input: ResumeSessionInput,
    ) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let defaults = self.defaults().await;
        let approval_policy = non_empty(input.approval_policy).unwrap_or(defaults.approval_policy);
        let sandbox = non_empty(input.sandbox).unwrap_or(defaults.sandbox);
        let effort = non_empty(input.effort).unwrap_or(defaults.reasoning_effort);

        self.codex
            .resume_thread(&input.thread_id, &approval_policy, &sandbox)
            .await?;

        let thread_data = self.codex.read_thread(&input.thread_id).await?;
        {
            let mut relay = self.relay.write().await;
            relay.load_thread_data(thread_data, &approval_policy, &sandbox, &effort, &device_id);
            relay.push_log(
                "info",
                format!(
                    "Resumed thread {}. Control is now on {}.",
                    input.thread_id,
                    short_device_id(&device_id)
                ),
            );
            relay.notify();
        }

        let _ = self.list_threads(20, None).await;
        Ok(self.snapshot().await)
    }

    pub async fn send_message(&self, input: SendMessageInput) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        self.expire_stale_controller_if_needed().await;
        let defaults = self.defaults().await;
        let text = non_empty(Some(input.text))
            .ok_or_else(|| "message text cannot be empty".to_string())?;
        let effort = non_empty(input.effort).unwrap_or(defaults.reasoning_effort);
        let thread_id = {
            let relay = self.relay.read().await;
            relay.ensure_device_can_send_message(&device_id)?;
            relay
                .active_thread_id
                .clone()
                .ok_or_else(|| "there is no active Codex thread to send to".to_string())?
        };

        let turn_id = self.codex.start_turn(&thread_id, &text, &effort).await?;
        {
            let mut relay = self.relay.write().await;
            relay.assign_active_controller(&device_id, unix_now());
            relay.active_turn_id = turn_id;
            relay.reasoning_effort = effort.clone();
            relay.push_log(
                "info",
                format!("Sent a prompt to thread {thread_id} with {effort} effort."),
            );
            relay.notify();
        }

        Ok(self.snapshot().await)
    }

    pub async fn heartbeat_session(
        &self,
        input: HeartbeatInput,
    ) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
        relay.refresh_controller_lease(&device_id, unix_now());
        Ok(relay.snapshot())
    }

    pub async fn take_over_control(&self, input: TakeOverInput) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
        if relay.active_thread_id.is_none() {
            return Err("there is no active session to take over".to_string());
        }

        let changed = relay.set_active_controller(&device_id);
        if changed {
            relay.push_log(
                "info",
                format!("Control moved to {}.", short_device_id(&device_id)),
            );
            relay.notify();
        }

        Ok(relay.snapshot())
    }

    pub async fn decide_approval(
        &self,
        request_id: &str,
        input: ApprovalDecisionInput,
    ) -> Result<ApprovalReceipt, ApprovalError> {
        let device_id =
            require_device_id(input.device_id.clone()).map_err(ApprovalError::Bridge)?;
        let pending = {
            let relay = self.relay.read().await;
            relay
                .ensure_device_can_approve(&device_id)
                .map_err(ApprovalError::Bridge)?;
            relay
                .pending_approvals
                .get(request_id)
                .cloned()
                .ok_or(ApprovalError::NoPendingRequest)?
        };

        self.codex
            .respond_to_approval(&pending, &input)
            .await
            .map_err(ApprovalError::Bridge)?;

        let mut relay = self.relay.write().await;
        relay.pending_approvals.remove(request_id);
        relay.push_log(
            "info",
            format!(
                "Responded to approval {request_id} with {:?} from {}.",
                input.decision,
                short_device_id(&device_id)
            ),
        );
        relay.notify();

        Ok(ApprovalReceipt {
            request_id: request_id.to_string(),
            decision: input.decision,
            resulting_state: "approval_response_sent".to_string(),
            message: match input.decision {
                ApprovalDecision::Approve => "Remote approval sent to Codex.".to_string(),
                ApprovalDecision::Deny => "Remote denial sent to Codex.".to_string(),
                ApprovalDecision::Cancel => "Remote cancel sent to Codex.".to_string(),
            },
        })
    }

    async fn defaults(&self) -> SessionDefaults {
        let relay = self.relay.read().await;
        SessionDefaults {
            current_cwd: relay.current_cwd.clone(),
            model: relay.model.clone(),
            approval_policy: relay.approval_policy.clone(),
            sandbox: relay.sandbox.clone(),
            reasoning_effort: relay.reasoning_effort.clone(),
        }
    }

    async fn expire_stale_controller_if_needed(&self) {
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
    }
}

#[derive(Debug)]
pub enum ApprovalError {
    NoPendingRequest,
    Bridge(String),
}

#[derive(Clone, Debug)]
pub struct PendingApproval {
    pub request_id: String,
    pub raw_request_id: Value,
    pub kind: ApprovalKind,
    pub thread_id: String,
    pub summary: String,
    pub detail: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub requested_permissions: Option<Value>,
    pub available_decisions: Vec<String>,
    pub supports_session_scope: bool,
}

impl PendingApproval {
    pub fn to_view(&self) -> ApprovalRequestView {
        ApprovalRequestView {
            request_id: self.request_id.clone(),
            kind: self.kind.as_str().to_string(),
            summary: self.summary.clone(),
            detail: self.detail.clone(),
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            requested_permissions: self.requested_permissions.clone(),
            available_decisions: self.available_decisions.clone(),
            supports_session_scope: self.supports_session_scope,
        }
    }

    pub fn decision_payload(&self, input: &ApprovalDecisionInput) -> Value {
        match self.kind {
            ApprovalKind::Command => json!({
                "decision": match (input.decision, input.scope.unwrap_or(ApprovalScope::Once)) {
                    (ApprovalDecision::Approve, ApprovalScope::Session) => "acceptForSession",
                    (ApprovalDecision::Approve, ApprovalScope::Once) => "accept",
                    (ApprovalDecision::Deny, _) => "decline",
                    (ApprovalDecision::Cancel, _) => "cancel",
                }
            }),
            ApprovalKind::FileChange => json!({
                "decision": match (input.decision, input.scope.unwrap_or(ApprovalScope::Once)) {
                    (ApprovalDecision::Approve, ApprovalScope::Session) => "acceptForSession",
                    (ApprovalDecision::Approve, ApprovalScope::Once) => "accept",
                    (ApprovalDecision::Deny, _) => "decline",
                    (ApprovalDecision::Cancel, _) => "cancel",
                }
            }),
            ApprovalKind::Permissions => {
                if matches!(input.decision, ApprovalDecision::Approve) {
                    json!({
                        "permissions": self.requested_permissions.clone().unwrap_or_else(|| json!({})),
                        "scope": match input.scope.unwrap_or(ApprovalScope::Once) {
                            ApprovalScope::Once => "turn",
                            ApprovalScope::Session => "session",
                        }
                    })
                } else {
                    json!({
                        "permissions": {},
                        "scope": "turn"
                    })
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum ApprovalKind {
    Command,
    FileChange,
    Permissions,
}

impl ApprovalKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ApprovalKind::Command => "command_execution",
            ApprovalKind::FileChange => "file_change",
            ApprovalKind::Permissions => "permissions",
        }
    }
}

#[derive(Clone, Debug)]
struct TranscriptRecord {
    item_id: String,
    role: String,
    text: String,
    status: String,
    turn_id: Option<String>,
}

impl TranscriptRecord {
    fn to_view(&self) -> TranscriptEntryView {
        TranscriptEntryView {
            role: self.role.clone(),
            text: self.text.clone(),
            status: self.status.clone(),
            turn_id: self.turn_id.clone(),
        }
    }
}

pub struct RelayState {
    change_tx: watch::Sender<u64>,
    revision: u64,
    pub codex_connected: bool,
    pub active_thread_id: Option<String>,
    pub active_controller_device_id: Option<String>,
    pub active_controller_last_seen_at: Option<u64>,
    pub active_turn_id: Option<String>,
    pub current_status: String,
    pub active_flags: Vec<String>,
    pub current_cwd: String,
    pub model: String,
    pub approval_policy: String,
    pub sandbox: String,
    pub reasoning_effort: String,
    pub threads: Vec<ThreadSummaryView>,
    pub pending_approvals: HashMap<String, PendingApproval>,
    transcript: Vec<TranscriptRecord>,
    logs: Vec<LogEntryView>,
}

impl RelayState {
    pub fn new(current_cwd: String, change_tx: watch::Sender<u64>) -> Self {
        let mut state = Self {
            change_tx,
            revision: 0,
            codex_connected: false,
            active_thread_id: None,
            active_controller_device_id: None,
            active_controller_last_seen_at: None,
            active_turn_id: None,
            current_status: "idle".to_string(),
            active_flags: Vec::new(),
            current_cwd,
            model: DEFAULT_MODEL.to_string(),
            approval_policy: DEFAULT_APPROVAL_POLICY.to_string(),
            sandbox: DEFAULT_SANDBOX.to_string(),
            reasoning_effort: DEFAULT_EFFORT.to_string(),
            threads: Vec::new(),
            pending_approvals: HashMap::new(),
            transcript: Vec::new(),
            logs: Vec::new(),
        };
        state.push_log("info", "Relay booted. Waiting for Codex app-server.");
        state
    }

    pub fn notify(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        let _ = self.change_tx.send(self.revision);
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            provider: "codex",
            service_ready: true,
            codex_connected: self.codex_connected,
            active_thread_id: self.active_thread_id.clone(),
            active_controller_device_id: self.active_controller_device_id.clone(),
            active_controller_last_seen_at: self.active_controller_last_seen_at,
            controller_lease_expires_at: self.controller_lease_expires_at(),
            controller_lease_seconds: CONTROLLER_LEASE_SECS,
            active_turn_id: self.active_turn_id.clone(),
            current_status: self.current_status.clone(),
            active_flags: self.active_flags.clone(),
            current_cwd: self.current_cwd.clone(),
            model: self.model.clone(),
            approval_policy: self.approval_policy.clone(),
            sandbox: self.sandbox.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
            pending_approvals: self
                .pending_approvals
                .values()
                .cloned()
                .map(|approval| approval.to_view())
                .collect(),
            transcript: self
                .transcript
                .iter()
                .map(TranscriptRecord::to_view)
                .collect(),
            logs: self.logs.clone(),
        }
    }

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
        self.active_thread_id = Some(thread.id.clone());
        self.assign_active_controller(device_id, unix_now());
        self.active_turn_id = None;
        self.current_status = thread.status.clone();
        self.active_flags.clear();
        self.current_cwd = cwd.to_string();
        self.model = model.to_string();
        self.approval_policy = approval_policy.to_string();
        self.sandbox = sandbox.to_string();
        self.reasoning_effort = effort.to_string();
        self.pending_approvals.clear();
        self.transcript.clear();
        self.upsert_thread(thread);
    }

    pub fn load_thread_data(
        &mut self,
        data: ThreadSyncData,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        device_id: &str,
    ) {
        self.active_thread_id = Some(data.thread.id.clone());
        self.assign_active_controller(device_id, unix_now());
        self.active_turn_id = None;
        self.current_status = data.status;
        self.active_flags = data.active_flags;
        self.current_cwd = data.thread.cwd.clone();
        self.approval_policy = approval_policy.to_string();
        self.sandbox = sandbox.to_string();
        self.reasoning_effort = effort.to_string();
        self.pending_approvals.clear();
        self.transcript = data
            .transcript
            .into_iter()
            .enumerate()
            .map(|(index, entry)| TranscriptRecord {
                item_id: format!("history-{index}"),
                role: entry.role,
                text: entry.text,
                status: entry.status,
                turn_id: entry.turn_id,
            })
            .collect();
        self.upsert_thread(data.thread);
    }

    pub fn upsert_thread(&mut self, thread: ThreadSummaryView) {
        if let Some(existing) = self.threads.iter_mut().find(|item| item.id == thread.id) {
            *existing = thread;
        } else {
            self.threads.insert(0, thread);
        }
    }

    pub fn set_connection(&mut self, connected: bool) {
        self.codex_connected = connected;
    }

    pub fn set_active_turn(&mut self, turn_id: Option<String>) {
        self.active_turn_id = turn_id;
    }

    pub fn can_device_send_message(&self, device_id: &str) -> bool {
        if self.active_thread_id.is_none() {
            return false;
        }

        match self.active_controller_device_id.as_deref() {
            Some(active_device_id) => active_device_id == device_id,
            None => true,
        }
    }

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
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.current_status = status.clone();
            self.active_flags = active_flags;
        }

        if let Some(thread) = self.threads.iter_mut().find(|item| item.id == thread_id) {
            thread.status = status;
        }
    }

    pub fn push_log(&mut self, kind: &str, message: impl Into<String>) {
        self.logs.insert(
            0,
            LogEntryView {
                kind: kind.to_string(),
                message: message.into(),
                created_at: unix_now(),
            },
        );
        if self.logs.len() > MAX_LOG_LINES {
            self.logs.truncate(MAX_LOG_LINES);
        }
    }

    pub fn start_agent_message(&mut self, item_id: String, turn_id: String) {
        self.transcript.push(TranscriptRecord {
            item_id,
            role: "assistant".to_string(),
            text: String::new(),
            status: "streaming".to_string(),
            turn_id: Some(turn_id),
        });
    }

    pub fn append_agent_delta(&mut self, item_id: &str, delta: &str, turn_id: &str) {
        if let Some(entry) = self
            .transcript
            .iter_mut()
            .find(|entry| entry.item_id == item_id)
        {
            entry.text.push_str(delta);
            entry.status = "streaming".to_string();
            return;
        }

        self.transcript.push(TranscriptRecord {
            item_id: item_id.to_string(),
            role: "assistant".to_string(),
            text: delta.to_string(),
            status: "streaming".to_string(),
            turn_id: Some(turn_id.to_string()),
        });
    }

    pub fn upsert_user_message(&mut self, item_id: String, text: String, turn_id: String) {
        if let Some(entry) = self
            .transcript
            .iter_mut()
            .find(|entry| entry.item_id == item_id)
        {
            entry.text = text;
            entry.status = "completed".to_string();
            return;
        }

        self.transcript.push(TranscriptRecord {
            item_id,
            role: "user".to_string(),
            text,
            status: "completed".to_string(),
            turn_id: Some(turn_id),
        });
    }

    pub fn complete_agent_message(&mut self, item_id: String, text: String, turn_id: String) {
        if let Some(entry) = self
            .transcript
            .iter_mut()
            .find(|entry| entry.item_id == item_id)
        {
            entry.text = text;
            entry.status = "completed".to_string();
            return;
        }

        self.transcript.push(TranscriptRecord {
            item_id,
            role: "assistant".to_string(),
            text,
            status: "completed".to_string(),
            turn_id: Some(turn_id),
        });
    }

    pub fn add_command_result(
        &mut self,
        item_id: String,
        command: String,
        output: Option<String>,
        status: String,
        turn_id: String,
    ) {
        let mut text = command;
        if let Some(output) = non_empty(Some(output.unwrap_or_default())) {
            text.push_str("\n");
            text.push_str(&output);
        }

        if let Some(entry) = self
            .transcript
            .iter_mut()
            .find(|entry| entry.item_id == item_id)
        {
            entry.text = text;
            entry.status = status;
            return;
        }

        self.transcript.push(TranscriptRecord {
            item_id,
            role: "command".to_string(),
            text,
            status,
            turn_id: Some(turn_id),
        });
    }

    fn assign_active_controller(&mut self, device_id: &str, now: u64) -> bool {
        let changed = self.active_controller_device_id.as_deref() != Some(device_id)
            || self.active_controller_last_seen_at != Some(now);
        self.active_controller_device_id = Some(device_id.to_string());
        self.active_controller_last_seen_at = Some(now);
        changed
    }
}

#[derive(Clone)]
struct SessionDefaults {
    current_cwd: String,
    model: String,
    approval_policy: String,
    sandbox: String,
    reasoning_effort: String,
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|item| {
        let trimmed = item.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn require_device_id(device_id: Option<String>) -> Result<String, String> {
    non_empty(device_id).ok_or_else(|| "device_id is required".to_string())
}

fn short_device_id(device_id: &str) -> String {
    let compact = device_id.trim();
    if compact.len() <= 8 {
        compact.to_string()
    } else {
        compact[..8].to_string()
    }
}

fn filter_threads(
    threads: Vec<ThreadSummaryView>,
    cwd: Option<&str>,
    limit: usize,
) -> Vec<ThreadSummaryView> {
    let mut filtered = threads
        .into_iter()
        .filter(|thread| thread_matches_cwd_scope(&thread.cwd, cwd))
        .collect::<Vec<_>>();
    filtered.truncate(limit);
    filtered
}

fn thread_matches_cwd_scope(thread_cwd: &str, cwd: Option<&str>) -> bool {
    let Some(cwd) = cwd else {
        return true;
    };

    let thread_path = Path::new(thread_cwd);
    let selected_path = Path::new(cwd);
    thread_path == selected_path || thread_path.starts_with(selected_path)
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn expire_controller_if_needed(relay: &mut RelayState) -> bool {
    let Some(expired_device_id) = relay.expire_stale_controller(unix_now()) else {
        return false;
    };

    relay.push_log(
        "info",
        format!(
            "Control lease expired for {}. Session is now unclaimed.",
            short_device_id(&expired_device_id)
        ),
    );
    relay.notify();
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> RelayState {
        let (change_tx, _) = watch::channel(0_u64);
        RelayState::new("/tmp/project".to_string(), change_tx)
    }

    fn test_thread(id: &str, cwd: &str) -> ThreadSummaryView {
        ThreadSummaryView {
            id: id.to_string(),
            name: Some("Test Thread".to_string()),
            preview: "Test preview".to_string(),
            cwd: cwd.to_string(),
            updated_at: 1,
            source: "codex".to_string(),
            status: "idle".to_string(),
            model_provider: "openai".to_string(),
        }
    }

    fn test_pending_approval(thread_id: &str) -> PendingApproval {
        PendingApproval {
            request_id: "req-1".to_string(),
            raw_request_id: json!(1),
            kind: ApprovalKind::Command,
            thread_id: thread_id.to_string(),
            summary: "Need approval".to_string(),
            detail: Some("Test command".to_string()),
            command: Some("ls".to_string()),
            cwd: Some("/tmp/project".to_string()),
            requested_permissions: None,
            available_decisions: vec!["approve".to_string(), "deny".to_string()],
            supports_session_scope: true,
        }
    }

    #[test]
    fn activate_thread_sets_active_controller_on_start() {
        let mut relay = test_state();

        relay.activate_thread(
            test_thread("thread-1", "/tmp/project"),
            "/tmp/project",
            DEFAULT_MODEL,
            DEFAULT_APPROVAL_POLICY,
            DEFAULT_SANDBOX,
            DEFAULT_EFFORT,
            "device-a",
        );

        assert_eq!(relay.active_thread_id.as_deref(), Some("thread-1"));
        assert_eq!(
            relay.active_controller_device_id.as_deref(),
            Some("device-a")
        );
        assert!(relay.can_device_send_message("device-a"));
        assert!(!relay.can_device_send_message("device-b"));
    }

    #[test]
    fn passive_device_cannot_send_message_until_takeover() {
        let mut relay = test_state();
        relay.activate_thread(
            test_thread("thread-1", "/tmp/project"),
            "/tmp/project",
            DEFAULT_MODEL,
            DEFAULT_APPROVAL_POLICY,
            DEFAULT_SANDBOX,
            DEFAULT_EFFORT,
            "device-a",
        );

        let error = relay
            .ensure_device_can_send_message("device-b")
            .expect_err("passive device should be blocked from sending");

        assert!(error.contains("another device currently has control"));

        assert!(relay.set_active_controller("device-b"));
        assert_eq!(
            relay.active_controller_device_id.as_deref(),
            Some("device-b")
        );
        assert!(relay.ensure_device_can_send_message("device-b").is_ok());
    }

    #[test]
    fn approval_is_allowed_from_passive_owner_device() {
        let mut relay = test_state();
        relay.activate_thread(
            test_thread("thread-1", "/tmp/project"),
            "/tmp/project",
            DEFAULT_MODEL,
            DEFAULT_APPROVAL_POLICY,
            DEFAULT_SANDBOX,
            DEFAULT_EFFORT,
            "device-a",
        );
        relay
            .pending_approvals
            .insert("req-1".to_string(), test_pending_approval("thread-1"));

        assert!(relay.can_device_approve("device-a"));
        assert!(relay.can_device_approve("device-b"));
        assert!(relay.ensure_device_can_approve("device-b").is_ok());
        assert!(!relay.can_device_send_message("device-b"));
    }

    #[test]
    fn load_thread_data_sets_active_controller_on_resume() {
        let mut relay = test_state();
        relay.load_thread_data(
            ThreadSyncData {
                thread: test_thread("thread-9", "/tmp/project"),
                status: "running".to_string(),
                active_flags: vec!["busy".to_string()],
                transcript: Vec::new(),
            },
            DEFAULT_APPROVAL_POLICY,
            DEFAULT_SANDBOX,
            DEFAULT_EFFORT,
            "phone-device",
        );

        assert_eq!(relay.active_thread_id.as_deref(), Some("thread-9"));
        assert_eq!(
            relay.active_controller_device_id.as_deref(),
            Some("phone-device")
        );
        assert_eq!(relay.current_status, "running");
    }

    #[test]
    fn stale_controller_lease_expires_and_releases_session() {
        let mut relay = test_state();
        relay.activate_thread(
            test_thread("thread-1", "/tmp/project"),
            "/tmp/project",
            DEFAULT_MODEL,
            DEFAULT_APPROVAL_POLICY,
            DEFAULT_SANDBOX,
            DEFAULT_EFFORT,
            "device-a",
        );
        relay.active_controller_last_seen_at = Some(100);

        let expired = relay.expire_stale_controller(100 + CONTROLLER_LEASE_SECS);

        assert_eq!(expired.as_deref(), Some("device-a"));
        assert_eq!(relay.active_controller_device_id, None);
        assert_eq!(relay.active_controller_last_seen_at, None);
        assert!(relay.can_device_send_message("device-b"));
    }

    #[test]
    fn active_controller_heartbeat_extends_lease() {
        let mut relay = test_state();
        relay.activate_thread(
            test_thread("thread-1", "/tmp/project"),
            "/tmp/project",
            DEFAULT_MODEL,
            DEFAULT_APPROVAL_POLICY,
            DEFAULT_SANDBOX,
            DEFAULT_EFFORT,
            "device-a",
        );
        relay.active_controller_last_seen_at = Some(100);

        assert!(relay.refresh_controller_lease("device-a", 112));
        assert_eq!(relay.controller_lease_expires_at(), Some(112 + CONTROLLER_LEASE_SECS));
        assert_eq!(relay.expire_stale_controller(100 + CONTROLLER_LEASE_SECS), None);
        assert_eq!(
            relay.active_controller_device_id.as_deref(),
            Some("device-a")
        );
    }

    #[test]
    fn passive_device_cannot_refresh_another_devices_lease() {
        let mut relay = test_state();
        relay.activate_thread(
            test_thread("thread-1", "/tmp/project"),
            "/tmp/project",
            DEFAULT_MODEL,
            DEFAULT_APPROVAL_POLICY,
            DEFAULT_SANDBOX,
            DEFAULT_EFFORT,
            "device-a",
        );
        relay.active_controller_last_seen_at = Some(100);

        assert!(!relay.refresh_controller_lease("device-b", 112));
        assert_eq!(relay.active_controller_last_seen_at, Some(100));
        assert_eq!(
            relay.active_controller_device_id.as_deref(),
            Some("device-a")
        );
    }

    #[test]
    fn require_device_id_rejects_empty_values() {
        assert_eq!(
            require_device_id(Some("   ".to_string())).unwrap_err(),
            "device_id is required"
        );
        assert_eq!(
            require_device_id(None).unwrap_err(),
            "device_id is required"
        );
        assert_eq!(
            require_device_id(Some("device-a".to_string())).unwrap(),
            "device-a"
        );
    }
}
