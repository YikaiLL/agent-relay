use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::{
    codex::ThreadSyncData,
    protocol::{
        ApprovalDecision, ApprovalDecisionInput, ApprovalRequestView, ApprovalScope, LogEntryView,
        SessionSnapshot, ThreadSummaryView, TranscriptEntryView,
    },
};

use super::{
    persistence::PersistedRelayState, unix_now, CONTROLLER_LEASE_SECS, DEFAULT_APPROVAL_POLICY,
    DEFAULT_EFFORT, DEFAULT_MODEL, DEFAULT_SANDBOX, MAX_LOG_LINES,
};

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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct TranscriptRecord {
    pub(super) item_id: String,
    pub(super) role: String,
    pub(super) text: String,
    pub(super) status: String,
    pub(super) turn_id: Option<String>,
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
    pub(super) transcript: Vec<TranscriptRecord>,
    pub(super) logs: Vec<LogEntryView>,
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

    pub(super) fn restore_thread_data(
        &mut self,
        data: ThreadSyncData,
        persisted: &PersistedRelayState,
    ) {
        self.active_thread_id = Some(data.thread.id.clone());
        self.active_controller_device_id = persisted.active_controller_device_id.clone();
        self.active_controller_last_seen_at = persisted.active_controller_last_seen_at;
        self.active_turn_id = None;
        self.current_status = data.status;
        self.active_flags = data.active_flags;
        self.current_cwd = data.thread.cwd.clone();
        self.model = persisted.model.clone();
        self.approval_policy = persisted.approval_policy.clone();
        self.sandbox = persisted.sandbox.clone();
        self.reasoning_effort = persisted.reasoning_effort.clone();
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
        if let Some(output) = super::non_empty(Some(output.unwrap_or_default())) {
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

    pub(super) fn apply_persisted(&mut self, persisted: &PersistedRelayState) {
        self.active_thread_id = persisted.active_thread_id.clone();
        self.active_controller_device_id = persisted.active_controller_device_id.clone();
        self.active_controller_last_seen_at = persisted.active_controller_last_seen_at;
        self.active_turn_id = None;
        self.current_status = persisted.current_status.clone();
        self.active_flags = persisted.active_flags.clone();
        self.current_cwd = persisted.current_cwd.clone();
        self.model = persisted.model.clone();
        self.approval_policy = persisted.approval_policy.clone();
        self.sandbox = persisted.sandbox.clone();
        self.reasoning_effort = persisted.reasoning_effort.clone();
        self.pending_approvals.clear();
        self.transcript = persisted.transcript.clone();
        self.logs = persisted.logs.clone();
    }

    pub fn clear_active_session(&mut self) {
        self.active_thread_id = None;
        self.active_controller_device_id = None;
        self.active_controller_last_seen_at = None;
        self.active_turn_id = None;
        self.current_status = "idle".to_string();
        self.active_flags.clear();
        self.pending_approvals.clear();
    }

    pub(super) fn assign_active_controller(&mut self, device_id: &str, now: u64) -> bool {
        let changed = self.active_controller_device_id.as_deref() != Some(device_id)
            || self.active_controller_last_seen_at != Some(now);
        self.active_controller_device_id = Some(device_id.to_string());
        self.active_controller_last_seen_at = Some(now);
        changed
    }
}
