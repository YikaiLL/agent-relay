use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct ApiEnvelope<T> {
    pub ok: bool,
    pub data: T,
}

impl<T> ApiEnvelope<T> {
    pub fn ok(data: T) -> Self {
        Self { ok: true, data }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ApiError {
    pub ok: bool,
    pub error: ErrorBody,
}

impl ApiError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: ErrorBody {
                code,
                message: message.into(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub service: &'static str,
    pub provider: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecurityMode {
    Private,
    Managed,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSnapshot {
    pub provider: &'static str,
    pub service_ready: bool,
    pub codex_connected: bool,
    pub broker_connected: bool,
    pub broker_channel_id: Option<String>,
    pub broker_peer_id: Option<String>,
    pub security_mode: SecurityMode,
    pub e2ee_enabled: bool,
    pub broker_can_read_content: bool,
    pub audit_enabled: bool,
    pub active_thread_id: Option<String>,
    pub active_controller_device_id: Option<String>,
    pub active_controller_last_seen_at: Option<u64>,
    pub controller_lease_expires_at: Option<u64>,
    pub controller_lease_seconds: u64,
    pub active_turn_id: Option<String>,
    pub current_status: String,
    pub active_flags: Vec<String>,
    pub current_cwd: String,
    pub model: String,
    pub approval_policy: String,
    pub sandbox: String,
    pub reasoning_effort: String,
    pub pending_approvals: Vec<ApprovalRequestView>,
    pub transcript: Vec<TranscriptEntryView>,
    pub logs: Vec<LogEntryView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApprovalRequestView {
    pub request_id: String,
    pub kind: String,
    pub summary: String,
    pub detail: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub requested_permissions: Option<Value>,
    pub available_decisions: Vec<String>,
    pub supports_session_scope: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalDecisionInput {
    pub decision: ApprovalDecision,
    pub scope: Option<ApprovalScope>,
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approve,
    Deny,
    Cancel,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalScope {
    Once,
    Session,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApprovalReceipt {
    pub request_id: String,
    pub decision: ApprovalDecision,
    pub resulting_state: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptEntryView {
    pub role: String,
    pub text: String,
    pub status: String,
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntryView {
    pub kind: String,
    pub message: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadSummaryView {
    pub id: String,
    pub name: Option<String>,
    pub preview: String,
    pub cwd: String,
    pub updated_at: u64,
    pub source: String,
    pub status: String,
    pub model_provider: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadsResponse {
    pub threads: Vec<ThreadSummaryView>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ThreadsQuery {
    pub cwd: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartSessionInput {
    pub cwd: Option<String>,
    pub initial_prompt: Option<String>,
    pub model: Option<String>,
    pub approval_policy: Option<String>,
    pub sandbox: Option<String>,
    pub effort: Option<String>,
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeSessionInput {
    pub thread_id: String,
    pub approval_policy: Option<String>,
    pub sandbox: Option<String>,
    pub effort: Option<String>,
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageInput {
    pub text: String,
    pub effort: Option<String>,
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TakeOverInput {
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatInput {
    pub device_id: Option<String>,
}
