use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::sync::{watch, RwLock};
use tracing::warn;

use super::{
    DeviceRecord, PairedDevice, RelayState, ReviewJob, ReviewerThread, ThreadSessionSettings,
    WorkflowRun, DEFAULT_STATE_FILE, PERSISTED_STATE_VERSION,
};

const PERSISTENCE_DEBOUNCE: Duration = Duration::from_millis(150);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct PersistedRelayState {
    pub(super) schema_version: u32,
    pub(super) active_thread_id: Option<String>,
    pub(super) active_controller_device_id: Option<String>,
    pub(super) active_controller_last_seen_at: Option<u64>,
    pub(super) current_status: String,
    pub(super) active_flags: Vec<String>,
    pub(super) current_cwd: String,
    pub(super) model: String,
    pub(super) approval_policy: String,
    pub(super) sandbox: String,
    pub(super) reasoning_effort: String,
    /// The active session's provider (relay provider KEY, e.g. "codex" /
    /// "claude_code"). The relay persists `active_thread_id` but NOT the thread
    /// row, so without this a restart can't tell which provider the restored
    /// active thread belongs to — it falls back to whatever provider spawned
    /// last and mis-routes the session (a restored Codex session shown as Claude,
    /// with Claude's model catalog). `#[serde(default)]` keeps old state files
    /// loadable (empty string → fall back to thread detection).
    #[serde(default)]
    pub(super) provider_name: String,
    #[serde(default)]
    pub(super) thread_settings: std::collections::HashMap<String, ThreadSessionSettings>,
    /// Fork lineage (forked thread id -> source thread id). `#[serde(default)]`
    /// keeps pre-fork state files loadable.
    #[serde(default)]
    pub(super) thread_forked_from: std::collections::HashMap<String, String>,
    /// Deferred-thread lineage (promoted real id -> `claude-pending-…` id).
    /// `#[serde(default)]` keeps pre-promotion state files loadable.
    #[serde(default)]
    pub(super) thread_promoted_from: std::collections::HashMap<String, String>,
    /// Honest per-thread last-activity timestamps (unix secs) used as the
    /// thread-list sort key instead of the resume-polluted provider mtime.
    /// `#[serde(default)]` keeps old state files loadable (empty map).
    #[serde(default)]
    pub(super) thread_last_activity_at: std::collections::HashMap<String, u64>,
    #[serde(default)]
    pub(super) allowed_roots: Vec<String>,
    #[serde(default)]
    pub(super) device_records: std::collections::HashMap<String, DeviceRecord>,
    #[serde(default)]
    pub(super) paired_devices: std::collections::HashMap<String, PairedDevice>,
    /// Durable reviewer-thread identity: reviewer_thread_id -> {parent, created_at}.
    /// Keeps reviewer threads hidden from navigation across relay restarts and gives
    /// a stable FIFO order for per-parent eviction. `#[serde(default)]` keeps old state
    /// files loadable (empty map); `ReviewerThread` also decodes the legacy bare-string
    /// form.
    #[serde(default)]
    pub(super) reviewer_threads: std::collections::HashMap<String, ReviewerThread>,
    /// Completed (TERMINAL) review-job cards — stored whole (incl. recap/review text)
    /// so the Reviewer panel survives a restart with its content. Only terminal jobs
    /// are persisted: an in-progress job's orchestrator dies with the process, so
    /// restoring it would strand a non-terminal job (locking its parent with nothing to
    /// release it) — the restore side (`RelayState`) re-applies this same terminal
    /// filter as a safeguard. `#[serde(default)]` keeps old state files loadable (empty
    /// map).
    #[serde(default)]
    pub(super) review_jobs: std::collections::HashMap<String, ReviewJob>,
    /// Workflow runs (orchestration metadata only — step transcripts are rebuilt
    /// from the provider). Unlike `review_jobs` (terminal-only), NON-terminal runs
    /// ARE persisted so a run survives a restart; the restore side
    /// (`RelayState::restored_workflow_jobs`) reconciles any non-terminal run to the
    /// terminal `Interrupted` state, so a run is never restored `Running` with no
    /// orchestrator. `#[serde(default)]` keeps old state files loadable (empty map).
    #[serde(default)]
    pub(super) workflow_jobs: std::collections::HashMap<String, WorkflowRun>,
    /// Web Push subscriptions for remote devices, keyed by device_id. Persisted
    /// so a closed/locked phone keeps receiving pushes across a relay restart.
    /// `#[serde(default)]` keeps old state files loadable (empty map).
    #[serde(default)]
    pub(super) push_subscriptions: std::collections::HashMap<String, Vec<super::PushSubscription>>,
    /// Persisted Projects (named session groupings), keyed by project id.
    /// `#[serde(default)]` keeps pre-Projects state files loadable (empty map).
    #[serde(default)]
    pub(super) projects: std::collections::HashMap<String, crate::protocol::ProjectView>,
    /// Session (thread) -> project id membership. Absent id = "Unassigned".
    /// `#[serde(default)]` keeps old state files loadable (empty map).
    #[serde(default)]
    pub(super) thread_project_id: std::collections::HashMap<String, String>,
    /// Persisted Projects cache key. Restored nonzero so a fresh client (which starts
    /// at 0) sees a mismatch and fetches the persisted projects across a restart —
    /// otherwise revision 0 would match and leave existing projects invisible until
    /// the next mutation. `#[serde(default)]` → 0 for pre-Projects state files.
    #[serde(default)]
    pub(super) projects_revision: u64,
}

