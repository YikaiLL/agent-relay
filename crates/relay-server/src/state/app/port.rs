//! What the relay grants a private orchestrator.
//!
//! This is the ENTIRE capability surface handed across the seam — an orchestrator
//! can do exactly what `RelayPort` declares and nothing else. Adding a method here
//! is a deliberate, reviewable widening; there is no ambient `use super::*` on the
//! other side to smuggle one in.
//!
//! Nothing here reads or writes an engine's own run records. Each engine owns its
//! state outright, which is what lets a build with no engine registered compile
//! untouched: no storage to leave dangling, no `cfg` threaded through the guards.

use relay_api::{CodeFlowSpec, RelayPort, ResolvedParent, RunStatus};

use super::*;

#[async_trait::async_trait]
impl RelayPort for AppState {
    type SessionSlot = tokio::sync::OwnedMutexGuard<()>;

    async fn expire_stale_controller_if_needed(&self) {
        AppState::expire_stale_controller_if_needed(self).await;
    }

    fn resolve_provider(&self, name: &str) -> Result<(), String> {
        AppState::resolve_provider(self, Some(name)).map(|_| ())
    }

    fn acquire_session_slot(&self) -> Result<Self::SessionSlot, String> {
        AppState::acquire_session_slot(self)
    }

    async fn authorize_and_resolve_workflow_parent(
        &self,
        device_id: &str,
        parent_thread_id: Option<String>,
    ) -> Result<ResolvedParent, String> {
        let (thread_id, provider, cwd) =
            AppState::authorize_and_resolve_workflow_parent(self, device_id, parent_thread_id)
                .await?;
        Ok(ResolvedParent {
            thread_id,
            provider,
            cwd,
        })
    }

    async fn start_code_flow(&self, spec: CodeFlowSpec) -> Result<String, String> {
        self.start_code_flow_internal(
            &spec.device_id,
            &spec.prompt,
            &spec.reviewer_provider,
            spec.reviewer_model,
            spec.reviewer_instructions,
            spec.max_rounds,
            spec.parent_thread_id,
            spec.anchor_item_id,
        )
        .await
    }

    /// Block until child workflow `child_id` settles.
    ///
    /// `Blocked` counts as settled on purpose: the child owns stuck threads and
    /// cannot make progress on its own, so a caller waiting for "terminal" would
    /// wait forever. A vanished child reads as `Failed` rather than hanging.
    async fn wait_for_workflow(&self, child_id: &str) -> (RunStatus, Option<bool>) {
        let mut rx = self.subscribe();
        loop {
            {
                let relay = self.relay.read().await;
                match relay.workflow_run(child_id) {
                    Some(run)
                        if run.status.is_terminal() || matches!(run.status, RunStatus::Blocked) =>
                    {
                        return (run.status, run.last_verdict.as_ref().map(|v| v.approved));
                    }
                    Some(_) => {}
                    None => return (RunStatus::Failed, None),
                }
            }
            // The sender is gone: read once more so a run that settled in the gap
            // is still reported, then stop.
            if rx.changed().await.is_err() {
                let relay = self.relay.read().await;
                return match relay.workflow_run(child_id) {
                    Some(run) => (run.status, run.last_verdict.as_ref().map(|v| v.approved)),
                    None => (RunStatus::Failed, None),
                };
            }
        }
    }

    async fn push_log(&self, level: &str, message: String) {
        self.relay.write().await.push_log(level, message);
    }

    async fn notify(&self) {
        self.relay.write().await.notify();
    }
}
