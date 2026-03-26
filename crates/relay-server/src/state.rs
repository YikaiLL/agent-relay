mod app;
mod persistence;
mod relay;
mod security;
#[cfg(test)]
mod tests;

use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub use self::app::{AppState, ApprovalError};
use self::relay::TranscriptRecord;
pub(crate) use self::relay::{ApprovalKind, PendingApproval, RelayState};
pub(crate) use self::security::SecurityProfile;

use crate::protocol::ThreadSummaryView;

pub const DEFAULT_MODEL: &str = "gpt-5-codex";
pub const DEFAULT_APPROVAL_POLICY: &str = "untrusted";
pub const DEFAULT_SANDBOX: &str = "workspace-write";
pub const DEFAULT_EFFORT: &str = "medium";
pub const CONTROLLER_LEASE_SECS: u64 = 15;
const MAX_LOG_LINES: usize = 200;
const THREAD_SCAN_LIMIT: usize = 200;
const PERSISTED_STATE_VERSION: u32 = 1;
const DEFAULT_STATE_FILE: &str = ".agent-relay/session.json";

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