impl PersistedRelayState {
    pub(super) fn from_relay(relay: &RelayState) -> Self {
        // Pending Claude threads (deferred-start placeholders) exist only in
        // server memory — they have no real SDK session yet. Dropping them
        // from the persisted snapshot avoids "ghost" active threads after a
        // restart that point at a session id Anthropic has never seen.
        let active_thread_id = relay
            .active_thread_id
            .clone()
            .filter(|id| !id.starts_with("claude-pending-"));
        Self {
            schema_version: PERSISTED_STATE_VERSION,
            active_thread_id,
            active_controller_device_id: relay.active_controller_device_id.clone(),
            active_controller_last_seen_at: relay.active_controller_last_seen_at,
            current_status: relay.current_status.clone(),
            active_flags: relay.active_flags.clone(),
            current_cwd: relay.current_cwd.clone(),
            model: relay.model.clone(),
            approval_policy: relay.approval_policy.clone(),
            sandbox: relay.sandbox.clone(),
            reasoning_effort: relay.reasoning_effort.clone(),
            provider_name: relay.provider_name.clone(),
            thread_settings: relay.thread_settings.clone(),
            thread_forked_from: relay.thread_forked_from.clone(),
            thread_promoted_from: relay.thread_promoted_from.clone(),
            thread_last_activity_at: relay.thread_last_activity_at.clone(),
            allowed_roots: relay.allowed_roots.clone(),
            device_records: relay.device_records.clone(),
            paired_devices: relay.paired_devices.clone(),
            // Drop synthetic Claude pending reviewer ids (same as active_thread_id
            // above): a reviewer that hasn't promoted to a real session id is
            // ephemeral — its review is gone on restart anyway — so persisting the
            // placeholder would only leave a ghost hiding entry.
            reviewer_threads: relay
                .reviewer_threads
                .iter()
                .filter(|(reviewer_id, _)| !reviewer_id.starts_with("claude-pending-"))
                .map(|(reviewer_id, record)| (reviewer_id.clone(), record.clone()))
                .collect(),
            // Only terminal review cards survive a restart (see the field doc): an
            // in-progress job has no orchestrator after restart, so persisting it would
            // leave the parent review-locked with nothing to release it.
            review_jobs: relay
                .review_jobs
                .iter()
                .filter(|(_, job)| job.status.is_terminal())
                .map(|(id, job)| (id.clone(), job.clone()))
                .collect(),
            // Persist ALL workflow runs (terminal cards AND non-terminal): a
            // non-terminal run must survive so the restore side can reconcile it to
            // `Interrupted` and offer a re-run, rather than vanishing on restart.
            workflow_jobs: relay.workflow_jobs.clone(),
            push_subscriptions: relay.push_subscriptions.clone(),
            projects: relay.projects.clone(),
            thread_project_id: relay.thread_project_id.clone(),
            projects_revision: relay.projects_revision,
        }
    }

