//! Execute Orchestrator tool calls.
//!
//! Registry (`crate::orchestrator_tools`) defines what may be called; this
//! module runs it. Node MCP is a dumb proxy — schemas and handlers stay in Rust.
//! Every arm routes to an existing relay operation (un-privileged vs Tasks UI).

use super::team::TeamAction2;
use super::*;
use crate::orchestrator_tools::{self, ToolCall, WorkspaceFacts};
use crate::protocol::{
    ProposeOrchestratorTaskInput, ReviseOrchestratorProposalInput, SubmitAskUserAnswerInput,
    TeamActionInput,
};
use serde_json::{json, Value};

/// Caps on one `pending_questions` reply (tool results sit in model context).
const MAX_QUESTIONS_PER_REQUEST: usize = 8;
const MAX_OPTIONS_PER_QUESTION: usize = 12;
/// Max chars of a sub-task summary in a status line.
const SUMMARY_LINE_MAX_CHARS: usize = 160;

/// First non-empty summary line, truncated on a char boundary.
fn first_line_bounded(summary: &str) -> &str {
    let line = summary
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let line = line.trim();
    match line.char_indices().nth(SUMMARY_LINE_MAX_CHARS) {
        Some((index, _)) => &line[..index],
        None => line,
    }
}

/// One seat's question, joined to the run still waiting on it.
struct SeatQuestion<'a> {
    request: &'a crate::state::relay::PendingAskUserQuestion,
    run: &'a relay_api::team::TeamRun,
    role: &'a str,
}

/// Live seat questions the Orchestrator may answer.
///
/// Derived from non-terminal runs' `awaiting`, not the pending-ask map alone —
/// cancelled runs clear `awaiting` but leave pending entries for audit, which
/// would keep question tools on offer and let answers hit dead threads.
/// Team seats only; shared by `pending_questions` and `task_status`.
fn live_seat_questions(relay: &RelayState) -> Vec<SeatQuestion<'_>> {
    let mut found: Vec<SeatQuestion<'_>> = relay
        .team_runs_snapshot()
        .filter(|run| !run.status.is_terminal())
        .filter_map(|run| {
            let awaiting = run.awaiting.as_ref()?;
            let request = relay.pending_ask_user_questions.get(&awaiting.request_id)?;
            Some(SeatQuestion {
                request,
                run,
                role: awaiting.role.as_str(),
            })
        })
        .collect();
    // Oldest first.
    found.sort_by_key(|question| question.request.requested_at);
    found
}

/// One tool, as MCP wants to see it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct OrchestratorToolView {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

impl AppState {
    /// What the workspace can currently answer.
    ///
    /// Read under one lock: these numbers only mean anything together. Sampling
    /// them separately could offer `control_run` for a run that finished between
    /// two reads — a tool call that can only fail.
    pub async fn orchestrator_tool_facts(&self) -> WorkspaceFacts {
        let (pending_proposals, active_runs, known_runs, parked_questions) = {
            let relay = self.relay.read().await;
            (
                relay.orchestrator_proposals.len(),
                relay
                    .team_runs_snapshot()
                    .filter(|run| !run.status.is_terminal())
                    .count(),
                relay.team_runs_snapshot().count(),
                live_seat_questions(&relay).len(),
            )
        };
        WorkspaceFacts {
            pending_proposals,
            active_runs,
            known_runs,
            parked_questions,
            known_teams: self.team_catalog().await.teams.len(),
        }
    }

    /// The tools worth offering right now, ready to hand to a model.
    ///
    /// Gated exactly as `call_orchestrator_tool` is. The two MUST agree: a list
    /// that advertises what every call refuses is worse than an empty one,
    /// because the model has no way to learn the difference except by trying —
    /// which is the retry loop the availability filter exists to prevent.
    pub async fn list_orchestrator_tools(&self) -> Vec<OrchestratorToolView> {
        if !self.beta_features_enabled().await {
            return Vec::new();
        }
        let facts = self.orchestrator_tool_facts().await;
        orchestrator_tools::available_tools(&facts)
            .into_iter()
            .map(|spec| OrchestratorToolView {
                name: spec.name.to_string(),
                description: spec.summary.to_string(),
                input_schema: spec.input_schema(),
            })
            .collect()
    }

