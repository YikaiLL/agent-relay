//! Orchestrator proposals: stage a card; user confirms; then `start_team`.
//!
//! Used by MCP tools and the Tasks composer ("Propose as task"). No tool starts
//! work itself — confirm is a button.

use super::*;
use crate::protocol::{
    ConfirmOrchestratorProposalInput, DismissOrchestratorProposalInput, OrchestratorProposalView,
    ProposeOrchestratorTaskInput, ProposeOrchestratorTaskReceipt, ReviseOrchestratorProposalInput,
    SeatAgentView, StartTeamInput, StartTeamReceipt, TaskSeatAgentsView,
};
use relay_api::team::{BUILTIN_TEAM_ID, BUILTIN_TEAM_NAME, BUILTIN_TEAM_VERSION_ID};

pub(crate) const MAX_PENDING_PROPOSALS: usize = 16;
const MAX_PROPOSAL_TITLE_CHARS: usize = 200;
const MAX_PROPOSAL_FIELD_CHARS: usize = 8_000;

/// Default seat lineup when a proposal names no per-seat override. What the card
/// shows is what the run will use — empty seats must not silently fall through to
/// whichever provider happens to be active in the chat thread.
pub(crate) fn default_task_seat_agents() -> TaskSeatAgentsView {
    TaskSeatAgentsView {
        tl: SeatAgentView {
            provider: Some("claude_code".to_string()),
            model: Some("opus[1m]".to_string()),
            effort: Some("xhigh".to_string()),
        },
        dev: SeatAgentView {
            provider: Some("claude_code".to_string()),
            model: Some("opus[1m]".to_string()),
            effort: Some("xhigh".to_string()),
        },
        reviewer: SeatAgentView {
            provider: Some("codex".to_string()),
            model: Some("gpt-5.6-sol".to_string()),
            effort: Some("high".to_string()),
        },
    }
}

/// Per-seat overrides laid over [`default_task_seat_agents`]. A caller naming
/// only the reviewer's effort must not blank the model the default already chose.
fn merge_task_seat_agents(input: &TaskSeatAgentsView) -> TaskSeatAgentsView {
    let mut merged = default_task_seat_agents();
    merged.merge(input);
    merged
}

impl AppState {
    /// Hold a task spec for confirmation. Does not start a run.
    pub async fn propose_orchestrator_task(
        &self,
        input: ProposeOrchestratorTaskInput,
    ) -> Result<ProposeOrchestratorTaskReceipt, String> {
        if !self.beta_features_enabled().await {
            return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
        }
        let _device_id = require_device_id(input.device_id)?;
        let title = truncate_chars(
            non_empty(Some(input.title)).ok_or_else(|| "title is required".to_string())?,
            MAX_PROPOSAL_TITLE_CHARS,
        );
        let context = truncate_chars(input.context.unwrap_or_default(), MAX_PROPOSAL_FIELD_CHARS);
        let acceptance_criteria = truncate_chars(
            input.acceptance_criteria.unwrap_or_default(),
            MAX_PROPOSAL_FIELD_CHARS,
        );
        let agreed_scope = truncate_chars(
            input.agreed_scope.unwrap_or_default(),
            MAX_PROPOSAL_FIELD_CHARS,
        );
        let quality_rules = truncate_chars(
            input.quality_rules.unwrap_or_default(),
            MAX_PROPOSAL_FIELD_CHARS,
        );
        let why = input
            .why
            .and_then(|value| non_empty(Some(value)))
            .map(|value| truncate_chars(value, MAX_PROPOSAL_FIELD_CHARS));

        // Unknown id → Default; confirm cannot invent a team.
        let (team_id, team_version_id, team_name) =
            self.resolve_proposal_team(input.team_id.as_deref()).await;

        let proposal = OrchestratorProposalView {
            id: format!("orch_prop_{}", crate::state::app::review::random_suffix()),
            kind: "start_task".to_string(),
            reopen_run_id: None,
            title,
            context,
            acceptance_criteria,
            agreed_scope,
            quality_rules,
            team_id,
            team_version_id,
            team_name,
            why,
            // A fresh task IS its definition; only a reopen rewrites one.
            spec_updates: Default::default(),
            agents: merge_task_seat_agents(&input.agents),
            created_at: unix_now(),
        };

        {
            let mut relay = self.relay.write().await;
            if relay.orchestrator_proposals.len() >= MAX_PENDING_PROPOSALS {
                return Err(format!(
                    "too many pending Orchestrator proposals (max {MAX_PENDING_PROPOSALS}); confirm or dismiss one first"
                ));
            }
            relay.orchestrator_proposals.push(proposal.clone());
            relay.notify();
        }

        Ok(ProposeOrchestratorTaskReceipt {
            proposal,
            message: "Proposal ready — confirm to start the task.".to_string(),
        })
    }