    pub(super) fn settings_for_thread(&self, thread_id: &str) -> ThreadSessionSettings {
        let mut settings = self
            .thread_settings
            .get(thread_id)
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
        settings
    }
}

#[derive(Clone, Debug)]
pub(super) struct PersistenceStore {
    path: PathBuf,
}

impl PersistenceStore {
    pub(super) fn resolve(cwd: &Path) -> Self {
        let path = std::env::var_os("RELAY_STATE_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| cwd.join(DEFAULT_STATE_FILE));
        Self { path }
    }

    #[cfg(test)]
    pub(super) fn from_path(path: PathBuf) -> Self {
        Self { path }
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) async fn load(&self) -> Result<Option<PersistedRelayState>, String> {
        let contents = match tokio::fs::read(&self.path).await {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!("failed to read persisted state file: {error}"));
            }
        };

        let state: PersistedRelayState = serde_json::from_slice(&contents)
            .map_err(|error| format!("failed to decode persisted state: {error}"))?;
        if state.schema_version != PERSISTED_STATE_VERSION {
            return Err(format!(
                "unsupported persisted state version: {}",
                state.schema_version
            ));
        }

        Ok(Some(state))
    }

    pub(super) async fn save(&self, state: &PersistedRelayState) -> Result<(), String> {
        let Some(parent) = self.path.parent() else {
            return Err("persisted state path must have a parent directory".to_string());
        };
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("failed to create persisted state directory: {error}"))?;

        let serialized = serde_json::to_vec_pretty(state)
            .map_err(|error| format!("failed to encode persisted state: {error}"))?;
        let temporary_path = self.path.with_extension("tmp");

        // Atomic exclusive-create, not check-then-write: closes both a
        // TOCTOU race and a hard-link bypass a plain write would leave open.
        // Runs on the blocking pool since it's sync I/O shared with
        // `instance_lock::record_owner`.
        let write_path = temporary_path.clone();
        tokio::task::spawn_blocking(move || {
            crate::instance_lock::write_new_exclusive(&write_path, &serialized)
        })
        .await
        .map_err(|error| format!("temp file write task panicked: {error}"))?
        .map_err(|error| format!("failed to write temporary persisted state file: {error}"))?;

        tokio::fs::rename(&temporary_path, &self.path)
            .await
            .map_err(|error| format!("failed to replace persisted state file: {error}"))?;

        Ok(())
    }
}

