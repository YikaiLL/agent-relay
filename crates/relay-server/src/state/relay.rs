mod approval;
mod device;
mod transcript;

use std::collections::HashMap;

use tokio::sync::watch;

use crate::{
    codex::ThreadSyncData,
    protocol::{LogEntryView, SessionSnapshot, ThreadSummaryView},
};

use super::{
    persistence::PersistedRelayState, unix_now, SecurityProfile, CONTROLLER_LEASE_SECS,
    DEFAULT_APPROVAL_POLICY, DEFAULT_EFFORT, DEFAULT_MODEL, DEFAULT_SANDBOX,
};

pub use self::approval::{ApprovalKind, PendingApproval};
pub(crate) use self::device::{PairedDevice, PendingPairing};
pub(crate) use self::transcript::TranscriptRecord;

pub struct RelayState {
    change_tx: watch::Sender<u64>,
    revision: u64,
    security: SecurityProfile,
    pub codex_connected: bool,
    pub broker_connected: bool,
    pub broker_channel_id: Option<String>,
    pub broker_peer_id: Option<String>,
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
    pub paired_devices: HashMap<String, PairedDevice>,
    pub pending_pairings: HashMap<String, PendingPairing>,
    pub threads: Vec<ThreadSummaryView>,
    pub pending_approvals: HashMap<String, PendingApproval>,
    pub(super) transcript: Vec<TranscriptRecord>,
    pub(super) logs: Vec<LogEntryView>,
}

impl RelayState {
    pub fn new(
        current_cwd: String,
        change_tx: watch::Sender<u64>,
        security: SecurityProfile,
    ) -> Self {
        let mut state = Self {
            change_tx,
            revision: 0,
            security,
            codex_connected: false,
            broker_connected: false,
            broker_channel_id: None,
            broker_peer_id: None,
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
            paired_devices: HashMap::new(),
            pending_pairings: HashMap::new(),
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
        let mut paired_devices = self
            .paired_devices
            .values()
            .cloned()
            .map(|device| device.to_view())
            .collect::<Vec<_>>();
        paired_devices.sort_by(|left, right| left.label.cmp(&right.label));

        SessionSnapshot {
            provider: "codex",
            service_ready: true,
            codex_connected: self.codex_connected,
            broker_connected: self.broker_connected,
            broker_channel_id: self.broker_channel_id.clone(),
            broker_peer_id: self.broker_peer_id.clone(),
            security_mode: self.security.mode(),
            e2ee_enabled: self.security.e2ee_enabled(),
            broker_can_read_content: self.security.broker_can_read_content(),
            audit_enabled: self.security.audit_enabled(),
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
            paired_devices,
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
        self.paired_devices = persisted.paired_devices.clone();
        self.pending_pairings.clear();
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

    pub fn set_broker_connection(&mut self, connected: bool) {
        self.broker_connected = connected;
    }

    pub fn set_broker_target(&mut self, channel_id: Option<String>, peer_id: Option<String>) {
        self.broker_channel_id = channel_id;
        self.broker_peer_id = peer_id;
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
        self.paired_devices = persisted.paired_devices.clone();
        self.pending_pairings.clear();
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