    /// Edit a card that is still waiting. Does not start a run.
    ///
    /// Absent fields leave the staged value alone. That is the difference between
    /// a revision and a re-propose: a caller changing only the team must not have
    /// to echo back a title it never read, or it will silently blank it.
    pub async fn revise_orchestrator_proposal(
        &self,
        proposal_id: &str,
        input: ReviseOrchestratorProposalInput,
    ) -> Result<ProposeOrchestratorTaskReceipt, String> {
        if !self.beta_features_enabled().await {
            return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
        }
        let _device_id = require_device_id(input.device_id)?;

        // Resolve team before the write lock (catalog has its own lock).
        let requested_team: Option<String> =
            input.team_id.clone().and_then(|id| non_empty(Some(id)));
        let team = match requested_team.as_deref() {
            Some(requested) => Some(self.resolve_proposal_team(Some(requested)).await),
            None => None,
        };

        let mut relay = self.relay.write().await;
        let proposal = relay
            .orchestrator_proposals
            .iter_mut()
            .find(|entry| entry.id == proposal_id)
            .ok_or_else(|| format!("no pending proposal '{proposal_id}'"))?;

        if let Some(title) = input.title.and_then(|value| non_empty(Some(value))) {
            proposal.title = truncate_chars(title, MAX_PROPOSAL_TITLE_CHARS);
        }
        if let Some(context) = input.context {
            proposal.context = truncate_chars(context, MAX_PROPOSAL_FIELD_CHARS);
        }
        if let Some(criteria) = input.acceptance_criteria {
            proposal.acceptance_criteria = truncate_chars(criteria, MAX_PROPOSAL_FIELD_CHARS);
        }
        if let Some(why) = input.why {
            proposal.why =
                non_empty(Some(why)).map(|value| truncate_chars(value, MAX_PROPOSAL_FIELD_CHARS));
        }
        // Field-by-field: revising one seat's effort must leave the model that
        // seat was already staged with alone.
        proposal.agents.merge(&input.agents);
        if let Some((team_id, team_version_id, team_name)) = team {
            proposal.team_id = team_id;
            proposal.team_version_id = team_version_id;
            proposal.team_name = team_name;
        }
        let updated = proposal.clone();
        relay.notify();
        drop(relay);

        Ok(ProposeOrchestratorTaskReceipt {
            proposal: updated,
            message: "Proposal updated — confirm to start the task.".to_string(),
        })
    }

