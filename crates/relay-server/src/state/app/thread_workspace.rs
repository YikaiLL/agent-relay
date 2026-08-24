//! Pin → fresh writes → remembered proven → birth cwd. Candidates must be in enumerated, device-scoped `roots`.

use super::*;

impl AppState {
    /// Pin → fresh write evidence → remembered proven → birth cwd (`None` device = relay-wide roots).
    pub(crate) async fn resolve_thread_workspace(
        &self,
        thread_id: &str,
        device_id: Option<&str>,
    ) -> Result<ResolvedWorkspace, ThreadWorkspaceError> {
        let (birth_cwd, relay_cwd, device_scope, allowed_roots, write_evidence, remembered) = {
            let relay = self.relay.read().await;
            let birth_cwd = relay.thread_cwd(thread_id).ok_or_else(|| {
                ThreadWorkspaceError::Unresolvable(format!(
                    "cannot resolve the workspace of thread `{thread_id}`"
                ))
            })?;
            let device_scope = device_id
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            ensure_path_within_device_scope(&birth_cwd, &device_scope, &relay.allowed_roots)
                .map_err(ThreadWorkspaceError::OutOfScope)?;
            // Paths only: git matching happens after this lock is dropped.
            let write_evidence = relay
                .runtime_for_thread(thread_id)
                .map(|runtime| thread_write_evidence(&runtime.transcript))
                .unwrap_or_default();
            (
                birth_cwd,
                relay.current_cwd.clone(),
                device_scope,
                relay.allowed_roots.clone(),
                write_evidence,
                relay.thread_workspace(thread_id),
            )
        };

        let birth_cwd_exists = dir_exists(&birth_cwd);
        let (usable, gone) =
            resolve_workspace_cwd(&birth_cwd, &relay_cwd, &device_scope, &allowed_roots)
                .await
                .into_readable()
                .ok_or_else(|| {
                    ThreadWorkspaceError::Unresolvable(format!(
                        "the workspace this thread ran in ({birth_cwd}) no longer exists, and \
no workspace related to it is available instead"
                    ))
                })?;
        let roots: Vec<WorkspaceRootView> = list_worktrees_in(&usable)
            .await
            .into_iter()
            .filter(|root| path_within_device_scope(&root.path, &device_scope, &allowed_roots))
            .collect();
        // Map stored paths onto git's spelling; re-check scope so this does not depend on the filter above.
        let in_reach = |candidate: &str| -> Option<String> {
            roots
                .iter()
                .find(|root| paths_equivalent(&root.path, candidate))
                .filter(|root| path_within_device_scope(&root.path, &device_scope, &allowed_roots))
                .map(|root| root.path.clone())
        };

        let (cwd, origin) = if let Some(pinned) = remembered.pinned.as_deref().and_then(&in_reach) {
            (pinned, WorkspaceOrigin::Pinned)
        } else if let Some(proven) = root_containing_writes(&write_evidence, &roots) {
            // Skip the write lock when the proven tree has not changed (this runs on every refresh).
            if remembered.proven.as_deref() != Some(proven.as_str()) {
                self.relay
                    .write()
                    .await
                    .record_proven_thread_workspace(thread_id, &proven);
            }
            (proven, WorkspaceOrigin::Proven)
        } else if let Some(remembered) = remembered.proven.as_deref().and_then(&in_reach) {
            // Empty evidence is not "moved back to birth".
            (remembered, WorkspaceOrigin::Proven)
        } else {
            let cwd = usable.as_str().to_string();
            match gone {
                Some(gone) => (cwd, WorkspaceOrigin::Substituted { gone }),
                None => (cwd, WorkspaceOrigin::Birth),
            }
        };

        // Git standing is live; never stored.
        let git = match LiveWorkspace::from_path(&cwd) {
            Some(workspace) => {
                super::git_context::collect_git_context(cwd.clone(), &workspace).await
            }
            None => WorkspaceGitContextView {
                cwd: cwd.clone(),
                ..WorkspaceGitContextView::default()
            },
        };

        Ok(ResolvedWorkspace {
            cwd,
            origin,
            git,
            roots,
            birth_cwd,
            birth_cwd_exists,
        })
    }

