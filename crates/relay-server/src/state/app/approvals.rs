use super::*;

impl AppState {
    pub async fn read_ask_user_question_detail(
        &self,
        request_id: &str,
        device_id: Option<String>,
    ) -> Result<AskUserQuestionDetailResponse, String> {
        let device_id = require_device_id(device_id)?;
        let request = {
            let relay = self.relay.read().await;
            relay.ensure_device_can_approve(&device_id)?;
            relay
                .pending_ask_user_questions
                .get(request_id)
                .cloned()
                .ok_or_else(|| "there is no AskUserQuestion waiting for remote detail".to_string())?
                .to_view()
        };

        Ok(AskUserQuestionDetailResponse { request })
    }

    pub async fn decide_approval(
        &self,
        request_id: &str,
        input: ApprovalDecisionInput,
    ) -> Result<ApprovalReceipt, ApprovalError> {
        let device_id =
            require_device_id(input.device_id.clone()).map_err(ApprovalError::Bridge)?;
        let _slot = self.acquire_session_slot().map_err(ApprovalError::Bridge)?;
        let pending = {
            let relay = self.relay.read().await;
            relay
                .ensure_device_can_approve(&device_id)
                .map_err(ApprovalError::Bridge)?;
            let pending = relay
                .pending_approvals
                .get(request_id)
                .cloned()
                .ok_or(ApprovalError::NoPendingRequest)?;
            // A reviewer thread's approvals belong to the review (the orchestrator
            // auto-denies them) — block user decisions so a write can't be approved
            // out from under it. Approvals on any OTHER thread stay decidable.
            if relay.is_thread_review_locked(&pending.thread_id) {
                return Err(ApprovalError::Bridge(REVIEW_LOCKED_THREAD_MSG.to_string()));
            }
            if relay.is_thread_or_cwd_workflow_locked(&pending.thread_id) {
                return Err(ApprovalError::Bridge(
                    WORKFLOW_LOCKED_THREAD_MSG.to_string(),
                ));
            }
            pending
        };

        let bridge = if pending.thread_id.is_empty() {
            self.require_active_provider()
                .map_err(ApprovalError::Bridge)?
                .1
        } else {
            self.find_thread_provider(&pending.thread_id)
                .await
                .map_err(ApprovalError::Bridge)?
                .1
        };

        bridge
            .respond_to_approval(&pending, &input)
            .await
            .map_err(ApprovalError::Bridge)?;

        let mut relay = self.relay.write().await;
        relay.remove_pending_approval(request_id);
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

    pub async fn submit_ask_user_answer(
        &self,
        request_id: &str,
        input: SubmitAskUserAnswerInput,
    ) -> Result<AskUserAnswerReceipt, AskUserAnswerError> {
        let device_id =
            require_device_id(input.device_id.clone()).map_err(AskUserAnswerError::Bridge)?;
        // A review is single-round and non-interactive; block answering questions
        // (the orchestrator dismisses the reviewer's own).
        let _slot = self
            .acquire_session_slot()
            .map_err(AskUserAnswerError::Bridge)?;
        if input.answers.is_empty() {
            return Err(AskUserAnswerError::NoAnswers);
        }
        let pending = {
            let relay = self.relay.read().await;
            relay
                .ensure_device_can_approve(&device_id)
                .map_err(AskUserAnswerError::Bridge)?;
            relay.pending_ask_user_questions.get(request_id).cloned()
        };
        let pending = pending.ok_or(AskUserAnswerError::NoPendingRequest)?;
        // A reviewer thread's questions belong to the review — block answering them.
        // Questions on any other thread stay answerable.
        if !pending.thread_id.is_empty() {
            let relay = self.relay.read().await;
            if relay.is_thread_review_locked(&pending.thread_id) {
                return Err(AskUserAnswerError::Bridge(
                    REVIEW_LOCKED_THREAD_MSG.to_string(),
                ));
            }
            if relay.is_thread_or_cwd_workflow_locked(&pending.thread_id) {
                return Err(AskUserAnswerError::Bridge(
                    WORKFLOW_LOCKED_THREAD_MSG.to_string(),
                ));
            }
        }

        let bridge = if pending.thread_id.is_empty() {
            self.require_active_provider()
                .map_err(AskUserAnswerError::Bridge)?
                .1
        } else {
            self.find_thread_provider(&pending.thread_id)
                .await
                .map_err(AskUserAnswerError::Bridge)?
                .1
        };

        bridge
            .respond_to_ask_user_question(request_id, &input.answers)
            .await
            .map_err(AskUserAnswerError::Bridge)?;

        let mut relay = self.relay.write().await;
        relay.remove_pending_ask_user_question(request_id);
        if relay.pending_ask_user_questions.is_empty() {
            let tid = pending.thread_id;
            if !tid.is_empty() {
                relay.set_thread_status(&tid, "active".to_string(), Vec::new());
                if relay.active_thread_id.as_deref() != Some(tid.as_str()) {
                    relay.bg_set_thread_status(
                        &tid,
                        "active".to_string(),
                        Vec::new(),
                        crate::state::unix_now(),
                    );
                }
            }
        }
        relay.push_log(
            "info",
            format!(
                "AskUserQuestion {request_id} answered by {}.",
                short_device_id(&device_id)
            ),
        );
        relay.notify();

        Ok(AskUserAnswerReceipt {
            request_id: request_id.to_string(),
            message: "Answer sent to Claude.".to_string(),
        })
    }

    pub async fn workspace_diff(
        &self,
        device_id: Option<String>,
        thread_id: Option<String>,
        root: Option<String>,
        auto_root: bool,
    ) -> Result<WorkspaceDiffResponse, String> {
        let (cwd, relay_cwd, device_scope, allowed_roots) = {
            let relay = self.relay.read().await;
            // Resolve which workspace to diff:
            // - absent selector       → the global/active cwd (legacy back-compat)
            // - present & resolvable   → the *viewed* session's own workspace
            // - present & unresolvable → fail closed; NEVER fall back to the active
            //   cwd, which would show (and, for a broad-scope remote device, leak)
            //   another workspace's diff.
            let resolved = match thread_id.as_deref() {
                None => relay.current_cwd.clone(),
                Some(thread_id) => match relay.thread_cwd(thread_id) {
                    Some(cwd) => cwd,
                    None => return Ok(WorkspaceDiffResponse::unavailable()),
                },
            };
            let device_scope = device_id
                .as_deref()
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            ensure_path_within_device_scope(&resolved, &device_scope, &relay.allowed_roots)?;
            (
                resolved,
                relay.current_cwd.clone(),
                device_scope,
                relay.allowed_roots.clone(),
            )
        };

        // That workspace may no longer EXIST — a thread born in an agent worktree keeps its
        // path after the worktree is removed. Spawning git there fails with ENOENT, which
        // used to reach the panel verbatim ("failed to run git rev-parse
        // --is-inside-work-tree: No such file or directory (os error 2)") and took the root
        // picker with it, leaving no way back. Degrade to a workspace that is provably
        // related, in scope — or fail closed — and report WHICH one vanished.
        let (workspace, fallback_from) =
            match super::resolve_workspace_cwd(&cwd, &relay_cwd, &device_scope, &allowed_roots)
                .await
                .into_readable()
            {
                Some(usable) => usable,
                None => return Ok(WorkspaceDiffResponse::unavailable()),
            };
        let cwd = workspace.as_str().to_string();

        // Enumerate from the session's OWN cwd, which has just cleared the scope
        // check. This is the only source of selectable roots, so the picker can
        // never name a repo the viewed session has no access to.
        //
        // Then drop every root the caller may not see. A linked worktree routinely
        // lives OUTSIDE the session cwd's subtree, so "is a worktree of this repo" is
        // not on its own permission to know it exists: for a narrow-scoped device the
        // path and branch name are themselves privileged topology. Filtering here (not
        // just at selection time) also keeps the picker honest — every option it shows
        // is one that will actually load.
        let roots: Vec<WorkspaceRootView> = super::list_worktrees(&cwd)
            .await
            .into_iter()
            .filter(|candidate| {
                path_within_device_scope(&candidate.path, &device_scope, &allowed_roots)
            })
            .collect();

        // Where this thread has actually been writing, derived (never stored) from its
        // own transcript tail. Reported for the picker; only ACTED on when the client
        // explicitly asks via `auto_root`, so a plain refresh can never move the panel
        // out from under someone reading it.
        // `known` distinguishes "looked, nothing to suggest" from "could not look yet"
        // (a cold thread whose transcript has not loaded). Without that distinction a
        // client burns its one-shot auto-resolve on a thread whose history has not
        // arrived, and never re-resolves.
        let (suggested, suggested_root_known) = match thread_id.as_deref() {
            // No thread selected: nothing to attribute, and that IS the final answer.
            None => (None, true),
            Some(tid) => {
                let relay = self.relay.read().await;
                match relay.runtime_for_thread(tid) {
                    None => (None, false),
                    Some(runtime) => (
                        super::suggested_root_from_tools(
                            runtime
                                .transcript
                                .iter()
                                .rev()
                                .take(super::SUGGESTED_ROOT_SCAN_LIMIT)
                                .filter_map(|record| {
                                    // Status travels WITH the tool: whether a write landed
                                    // is the deciding factor, and dropping it here is what
                                    // let a failed edit count as evidence.
                                    record
                                        .tool
                                        .as_ref()
                                        .map(|tool| (tool, record.status.as_str()))
                                }),
                            &roots,
                        ),
                        true,
                    ),
                }
            }
        };
        // Only a root DIFFERENT from the session's own cwd is worth suggesting; the
        // panel already defaults there.
        let suggested = suggested.filter(|candidate| !super::paths_equivalent(candidate, &cwd));

        let target = match root {
            // Adopt the suggestion only on an explicit opt-in from the client, which
            // sends it once per thread switch (see the picker's auto-resolve).
            None if auto_root => suggested.clone().unwrap_or(cwd),
            None => cwd,
            Some(requested) => {
                // Gate 1 — membership: the request must name a worktree we just
                // enumerated. Resolve to the ENUMERATED path and hand *that* to git;
                // the caller's own string is never used as a filesystem path, so a
                // crafted selector cannot reach a tree we did not enumerate.
                let Some(matched) = roots
                    .iter()
                    .find(|candidate| super::paths_equivalent(&candidate.path, &requested))
                else {
                    return Ok(WorkspaceDiffResponse::unavailable());
                };
                // Gate 2 — device scope. Redundant by construction now that `roots` is
                // pre-filtered, and deliberately kept: it is the check that actually
                // enforces the boundary, so it must not depend on a caller elsewhere
                // remembering to filter first.
                ensure_path_within_device_scope(&matched.path, &device_scope, &allowed_roots)?;
                matched.path.clone()
            }
        };

        // Resilient because the resolve above and this collect are two steps: a cleanup task
        // can remove the tree in between, and the panel must not go back to showing a raw
        // git spawn error when it loses that race.
        let (mut response, retry_fallback) = super::collect_workspace_diff_resilient(
            &target,
            &relay_cwd,
            &device_scope,
            &allowed_roots,
        )
        .await?;
        if response.unavailable {
            return Ok(response);
        }
        response.roots = roots;
        response.suggested_root = suggested;
        response.suggested_root_known = suggested_root_known;
        response.fallback_from = fallback_from.or(retry_fallback);
        Ok(response)
    }

    pub async fn apply_file_change(
        &self,
        item_id: &str,
        input: ApplyFileChangeInput,
    ) -> Result<ApplyFileChangeReceipt, String> {
        let device_id = require_device_id(input.device_id)?;
        let requested_thread =
            non_empty(Some(input.thread_id)).ok_or_else(|| "thread_id is required".to_string())?;
        // Rollback/reapply mutates the working tree; block it while a review reads
        // that same tree.
        let _slot = self.acquire_session_slot()?;
        self.ensure_thread_runtime_loaded(&requested_thread, &device_id)
            .await?;
        let (thread_id, cwd, diff) = {
            let relay = self.relay.read().await;
            let thread_id = requested_thread;
            if relay.is_thread_review_locked(&thread_id) {
                return Err(REVIEW_LOCKED_THREAD_MSG.to_string());
            }
            if relay.is_thread_or_cwd_workflow_locked(&thread_id) {
                return Err(WORKFLOW_LOCKED_THREAD_MSG.to_string());
            }
            let runtime = relay
                .runtime_for_thread(&thread_id)
                .ok_or_else(|| format!("thread `{thread_id}` is not loaded"))?;
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(
                &runtime.current_cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
            let entry = runtime
                .transcript
                .iter()
                .find(|entry| entry.item_id == item_id)
                .ok_or_else(|| format!("file change `{item_id}` was not found"))?;
            let tool = entry
                .tool
                .as_ref()
                .ok_or_else(|| format!("entry `{item_id}` is not a file change"))?;
            // Same selector the snapshot's `can_apply` verdict is computed from, so the
            // two cannot disagree about what "this patch" means.
            let diff = crate::protocol::patch_for_apply(tool)
                .ok_or_else(|| format!("file change `{item_id}` has no diff to apply"))?;
            (thread_id, runtime.current_cwd.clone(), diff)
        };

        apply_unified_diff(&cwd, &diff, input.direction).await?;

        let mut relay = self.relay.write().await;
        relay.set_file_change_apply_state_for_thread(
            &thread_id,
            item_id,
            match input.direction {
                FileChangeApplyDirection::Rollback => {
                    crate::protocol::FileChangeApplyState::RolledBack
                }
                FileChangeApplyDirection::Reapply => crate::protocol::FileChangeApplyState::Applied,
            },
        );
        relay.push_log(
            "info",
            format!(
                "{} file change {item_id} from {}.",
                match input.direction {
                    FileChangeApplyDirection::Rollback => "Rolled back",
                    FileChangeApplyDirection::Reapply => "Reapplied",
                },
                short_device_id(&device_id)
            ),
        );
        relay.notify();

        Ok(ApplyFileChangeReceipt {
            item_id: item_id.to_string(),
            direction: input.direction,
            resulting_state: "diff_applied".to_string(),
            message: match input.direction {
                FileChangeApplyDirection::Rollback => "File change rolled back.".to_string(),
                FileChangeApplyDirection::Reapply => "File change reapplied.".to_string(),
            },
        })
    }
}