    /// Stage a card that puts a finished run back to work.
    ///
    /// Eligibility is checked now so the user is not offered a card that will
    /// fail on confirm; it is checked AGAIN on confirm, because the run can
    /// settle differently in between.
    pub async fn propose_orchestrator_reopen(
        &self,
        run_id: Option<String>,
        instruction: &str,
        updates: &relay_api::team::TaskSpecUpdates,
        device_id: Option<String>,
    ) -> Result<ProposeOrchestratorTaskReceipt, String> {
        if !self.beta_features_enabled().await {
            return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
        }
        let _device_id = require_device_id(device_id.clone())?;
        let instruction = non_empty(Some(instruction.to_string()))
            .ok_or_else(|| "say what the team should do now".to_string())?;

        let (target, title) = {
            let relay = self.relay.read().await;
            let target = relay.reopenable_team_run_id(run_id.as_deref())?;
            // The headline reads as the work being asked for NOW, so an
            // overridden title shows on the card the user is approving.
            let title = updates.title.clone().unwrap_or_else(|| {
                relay
                    .team_run(&target)
                    .map(|run| run.spec.title.clone())
                    .unwrap_or_default()
            });
            (target, title)
        };

        let proposal = OrchestratorProposalView {
            id: format!("orch_prop_{}", crate::state::app::review::random_suffix()),
            kind: "reopen_task".to_string(),
            reopen_run_id: Some(target),
            title,
            context: truncate_chars(instruction, MAX_PROPOSAL_FIELD_CHARS),
            acceptance_criteria: String::new(),
            agreed_scope: String::new(),
            quality_rules: String::new(),
            team_id: String::new(),
            team_version_id: String::new(),
            team_name: String::new(),
            why: None,
            spec_updates: updates.clone(),
            agents: merge_task_seat_agents(&Default::default()),
            created_at: unix_now(),
        };

        {
            let mut relay = self.relay.write().await;
            if relay.orchestrator_proposals.len() >= MAX_PENDING_PROPOSALS {
                return Err(format!(
                    "too many pending Orchestrator proposals (max {MAX_PENDING_PROPOSALS}); confirm or dismiss one first"
                ));
            }
            relay.orchestrator_proposals.push(proposal.clone());
            relay.notify();
        }

        Ok(ProposeOrchestratorTaskReceipt {
            proposal,
            message: "Reopen ready — confirm to put the team back on it.".to_string(),
        })
    }

    /// Apply a pending proposal via the ordinary `start_team` path.
    pub async fn confirm_orchestrator_proposal(
        &self,
        proposal_id: &str,
        input: ConfirmOrchestratorProposalInput,
    ) -> Result<StartTeamReceipt, String> {
        if !self.beta_features_enabled().await {
            return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
        }
        let device_id = require_device_id(input.device_id)?;
        let proposal = {
            let mut relay = self.relay.write().await;
            let index = relay
                .orchestrator_proposals
                .iter()
                .position(|entry| entry.id == proposal_id)
                .ok_or_else(|| format!("proposal `{proposal_id}` is gone or already settled"))?;
            // Drop before start so a double-click cannot start twice.
            relay.orchestrator_proposals.remove(index)
        };

        if proposal.kind == "reopen_task" {
            let target = proposal.reopen_run_id.clone();
            let status = self
                .reopen_team_run(
                    target.clone(),
                    &proposal.context,
                    &proposal.spec_updates,
                    Some(device_id),
                )
                .await?;
            let run = self.team_run_snapshot(&target.unwrap_or_default()).await;
            return Ok(StartTeamReceipt {
                team_run_id: run.as_ref().map(|run| run.id.clone()).unwrap_or_default(),
                cwd: run.as_ref().map(|run| run.cwd.clone()).unwrap_or_default(),
                branch: run.map(|run| run.branch).unwrap_or_default(),
                status: status.as_str().to_string(),
                message: "Reopened — the team lead re-reads the task first.".to_string(),
            });
        }

        let receipt = self
            .start_team(StartTeamInput {
                title: proposal.title.clone(),
                context: proposal.context.clone(),
                acceptance_criteria: proposal.acceptance_criteria.clone(),
                agreed_scope: proposal.agreed_scope.clone(),
                quality_rules: proposal.quality_rules.clone(),
                cwd: None,
                target_branch: None,
                // The card's whole point is that what the user confirmed is
                // what runs. Dropping these here would start every task on the
                // relay default while the card said otherwise.
                tl_provider: proposal.agents.tl.provider.clone(),
                dev_agents: Some(1),
                dev_provider: proposal.agents.dev.provider.clone(),
                reviewer_provider: proposal.agents.reviewer.provider.clone(),
                tl_model: proposal.agents.tl.model.clone(),
                dev_model: proposal.agents.dev.model.clone(),
                reviewer_model: proposal.agents.reviewer.model.clone(),
                tl_effort: proposal.agents.tl.effort.clone(),
                dev_effort: proposal.agents.dev.effort.clone(),
                reviewer_effort: proposal.agents.reviewer.effort.clone(),
                device_id: Some(device_id),
            })
            .await;

        if receipt.is_err() {
            let mut relay = self.relay.write().await;
            if !relay
                .orchestrator_proposals
                .iter()
                .any(|entry| entry.id == proposal.id)
            {
                relay.orchestrator_proposals.push(proposal);
            }
            relay.notify();
        } else {
            self.relay.write().await.notify();
        }

        receipt
    }