    /// Pin (`Some`) or un-pin (`None`); only enumerated, in-scope trees, then re-resolve.
    pub async fn pin_thread_workspace(
        &self,
        input: ThreadWorkspaceInput,
    ) -> Result<ResolvedWorkspace, String> {
        let thread_id =
            non_empty(Some(input.thread_id)).ok_or_else(|| "thread_id is required".to_string())?;
        if thread_id.len() > MAX_THREAD_ID_BYTES {
            return Err(format!(
                "thread id must be at most {MAX_THREAD_ID_BYTES} bytes"
            ));
        }
        let device_id = input.device_id.clone();
        // Promote pending ids first: pinning a `claude-pending-…` row would persist a dead key.
        let thread_id = self
            .relay
            .read()
            .await
            .resolve_promoted_thread_id(&thread_id);

        let current = self
            .resolve_thread_workspace(&thread_id, device_id.as_deref())
            .await
            .map_err(ThreadWorkspaceError::into_message)?;

        let pin = match non_empty(input.cwd) {
            None => None,
            Some(requested) => {
                // Store git's spelling, not the caller's string.
                let matched = current
                    .roots
                    .iter()
                    .find(|root| paths_equivalent(&root.path, &requested))
                    .ok_or_else(|| {
                        format!(
                            "{requested} is not one of this session's working trees; pick one \
of the trees the relay listed for it"
                        )
                    })?;
                // Scope is the actual boundary.
                let (device_scope, allowed_roots) = {
                    let relay = self.relay.read().await;
                    (
                        device_id
                            .as_deref()
                            .map(|id| relay.device_path_scope(id))
                            .unwrap_or_default(),
                        relay.allowed_roots.clone(),
                    )
                };
                ensure_path_within_device_scope(&matched.path, &device_scope, &allowed_roots)?;
                Some(matched.path.clone())
            }
        };

        {
            let mut relay = self.relay.write().await;
            if relay.set_thread_workspace(&thread_id, pin.as_deref()) {
                relay.push_log(
                    "info",
                    match pin.as_deref() {
                        Some(path) => format!(
                            "Session {thread_id}: working tree pinned to {path} by {}.",
                            short_device_id(device_id.as_deref().unwrap_or("local operator"))
                        ),
                        None => format!(
                            "Session {thread_id}: working tree un-pinned by {}.",
                            short_device_id(device_id.as_deref().unwrap_or("local operator"))
                        ),
                    },
                );
                relay.notify();
            }
        }

        self.resolve_thread_workspace(&thread_id, device_id.as_deref())
            .await
            .map_err(ThreadWorkspaceError::into_message)
    }
}

/// Unresolvable ≠ out of scope: the former is "unavailable", the latter is a refusal.
#[derive(Debug, Clone)]
pub(crate) enum ThreadWorkspaceError {
    /// No thread, no cwd, or nothing related to a vanished one survives.
    Unresolvable(String),
    /// The caller may not see this workspace.
    OutOfScope(String),
}

impl ThreadWorkspaceError {
    pub(crate) fn into_message(self) -> String {
        match self {
            Self::Unresolvable(message) | Self::OutOfScope(message) => message,
        }
    }
}

/// Landed write paths, newest first. An empty recent window is not "went home" — walk further, still capped.
fn thread_write_evidence(transcript: &[crate::state::relay::TranscriptRecord]) -> Vec<String> {
    let landed = |record: &crate::state::relay::TranscriptRecord| {
        record
            .tool
            .as_ref()
            .map(|tool| landed_write_paths(std::iter::once((tool, record.status.as_str()))))
            .unwrap_or_default()
    };
    let recent: Vec<String> = transcript
        .iter()
        .rev()
        .take(WRITE_EVIDENCE_SCAN_LIMIT)
        .flat_map(&landed)
        .collect();
    if !recent.is_empty() {
        return recent;
    }
    let mut older = Vec::new();
    for record in transcript.iter().rev().skip(WRITE_EVIDENCE_SCAN_LIMIT) {
        older.extend(landed(record));
        if older.len() >= WRITE_EVIDENCE_SCAN_LIMIT {
            break;
        }
    }
    older
}