    /// Run a tool; `Err` is a refused call for the model to read (not HTTP 500).
    pub async fn call_orchestrator_tool(
        &self,
        name: &str,
        args: &Value,
        device_id: Option<String>,
    ) -> Result<String, String> {
        if !self.beta_features_enabled().await {
            return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
        }
        // Re-check availability: the model's list may be a turn old.
        let facts = self.orchestrator_tool_facts().await;
        if !orchestrator_tools::available_tools(&facts)
            .iter()
            .any(|spec| spec.name == name)
        {
            return Err(match orchestrator_tools::spec_for(name) {
                Some(_) => format!("{name} is not available right now"),
                None => format!("no such tool: {name}"),
            });
        }

        match orchestrator_tools::parse_call(name, args)? {
            ToolCall::ProposeTask {
                title,
                context,
                acceptance_criteria,
                team_id,
                why,
            } => {
                let receipt = self
                    .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                        title,
                        context,
                        acceptance_criteria,
                        team_id,
                        why,
                        device_id,
                        ..Default::default()
                    })
                    .await?;
                Ok(format!(
                    "Staged proposal {} for {}. It has NOT started — the user confirms the card.",
                    receipt.proposal.id, receipt.proposal.team_name
                ))
            }
            ToolCall::ReviseProposal {
                proposal_id,
                title,
                context,
                team_id,
                why,
            } => {
                let receipt = self
                    .revise_orchestrator_proposal(
                        &proposal_id,
                        ReviseOrchestratorProposalInput {
                            title,
                            context,
                            team_id,
                            why,
                            device_id,
                            ..Default::default()
                        },
                    )
                    .await?;
                Ok(format!(
                    "Updated {} — now targeting {}. Still waiting on the user.",
                    receipt.proposal.id, receipt.proposal.team_name
                ))
            }
            ToolCall::ListTeams => {
                let catalog = self.team_catalog().await;
                if catalog.teams.is_empty() {
                    return Ok("No teams are defined.".to_string());
                }
                let lines: Vec<String> = catalog
                    .teams
                    .iter()
                    .map(|team| format!("{} ({})", team.name, team.id))
                    .collect();
                Ok(lines.join("\n"))
            }
            ToolCall::PendingQuestions => {
                let relay = self.relay.read().await;
                let blocks: Vec<String> = live_seat_questions(&relay)
                    .iter()
                    .map(|parked| {
                        let SeatQuestion { request, run, role } = parked;
                        let mut block = format!(
                            "{} — {role} on {} (\"{}\")",
                            request.request_id, run.id, run.spec.title
                        );
                        for question in request.questions.iter().take(MAX_QUESTIONS_PER_REQUEST) {
                            // Header keys `respond_to_agent` answers.
                            // Question text first, because that IS the answer
                            // key: `resolveAskUserAnswers` in the worker matches
                            // the map on it. The header is a label the UI groups
                            // by — printing it first invites the model to key by
                            // it, and a key matching no question is forwarded
                            // verbatim and silently dropped.
                            block.push_str(&format!(
                                "\n  {}{}  [{}]",
                                question.question,
                                if question.multi_select {
                                    " (choose any)"
                                } else {
                                    ""
                                },
                                question.header
                            ));
                            for option in question.options.iter().take(MAX_OPTIONS_PER_QUESTION) {
                                block.push_str(&format!("\n    - {}", option.label));
                                if !option.description.is_empty() {
                                    block.push_str(&format!(": {}", option.description));
                                }
                            }
                        }
                        block.push_str(&format!(
                            "\n  answer with respond_to_agent(request_id=\"{}\", \
answers keyed by the question text above)",
                            request.request_id
                        ));
                        block
                    })
                    .collect();
                if blocks.is_empty() {
                    return Ok("Nobody is waiting on you.".to_string());
                }
                Ok(blocks.join("\n\n"))
            }
            ToolCall::TaskStatus { run_id } => {
                let relay = self.relay.read().await;
                let lines: Vec<String> = relay
                    .team_runs_snapshot()
                    .filter(|run| run_id.as_deref().is_none_or(|wanted| run.id == wanted))
                    .map(|run| {
                        let mut block = format!(
                            "{} — {} ({}), phase {}",
                            run.id,
                            run.spec.title,
                            run.status.as_str(),
                            run.phase.as_str()
                        );
                        for (index, task) in run.sub_tasks.iter().enumerate() {
                            block.push_str(&format!(
                                "\n  {}. {} ({})",
                                index + 1,
                                task.title,
                                task.status.as_str()
                            ));
                            if task.rounds_used > 0 {
                                block.push_str(&format!(", {} review round(s)", task.rounds_used));
                            }
                            if let Some(summary) = task
                                .result_summary
                                .as_deref()
                                .map(str::trim)
                                .filter(|summary| !summary.is_empty())
                            {
                                block.push_str(" — ");
                                block.push_str(first_line_bounded(summary));
                            }
                        }
                        if let Some(awaiting) = run.awaiting.as_ref() {
                            block.push_str(&format!(
                                "\n  WAITING ON YOU: {} asked something ({}) — \
pending_questions to read it",
                                awaiting.role, awaiting.request_id
                            ));
                        }
                        block
                    })
                    .collect();
                if lines.is_empty() {
                    return Ok(match run_id {
                        Some(id) => format!("No run {id}."),
                        None => "No tasks.".to_string(),
                    });
                }
                Ok(lines.join("\n"))
            }
            ToolCall::ControlRun { action, run_id } => {
                let action = match action.as_str() {
                    "pause" => TeamAction2::Pause,
                    "resume" => TeamAction2::Resume,
                    "stop" => TeamAction2::Stop,
                    "cancel" => TeamAction2::Cancel,
                    "resolve" => TeamAction2::Resolve,
                    other => return Err(format!("unknown action: {other}")),
                };
                let receipt = self
                    .team_action(
                        action,
                        TeamActionInput {
                            team_run_id: run_id,
                            device_id,
                        },
                    )
                    .await?;
                Ok(receipt.message)
            }
            ToolCall::RespondToAgent {
                request_id,
                answers,
            } => {
                let receipt = self
                    .submit_ask_user_answer(
                        &request_id,
                        SubmitAskUserAnswerInput { answers, device_id },
                    )
                    .await
                    .map_err(|error| match error {
                        AskUserAnswerError::NoPendingRequest => {
                            format!("no question is waiting as {request_id}")
                        }
                        AskUserAnswerError::NoAnswers => "no answers were given".to_string(),
                        AskUserAnswerError::Bridge(message) => message,
                    })?;
                Ok(receipt.message)
            }
        }
    }
}