    pub async fn dismiss_orchestrator_proposal(
        &self,
        proposal_id: &str,
        input: DismissOrchestratorProposalInput,
    ) -> Result<(), String> {
        if !self.beta_features_enabled().await {
            return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
        }
        let _device_id = require_device_id(input.device_id)?;
        let mut relay = self.relay.write().await;
        let before = relay.orchestrator_proposals.len();
        relay
            .orchestrator_proposals
            .retain(|entry| entry.id != proposal_id);
        if relay.orchestrator_proposals.len() == before {
            return Err(format!(
                "proposal `{proposal_id}` is gone or already settled"
            ));
        }
        relay.notify();
        Ok(())
    }

    async fn resolve_proposal_team(&self, requested: Option<&str>) -> (String, String, String) {
        let requested = requested
            .and_then(|value| non_empty(Some(value.to_string())))
            .unwrap_or_else(|| BUILTIN_TEAM_ID.to_string());
        let catalog = self.team_catalog().await;
        if let Some(team) = catalog.teams.iter().find(|team| team.id == requested) {
            return (
                team.id.clone(),
                team.current_version_id.clone(),
                team.name.clone(),
            );
        }
        (
            BUILTIN_TEAM_ID.to_string(),
            BUILTIN_TEAM_VERSION_ID.to_string(),
            BUILTIN_TEAM_NAME.to_string(),
        )
    }
}