pub(super) fn spawn_persistence_task(
    relay: Arc<RwLock<RelayState>>,
    mut receiver: watch::Receiver<u64>,
    persistence: PersistenceStore,
) {
    tokio::spawn(async move {
        while receiver.changed().await.is_ok() {
            tokio::time::sleep(PERSISTENCE_DEBOUNCE).await;
            loop {
                match receiver.has_changed() {
                    Ok(true) => {
                        if receiver.changed().await.is_err() {
                            return;
                        }
                    }
                    Ok(false) => break,
                    Err(_) => return,
                }
            }

            let state = {
                let relay = relay.read().await;
                PersistedRelayState::from_relay(&relay)
            };

            if let Err(error) = persistence.save(&state).await {
                warn!(
                    "failed to persist relay state to {}: {}",
                    persistence.path().display(),
                    error
                );
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Only the fields WITHOUT `#[serde(default)]` need to be supplied here —
    // everything else (maps/vecs the rest of the struct carries) defaults to
    // empty, which is fine for a save() round-trip test that only cares about
    // the temp-file write path, not the content.
    fn sample_state() -> PersistedRelayState {
        serde_json::from_str(
            r#"{
                "schema_version": 2,
                "active_thread_id": null,
                "active_controller_device_id": null,
                "active_controller_last_seen_at": null,
                "current_status": "idle",
                "active_flags": [],
                "current_cwd": "/tmp",
                "model": "test-model",
                "approval_policy": "untrusted",
                "sandbox": "workspace-write",
                "reasoning_effort": "medium"
            }"#,
        )
        .expect("sample_state JSON must match PersistedRelayState's non-defaulted fields")
    }

    // `session.tmp` is a different filename than the state path itself, so
    // the startup-time symlink check on the state path doesn't cover it.
    #[tokio::test]
    async fn save_refuses_a_preplanted_symlink_at_the_temp_file_path() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim.txt");
        std::fs::write(&victim, b"do not touch me").unwrap();

        let state_path = dir.path().join("session.json");
        let temp_path = state_path.with_extension("tmp");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&victim, &temp_path).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&victim, &temp_path).unwrap();

        let store = PersistenceStore::from_path(state_path.clone());
        let result = store.save(&sample_state()).await;

        assert!(
            result.is_err(),
            "save() must refuse to write through a pre-planted symlink at the temp file path"
        );
        assert_eq!(
            std::fs::read(&victim).unwrap(),
            b"do not touch me",
            "the external file the planted symlink points to must be untouched"
        );
        assert!(
            !state_path.exists(),
            "save() must not have completed the rename onto the real state path either"
        );
    }

    #[tokio::test]
    async fn save_succeeds_when_no_temp_file_symlink_is_planted() {
        let dir = tempfile::tempdir().unwrap();
        let state_path = dir.path().join("session.json");
        let store = PersistenceStore::from_path(state_path.clone());

        store.save(&sample_state()).await.unwrap();

        assert!(state_path.exists(), "save() must write the real state path");
        assert!(
            !state_path.with_extension("tmp").exists(),
            "the temp file must be renamed away, not left behind"
        );
    }

    // A hard link passes a symlink-only check but shares content with its
    // victim via the inode.
    #[cfg(unix)]
    #[tokio::test]
    async fn save_refuses_a_preplanted_hard_link_at_the_temp_file_path() {
        let dir = tempfile::tempdir().unwrap();
        let victim = dir.path().join("victim.txt");
        std::fs::write(&victim, b"do not touch me").unwrap();

        let state_path = dir.path().join("session.json");
        let temp_path = state_path.with_extension("tmp");
        std::fs::hard_link(&victim, &temp_path).unwrap();

        let store = PersistenceStore::from_path(state_path.clone());
        let result = store.save(&sample_state()).await;

        assert!(
            result.is_err(),
            "save() must refuse to write through a pre-planted hard link at the temp file path"
        );
        assert_eq!(
            std::fs::read(&victim).unwrap(),
            b"do not touch me",
            "the external file the planted hard link points to must be untouched"
        );
        assert!(
            !state_path.exists(),
            "save() must not have completed the rename onto the real state path either"
        );
    }

    #[tokio::test]
    async fn save_recovers_from_an_ordinary_stale_leftover_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let state_path = dir.path().join("session.json");
        let temp_path = state_path.with_extension("tmp");
        std::fs::write(&temp_path, b"stale leftover from a previous crash").unwrap();

        let store = PersistenceStore::from_path(state_path.clone());
        store.save(&sample_state()).await.unwrap();

        assert!(state_path.exists(), "save() must write the real state path");
        assert!(
            !temp_path.exists(),
            "the temp file must be renamed away, not left behind"
        );
    }
}