/// MCP `tools/call` envelope shared by HTTP and any in-process caller.
pub fn tool_result_envelope(outcome: Result<String, String>) -> Value {
    match outcome {
        Ok(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": false }),
        Err(message) => {
            json!({ "content": [{ "type": "text", "text": message }], "isError": true })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::app::tests::path_scope_tests::{build_app, pair_device};
    use serde_json::json;
    use tempfile::TempDir;

    async fn ready_app(cwd: &str) -> AppState {
        let (app, _p, _o) = build_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;
        std::mem::forget((_p, _o));
        app
    }

    /// Found by running it: the list route had no beta gate while every call
    /// had one, so a locked build advertised six tools and refused all six. That
    /// is the precise failure the registry's own doc warns about — "a tool that
    /// can only fail teaches the model to retry".
    #[tokio::test]
    async fn a_locked_build_offers_no_tools_at_all() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, _p, _o) = build_app(&cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        // Deliberately NOT enabling beta.

        let offered = app.list_orchestrator_tools().await;
        assert!(
            offered.is_empty(),
            "a build that refuses every call must advertise nothing: {:?}",
            offered.iter().map(|tool| &tool.name).collect::<Vec<_>>()
        );

        let err = app
            .call_orchestrator_tool(
                "propose_task",
                &json!({ "title": "x" }),
                Some("device-1".to_string()),
            )
            .await
            .expect_err("locked");
        assert!(err.contains("development"), "{err}");
    }

    /// The whole point of the registry reaching the model: a call staged a card,
    /// and staging is ALL it did.
    #[tokio::test]
    async fn propose_task_stages_a_card_and_starts_nothing() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        let text = app
            .call_orchestrator_tool(
                "propose_task",
                &json!({ "title": "Add a parser", "context": "Touch the CLI." }),
                Some("device-1".to_string()),
            )
            .await
            .expect("propose_task");

        assert!(
            text.contains("NOT started"),
            "the model must be told: {text}"
        );
        let snap = app.snapshot().await;
        assert_eq!(snap.orchestrator_proposals.len(), 1);
        assert_eq!(snap.orchestrator_proposals[0].title, "Add a parser");
    }

    /// Availability is re-checked at CALL time, not only at list time: the list a
    /// model holds was assembled at least a turn ago.
    #[tokio::test]
    async fn a_tool_that_is_no_longer_available_is_refused_by_name() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        // Nothing is running, so control_run is not on offer.
        let err = app
            .call_orchestrator_tool(
                "control_run",
                &json!({ "action": "stop" }),
                Some("device-1".to_string()),
            )
            .await
            .expect_err("no runs, no control");
        assert!(err.contains("not available"), "{err}");
    }

    #[tokio::test]
    async fn an_unknown_tool_is_named_as_unknown_not_unavailable() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        let err = app
            .call_orchestrator_tool("rm_rf", &json!({}), Some("device-1".to_string()))
            .await
            .expect_err("unknown tool");
        assert!(err.contains("no such tool"), "{err}");
    }

    /// A staged card makes `revise_proposal` appear; an empty workspace does not
    /// offer it, because there would be no id to name.
    #[tokio::test]
    async fn the_offered_tools_track_what_the_workspace_can_answer() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        let before: Vec<String> = app
            .list_orchestrator_tools()
            .await
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert!(
            !before.contains(&"revise_proposal".to_string()),
            "{before:?}"
        );

        app.call_orchestrator_tool(
            "propose_task",
            &json!({ "title": "Add a parser" }),
            Some("device-1".to_string()),
        )
        .await
        .expect("propose");

        let after: Vec<String> = app
            .list_orchestrator_tools()
            .await
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert!(after.contains(&"revise_proposal".to_string()), "{after:?}");
    }

    /// A refusal must reach the model as a readable result, not as a transport
    /// failure it can only answer by retrying.
    #[tokio::test]
    async fn a_refusal_is_a_result_the_model_can_read() {
        let envelope = tool_result_envelope(Err("title is required".to_string()));
        assert_eq!(envelope["isError"], true);
        assert_eq!(envelope["content"][0]["text"], "title is required");
        assert_eq!(envelope["content"][0]["type"], "text");

        let ok = tool_result_envelope(Ok("done".to_string()));
        assert_eq!(ok["isError"], false);
        assert_eq!(ok["content"][0]["text"], "done");
    }

    #[tokio::test]
    async fn every_offered_tool_carries_a_schema_a_client_can_use() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        for tool in app.list_orchestrator_tools().await {
            assert!(!tool.name.is_empty());
            assert!(
                !tool.description.is_empty(),
                "{} has no description",
                tool.name
            );
            assert_eq!(tool.input_schema["type"], "object", "{}", tool.name);
            assert!(
                tool.input_schema["properties"].is_object(),
                "{} schema has no properties object",
                tool.name
            );
        }
    }

    /// The gap that made `respond_to_agent` unusable: the tool to ANSWER appeared
    /// the moment a seat parked, and nothing carried what was asked. Answers are
    /// keyed by each question's own header, so without the header the model is
    /// guessing at a JSON key it has never seen.
    #[tokio::test]
    async fn a_parked_question_reaches_the_model_with_its_header_and_options() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;
        park_a_seat(&app, &cwd, "run-1", "req-1").await;

        let names = offered(&app).await;
        assert!(
            names.contains(&"pending_questions".to_string()),
            "a parked question must come with a way to read it: {names:?}"
        );

        let reply = app
            .call_orchestrator_tool(
                "pending_questions",
                &json!({}),
                Some("device-1".to_string()),
            )
            .await
            .expect("pending_questions");

        assert!(
            reply.contains("req-1"),
            "no request id to answer with: {reply}"
        );
        assert!(
            reply.contains("[Auth method]"),
            "the header IS the answer key; without it the model guesses: {reply}"
        );
        assert!(
            reply.contains("Which auth should the parser accept?"),
            "{reply}"
        );
        assert!(
            reply.contains("Bearer token"),
            "options are the point: {reply}"
        );
        assert!(reply.contains("API key"), "{reply}");
        assert!(
            reply.contains("dev on run-1"),
            "the answer needs to be given in context, not to a bare id: {reply}"
        );
    }

    /// `task_status` answered "is it going" when the question people actually ask
    /// is "how far has it got". The sub-tasks were in the record the whole time —
    /// the Tasks screen renders them — and only this projection dropped them.
    #[tokio::test]
    async fn task_status_reports_the_sub_tasks_not_just_the_run() {
        use relay_api::team::{SubTask, SubTaskStatus, TaskSpec, TeamRun, TeamRunStatus};

        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        {
            let mut relay = app.relay.write().await;
            let mut run = TeamRun::new(
                "run-1".to_string(),
                TaskSpec {
                    title: "Add a parser".to_string(),
                    ..TaskSpec::default()
                },
                cwd.clone(),
                "device-1".to_string(),
            );
            run.status = TeamRunStatus::Running;
            run.sub_tasks = vec![
                SubTask {
                    id: "st-1".to_string(),
                    title: "Write the lexer".to_string(),
                    status: SubTaskStatus::Done,
                    rounds_used: 2,
                    result_summary: Some("Handles all three encodings.".to_string()),
                    ..SubTask::default()
                },
                SubTask {
                    id: "st-2".to_string(),
                    title: "Wire it up".to_string(),
                    status: SubTaskStatus::Implementing,
                    ..SubTask::default()
                },
            ];
            relay.insert_team_run(run);
        }

        let reply = app
            .call_orchestrator_tool("task_status", &json!({}), Some("device-1".to_string()))
            .await
            .expect("task_status");

        assert!(reply.contains("Add a parser"), "{reply}");
        assert!(
            reply.contains("Write the lexer"),
            "the first sub-task is missing: {reply}"
        );
        assert!(
            reply.contains("Wire it up"),
            "the second sub-task is missing: {reply}"
        );
        assert!(
            reply.contains("Handles all three encodings."),
            "the result summary is what says HOW it went: {reply}"
        );
        assert!(reply.contains("2 review round"), "{reply}");
    }

    /// Seed a run that is parked on a question, exactly as the driver leaves it.
    async fn park_a_seat(app: &AppState, cwd: &str, run_id: &str, request_id: &str) {
        use relay_api::team::{AwaitingUser, TaskSpec, TeamRun, TeamRunStatus};

        let mut relay = app.relay.write().await;
        let mut run = TeamRun::new(
            run_id.to_string(),
            TaskSpec {
                title: "Add a parser".to_string(),
                ..TaskSpec::default()
            },
            cwd.to_string(),
            "device-1".to_string(),
        );
        run.status = TeamRunStatus::AwaitingUser;
        run.awaiting = Some(AwaitingUser {
            thread_id: "thread-7".to_string(),
            request_id: request_id.to_string(),
            role: "dev".to_string(),
            asked_at: 1,
        });
        relay.insert_team_run(run);
        relay.pending_ask_user_questions.insert(
            request_id.to_string(),
            crate::state::relay::PendingAskUserQuestion {
                request_id: request_id.to_string(),
                tool_use_id: "tu-1".to_string(),
                thread_id: "thread-7".to_string(),
                requested_at: 1,
                questions: vec![crate::protocol::AskUserQuestionView {
                    question: "Which auth should the parser accept?".to_string(),
                    header: "Auth method".to_string(),
                    multi_select: false,
                    options: vec![
                        crate::protocol::AskUserOptionView {
                            label: "Bearer token".to_string(),
                            description: "the header form".to_string(),
                        },
                        crate::protocol::AskUserOptionView {
                            label: "API key".to_string(),
                            description: String::new(),
                        },
                    ],
                }],
            },
        );
    }

    async fn offered(app: &AppState) -> Vec<String> {
        app.list_orchestrator_tools()
            .await
            .into_iter()
            .map(|tool| tool.name)
            .collect()
    }

    /// Cancelling a run clears its `awaiting`, but the seat's THREAD survives for
    /// the audit trail — so `drop_pending_requests_for_thread` never runs and the
    /// entry stays in `pending_ask_user_questions`. Counting that map on its own
    /// therefore kept both question tools on offer for a run that is gone, and
    /// answering would have steered a thread that was already drained.
    ///
    /// The rule has to be the JOIN: a question is live only while a non-terminal
    /// run is still waiting on it.
    #[tokio::test]
    async fn a_cancelled_runs_question_stops_being_offered() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;
        park_a_seat(&app, &cwd, "run-1", "req-1").await;

        let names = offered(&app).await;
        assert!(
            names.contains(&"pending_questions".to_string()),
            "{names:?}"
        );

        {
            let mut relay = app.relay.write().await;
            relay.update_team_run("run-1", |run| {
                run.cancel("the user cancelled it");
            });
        }

        let names = offered(&app).await;
        assert!(
            !names.contains(&"pending_questions".to_string()),
            "the run is gone; there is nothing to read: {names:?}"
        );
        assert!(
            !names.contains(&"respond_to_agent".to_string()),
            "answering would steer a drained thread: {names:?}"
        );
    }

    /// The status line and the question list must not be able to disagree: one
    /// saying a seat is waiting while the other has nothing to show is the shape
    /// of bug that reads as content rather than as a failure.
    #[tokio::test]
    async fn task_status_stops_flagging_a_question_the_reader_would_not_list() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;
        park_a_seat(&app, &cwd, "run-1", "req-1").await;

        let status = app
            .call_orchestrator_tool("task_status", &json!({}), Some("device-1".to_string()))
            .await
            .expect("task_status");
        assert!(status.contains("WAITING ON YOU"), "{status}");

        {
            let mut relay = app.relay.write().await;
            relay.update_team_run("run-1", |run| {
                run.cancel("the user cancelled it");
            });
        }

        let status = app
            .call_orchestrator_tool("task_status", &json!({}), Some("device-1".to_string()))
            .await
            .expect("task_status");
        assert!(
            !status.contains("WAITING ON YOU"),
            "nobody is waiting on a cancelled run: {status}"
        );
    }

    /// The answer map is keyed by QUESTION TEXT. `claude-worker/worker.mjs`'s
    /// protocol header says so, `resolveAskUserAnswers` documents it, and
    /// the private task-team E2E suite answers that way against a real run.
    ///
    /// `respond_to_agent` has always told the model to key by the HEADER instead.
    /// Nothing caught it because until `pending_questions` existed the model had
    /// no way to attempt an answer at all — the wrong instruction sat next to a
    /// tool nobody could reach. A model that obeyed would send a key matching no
    /// question, and the worker would forward it verbatim: no error, no match,
    /// the seat waits on an answer it was already given.
    #[tokio::test]
    async fn the_reader_names_the_key_the_worker_actually_matches_on() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;
        park_a_seat(&app, &cwd, "run-1", "req-1").await;

        let reply = app
            .call_orchestrator_tool(
                "pending_questions",
                &json!({}),
                Some("device-1".to_string()),
            )
            .await
            .expect("pending_questions");

        assert!(
            reply.contains("keyed by the question text"),
            "the reader must name the key the worker matches on: {reply}"
        );
        assert!(
            !reply.to_ascii_lowercase().contains("keyed by the header"),
            "the header is a label, not the key: {reply}"
        );

        let answers_param = orchestrator_tools::spec_for("respond_to_agent")
            .expect("respond_to_agent")
            .params
            .iter()
            .find(|param| param.name == "answers")
            .expect("answers param");
        assert!(
            answers_param
                .summary
                .to_ascii_lowercase()
                .contains("question text"),
            "the tool that takes the map must describe the same key: {}",
            answers_param.summary
        );
    }
}