fn truncate_chars(value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::app::tests::path_scope_tests::{build_app, pair_device};
    use tempfile::TempDir;

    async fn beta_app(cwd: &str) -> AppState {
        let (app, _p, _o) = build_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;
        app
    }

    #[tokio::test]
    async fn propose_then_dismiss_clears_the_card() {
        let project = TempDir::new().expect("project");
        let cwd = project.path().to_string_lossy().to_string();
        let app = beta_app(&cwd).await;

        let receipt = app
            .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                title: "Add a parser".to_string(),
                context: Some("Context for the TL.".to_string()),
                acceptance_criteria: None,
                agreed_scope: None,
                quality_rules: None,
                team_id: None,
                why: Some("Touches the CLI surface.".to_string()),
                agents: Default::default(),
                device_id: Some("device-1".to_string()),
            })
            .await
            .expect("propose");
        assert_eq!(receipt.proposal.title, "Add a parser");
        assert_eq!(receipt.proposal.team_id, BUILTIN_TEAM_ID);
        assert_eq!(
            receipt.proposal.agents.tl.provider.as_deref(),
            Some("claude_code")
        );
        assert_eq!(
            receipt.proposal.agents.dev.model.as_deref(),
            Some("opus[1m]")
        );
        assert_eq!(
            receipt.proposal.agents.reviewer.effort.as_deref(),
            Some("high")
        );
        assert_eq!(
            app.snapshot().await.orchestrator_proposals.len(),
            1,
            "snapshot must carry the pending card"
        );

        app.dismiss_orchestrator_proposal(
            &receipt.proposal.id,
            DismissOrchestratorProposalInput {
                device_id: Some("device-1".to_string()),
            },
        )
        .await
        .expect("dismiss");
        assert!(
            app.snapshot().await.orchestrator_proposals.is_empty(),
            "dismiss must drop the card from the snapshot"
        );
    }

    #[tokio::test]
    async fn confirm_without_a_team_driver_restores_the_proposal() {
        let project = TempDir::new().expect("project");
        let cwd = project.path().to_string_lossy().to_string();
        let app = beta_app(&cwd).await;
        app.relay.write().await.trusted_workspaces.push(cwd.clone());

        let receipt = app
            .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                title: "Needs a driver".to_string(),
                context: None,
                acceptance_criteria: None,
                agreed_scope: None,
                quality_rules: None,
                team_id: None,
                why: None,
                agents: Default::default(),
                device_id: Some("device-1".to_string()),
            })
            .await
            .expect("propose");
        let id = receipt.proposal.id.clone();

        let err = app
            .confirm_orchestrator_proposal(
                &id,
                ConfirmOrchestratorProposalInput {
                    device_id: Some("device-1".to_string()),
                },
            )
            .await
            .expect_err("confirm must fail without a team driver");
        assert!(
            err.contains("task team is not available") || err.contains("decision"),
            "unexpected error: {err}"
        );
        assert_eq!(
            app.snapshot().await.orchestrator_proposals.len(),
            1,
            "a failed confirm must put the card back"
        );
        assert_eq!(app.snapshot().await.orchestrator_proposals[0].id, id);
    }

    /// The trap this operation exists to avoid: a caller changing only the team
    /// must not blank the fields it never sent. A re-propose would; a revise
    /// must not.
    #[tokio::test]
    async fn revising_one_field_leaves_the_others_alone() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, _p, _o) = build_app(&cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;

        let staged = app
            .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                title: "Add a parser".to_string(),
                context: Some("Touch the CLI.".to_string()),
                acceptance_criteria: Some("Tests green.".to_string()),
                device_id: Some("device-1".to_string()),
                ..Default::default()
            })
            .await
            .expect("propose")
            .proposal;

        let revised = app
            .revise_orchestrator_proposal(
                &staged.id,
                ReviseOrchestratorProposalInput {
                    why: Some("They own the CLI.".to_string()),
                    device_id: Some("device-1".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("revise")
            .proposal;

        assert_eq!(revised.id, staged.id, "a revision is not a new card");
        assert_eq!(revised.title, "Add a parser");
        assert_eq!(revised.context, "Touch the CLI.");
        assert_eq!(revised.acceptance_criteria, "Tests green.");
        assert_eq!(revised.why.as_deref(), Some("They own the CLI."));

        let pending = app.snapshot().await.orchestrator_proposals;
        assert_eq!(pending.len(), 1, "revising must not stage a second card");
    }

    #[tokio::test]
    async fn revising_a_card_that_is_gone_says_so() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, _p, _o) = build_app(&cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;

        let err = app
            .revise_orchestrator_proposal(
                "orch_prop_missing",
                ReviseOrchestratorProposalInput {
                    title: Some("x".to_string()),
                    device_id: Some("device-1".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect_err("a dismissed or confirmed card cannot be revised");
        assert!(err.contains("no pending proposal"), "{err}");
    }

    /// A revision must not become a way to blank a card: a title is the one field
    /// a task cannot do without, so an empty one is ignored rather than applied.
    #[tokio::test]
    async fn a_revision_cannot_empty_the_title() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, _p, _o) = build_app(&cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;

        let staged = app
            .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                title: "Add a parser".to_string(),
                device_id: Some("device-1".to_string()),
                ..Default::default()
            })
            .await
            .expect("propose")
            .proposal;

        let revised = app
            .revise_orchestrator_proposal(
                &staged.id,
                ReviseOrchestratorProposalInput {
                    title: Some("   ".to_string()),
                    device_id: Some("device-1".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("revise")
            .proposal;
        assert_eq!(revised.title, "Add a parser");
    }

    #[tokio::test]
    async fn propose_requires_a_title() {
        let project = TempDir::new().expect("project");
        let cwd = project.path().to_string_lossy().to_string();
        let app = beta_app(&cwd).await;
        let err = app
            .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                title: "   ".to_string(),
                context: None,
                acceptance_criteria: None,
                agreed_scope: None,
                quality_rules: None,
                team_id: None,
                why: None,
                agents: Default::default(),
                device_id: Some("device-1".to_string()),
            })
            .await
            .expect_err("blank title");
        assert!(err.contains("title"));
    }
}
