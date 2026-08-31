//! Orchestrator tool registry — what the model may call, as data.
//!
//! Transport-agnostic: MCP (Claude session today; external hosts later) reads
//! from here. Schemas are not duplicated into the Node proxy.
//!
//! # Rules
//!
//! 1. **No tool starts work.** Propose → card → user confirms. No `start_task`.
//!    [`Effect::Acts`] is only for release/unblock (`ACTING_TOOLS`).
//! 2. **Offer every tool, always.** The model reads the list once per session
//!    and is never told it changed, so a list derived from live facts freezes
//!    at connect time — stranding it without `revise_proposal`, `control_run`
//!    and the question tools, none of which are relevant until after the
//!    session has started. [`blocked_reason`] carries the gating instead: the
//!    tool is visible, and a call the workspace cannot serve is refused with
//!    the reason. A fixed list is also the cheap one — tools render at the
//!    front of every request, so a list that changes re-prices the whole
//!    conversation, while a list that never changes is paid for once.

use serde_json::{json, Map, Value};

/// Same cap the proposals module enforces — imported so the refusal and the
/// backend cannot drift (past the cap, `propose_task` is refused).
pub(crate) use crate::state::app::orchestrator_proposals::MAX_PENDING_PROPOSALS;

/// The seats a task runs on. Order is the pipeline's own.
pub(crate) const SEATS: &[&str] = &["tl", "dev", "reviewer"];

/// Which agent one seat should run on, as asked for — not yet resolved against
/// what the relay actually has. `None` means "no opinion, use the default".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SeatAgent {
    pub(crate) provider: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
}

impl SeatAgent {
    /// This seat's override laid over a task-wide default, FIELD BY FIELD.
    ///
    /// Whole-value precedence would be a trap: asking for the reviewer to think
    /// harder (`effort` only) would silently drop the model the task chose, and
    /// the seat would run somewhere nobody asked for.
    fn over(&self, base: &SeatAgent) -> SeatAgent {
        // A model id belongs to the provider that published it. When this seat
        // names a provider the task did not, inheriting the task's model would
        // stage an id the seat's own catalogue has never seen — and the resolver
        // deliberately keeps an explicitly-named model rather than healing it,
        // so the mistake outlives provisioning and only bites when the seat
        // starts. Effort still inherits: the levels are shared, and are clamped
        // to whatever model is finally chosen.
        let moved_provider = self.provider.is_some() && self.provider != base.provider;
        SeatAgent {
            provider: self.provider.clone().or_else(|| base.provider.clone()),
            model: self.model.clone().or_else(|| {
                if moved_provider {
                    None
                } else {
                    base.model.clone()
                }
            }),
            effort: self.effort.clone().or_else(|| base.effort.clone()),
        }
    }

    fn is_empty(&self) -> bool {
        self.provider.is_none() && self.model.is_none() && self.effort.is_none()
    }
}

/// What agent each seat should run on. The task-wide ask plus per-seat
/// overrides; [`TeamAgents::per_seat`] is what anything downstream should read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TeamAgents {
    /// Applies to every seat that does not override it.
    pub(crate) all: SeatAgent,
    pub(crate) tl: SeatAgent,
    pub(crate) dev: SeatAgent,
    pub(crate) reviewer: SeatAgent,
}

impl TeamAgents {
    /// `(tl, dev, reviewer)`, each already merged over the task-wide ask.
    pub(crate) fn per_seat(&self) -> (SeatAgent, SeatAgent, SeatAgent) {
        (
            self.tl.over(&self.all),
            self.dev.over(&self.all),
            self.reviewer.over(&self.all),
        )
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.all.is_empty() && self.tl.is_empty() && self.dev.is_empty() && self.reviewer.is_empty()
    }
}

/// What calling a tool does to the world.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Effect {
    Read,
    /// Stages a card; does not start work.
    Proposes,
    /// Mutates without a card — release/unblock only. See `ACTING_TOOLS`.
    Acts,
}

/// Tools allowed to mutate without a card. Allowlist so new Acts tools are a
/// deliberate edit. Members must release or unblock, never commit work.
const ACTING_TOOLS: &[&str] = &[
    "control_run",
    "respond_to_agent",
    "widen_scope",
    "message_team",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ParamKind {
    Text,
    /// Closed set → JSON Schema `enum`.
    OneOf(&'static [&'static str]),
    /// Free-form object (AskUserQuestion answers keyed by question headers).
    Object,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ToolParam {
    pub(crate) name: &'static str,
    pub(crate) kind: ParamKind,
    pub(crate) required: bool,
    /// One-line; billed on every request.
    pub(crate) summary: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ToolSpec {
    pub(crate) name: &'static str,
    pub(crate) summary: &'static str,
    pub(crate) params: &'static [ToolParam],
    pub(crate) effect: Effect,
}

impl ToolSpec {
    /// JSON Schema for this tool's arguments (`additionalProperties: false`).
    pub(crate) fn input_schema(&self) -> Value {
        let mut properties = Map::new();
        let mut required = Vec::new();
        for param in self.params {
            let mut entry = match param.kind {
                ParamKind::Text => json!({ "type": "string" }),
                ParamKind::OneOf(options) => json!({ "type": "string", "enum": options }),
                ParamKind::Object => json!({ "type": "object" }),
            };
            entry["description"] = Value::String(param.summary.to_string());
            properties.insert(param.name.to_string(), entry);
            if param.required {
                required.push(Value::String(param.name.to_string()));
            }
        }
        json!({
            "type": "object",
            "properties": Value::Object(properties),
            "required": Value::Array(required),
            "additionalProperties": false,
        })
    }
}

/// Every Orchestrator tool. Grows with backend routes — each entry must have one.
pub(crate) const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: "propose_task",
        summary: "Stage a task for the user to confirm. Does NOT start it: the user \
starts work by confirming the card this creates.",
        effect: Effect::Proposes,
        params: &[
            ToolParam {
                name: "title",
                kind: ParamKind::Text,
                required: true,
                summary: "One line naming the work.",
            },
            ToolParam {
                name: "context",
                kind: ParamKind::Text,
                required: false,
                summary: "What the team needs to know that the title does not say.",
            },
            ToolParam {
                name: "acceptance_criteria",
                kind: ParamKind::Text,
                required: false,
                summary: "How to tell the task is done.",
            },
            ToolParam {
                name: "team_id",
                kind: ParamKind::Text,
                required: false,
                summary: "Team to run it, from list_teams. Omit to use the default.",
            },
            ToolParam {
                name: "why",
                kind: ParamKind::Text,
                required: false,
                summary: "Why this team — cite facts, and name the argument against \
your own choice.",
            },
            ToolParam {
                name: "provider",
                kind: ParamKind::Text,
                required: false,
                summary: "Agent to run every seat on, e.g. codex. Omit for the default.",
            },
            ToolParam {
                name: "model",
                kind: ParamKind::Text,
                required: false,
                summary: "Model for every seat. Omit for the provider's default.",
            },
            ToolParam {
                name: "effort",
                kind: ParamKind::Text,
                required: false,
                summary: "Reasoning effort for every seat. Omit for the model's default.",
            },
            ToolParam {
                name: "seat_overrides",
                kind: ParamKind::Object,
                required: false,
                summary: "Per-seat exceptions, keyed tl/dev/reviewer, each any of \
provider/model/effort. Overrides only the fields it names.",
            },
        ],
    },
    ToolSpec {
        name: "revise_proposal",
        summary: "Change a staged card before the user confirms it — retarget it at \
another team, or sharpen the scope. Starts nothing.",
        effect: Effect::Proposes,
        params: &[
            ToolParam {
                name: "proposal_id",
                kind: ParamKind::Text,
                required: true,
                summary: "The card to change.",
            },
            ToolParam {
                name: "title",
                kind: ParamKind::Text,
                required: false,
                summary: "Replacement title. Omit to keep it.",
            },
            ToolParam {
                name: "context",
                kind: ParamKind::Text,
                required: false,
                summary: "Replacement context. Omit to keep it.",
            },
            ToolParam {
                name: "team_id",
                kind: ParamKind::Text,
                required: false,
                summary: "Retarget at this team, from list_teams.",
            },
            ToolParam {
                name: "why",
                kind: ParamKind::Text,
                required: false,
                summary: "Why this team — cite facts, and name the argument against \
your own choice.",
            },
            ToolParam {
                name: "provider",
                kind: ParamKind::Text,
                required: false,
                summary: "Replacement agent for every seat. Omit to keep it.",
            },
            ToolParam {
                name: "model",
                kind: ParamKind::Text,
                required: false,
                summary: "Replacement model for every seat. Omit to keep it.",
            },
            ToolParam {
                name: "effort",
                kind: ParamKind::Text,
                required: false,
                summary: "Replacement reasoning effort for every seat. Omit to keep it.",
            },
            ToolParam {
                name: "seat_overrides",
                kind: ParamKind::Object,
                required: false,
                summary: "Per-seat exceptions, keyed tl/dev/reviewer, each any of \
provider/model/effort. Replaces the staged overrides.",
            },
        ],
    },
    ToolSpec {
        name: "list_agents",
        summary: "The agents a task can run on: each one's models, and the \
reasoning-effort levels each model takes.",
        effect: Effect::Read,
        params: &[],
    },
    ToolSpec {
        name: "list_teams",
        summary: "The teams available to run a task, with their ids.",
        effect: Effect::Read,
        params: &[],
    },
    ToolSpec {
        name: "task_definition",
        summary: "The task a run is working to: its scope, acceptance criteria \
and quality rules, as they stand now.",
        effect: Effect::Read,
        params: &[ToolParam {
            name: "run_id",
            kind: ParamKind::Text,
            required: false,
            summary: "Which run. Omit when only one is active.",
        }],
    },
    ToolSpec {
        name: "widen_scope",
        summary: "Add to what a running task is allowed to cover. Cannot narrow \
it, and the team itself may never call this.",
        effect: Effect::Acts,
        params: &[
            ToolParam {
                name: "addition",
                kind: ParamKind::Text,
                required: true,
                summary: "What is now also in scope, in the user's terms.",
            },
            ToolParam {
                name: "run_id",
                kind: ParamKind::Text,
                required: false,
                summary: "Which run. Omit when only one is active.",
            },
        ],
    },
    ToolSpec {
        name: "message_team",
        summary: "Leave an instruction the team picks up on its next turn. Works \
while it runs or while it is paused; does not resume it.",
        effect: Effect::Acts,
        params: &[
            ToolParam {
                name: "text",
                kind: ParamKind::Text,
                required: true,
                summary: "What the team should do next, in the user's terms.",
            },
            ToolParam {
                name: "run_id",
                kind: ParamKind::Text,
                required: false,
                summary: "Which run. Omit when only one is active.",
            },
        ],
    },
    ToolSpec {
        name: "control_run",
        summary: "Pause, resume, stop, cancel or unblock a run that is already going.",
        effect: Effect::Acts,
        params: &[
            ToolParam {
                name: "action",
                kind: ParamKind::OneOf(&["pause", "resume", "stop", "cancel", "resolve"]),
                required: true,
                summary: "What to do to it.",
            },
            ToolParam {
                name: "run_id",
                kind: ParamKind::Text,
                required: false,
                summary: "Which run. Omit when only one is active.",
            },
        ],
    },
    ToolSpec {
        name: "pending_questions",
        summary: "What seats are asking, with each question's header and options.",
        effect: Effect::Read,
        params: &[],
    },
    ToolSpec {
        name: "respond_to_agent",
        summary: "Answer a question a seat is parked on, so it can carry on.",
        effect: Effect::Acts,
        params: &[
            ToolParam {
                name: "request_id",
                kind: ParamKind::Text,
                required: true,
                summary: "The question being answered.",
            },
            ToolParam {
                name: "answers",
                kind: ParamKind::Object,
                required: true,
                summary: "Reply keyed by the question TEXT, exactly as asked.",
            },
        ],
    },
    ToolSpec {
        name: "task_status",
        summary: "Where a task has got to.",
        effect: Effect::Read,
        params: &[ToolParam {
            name: "run_id",
            kind: ParamKind::Text,
            required: false,
            summary: "A specific run. Omit for all of them.",
        }],
    },
];

/// Live facts that gate which tools are offered.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct WorkspaceFacts {
    pub(crate) pending_proposals: usize,
    /// Non-terminal runs (`control_run`).
    pub(crate) active_runs: usize,
    /// Any run, including finished (`task_status`).
    pub(crate) known_runs: usize,
    pub(crate) known_teams: usize,
    pub(crate) parked_questions: usize,
}

/// Every tool, whatever the workspace looks like. Deliberately takes no facts:
/// the list is what the model caches for the session, so it must not be able
/// to depend on state that has moved on by the time it calls.
pub(crate) fn available_tools() -> Vec<&'static ToolSpec> {
    TOOLS.iter().collect()
}

/// Why this tool cannot run right now, or `None` if it can.
///
/// The model is told this verbatim when it calls, so each reason must say what
/// is missing — a bare "not available" teaches it to retry rather than to pick
/// a different tool or ask the user.
pub(crate) fn blocked_reason(name: &str, facts: &WorkspaceFacts) -> Option<&'static str> {
    match name {
        "propose_task" if facts.pending_proposals >= MAX_PENDING_PROPOSALS => Some(
            "too many tasks are already waiting for the user; they have to confirm or \
dismiss one before you can stage another",
        ),
        "revise_proposal" if facts.pending_proposals == 0 => {
            Some("no task is waiting for the user, so there is nothing to change")
        }
        "list_teams" if facts.known_teams == 0 => Some("no teams are defined"),
        "task_status" if facts.known_runs == 0 => Some("nothing has run yet"),
        "task_definition" if facts.known_runs == 0 => Some("nothing has run yet"),
        "message_team" if facts.known_runs == 0 => Some("nothing has run yet"),
        "widen_scope" if facts.active_runs == 0 => {
            Some("no task is going; scope can only be widened while one is running")
        }
        "control_run" if facts.active_runs == 0 => Some("no run is going"),
        "pending_questions" | "respond_to_agent" if facts.parked_questions == 0 => {
            Some("nothing is waiting on an answer")
        }
        _ => None,
    }
}

/// Validated tool call (parsed args; callers can be total).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ToolCall {
    ProposeTask {
        title: String,
        context: Option<String>,
        acceptance_criteria: Option<String>,
        team_id: Option<String>,
        why: Option<String>,
        agents: TeamAgents,
    },
    ReviseProposal {
        proposal_id: String,
        title: Option<String>,
        context: Option<String>,
        team_id: Option<String>,
        why: Option<String>,
        agents: TeamAgents,
    },
    ListAgents,
    ListTeams,
    TaskDefinition {
        run_id: Option<String>,
    },
    WidenScope {
        addition: String,
        run_id: Option<String>,
    },
    MessageTeam {
        text: String,
        run_id: Option<String>,
    },
    PendingQuestions,
    TaskStatus {
        run_id: Option<String>,
    },
    ControlRun {
        action: String,
        run_id: Option<String>,
    },
    RespondToAgent {
        request_id: String,
        answers: Map<String, Value>,
    },
}

pub(crate) fn spec_for(name: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|tool| tool.name == name)
}

/// One seat's override object. Refuses anything it does not understand rather
/// than ignoring it — a typo'd key silently dropped would run the seat on the
/// default while the model believes it asked for something else.
fn parse_seat_agent(tool: &str, seat: &str, value: &Value) -> Result<SeatAgent, String> {
    let Value::Object(fields) = value else {
        return Err(format!(
            "{tool}: seat_overrides.{seat} must be an object of provider/model/effort"
        ));
    };
    let mut agent = SeatAgent::default();
    for (key, raw) in fields {
        let Value::String(text) = raw else {
            return Err(format!(
                "{tool}: seat_overrides.{seat}.{key} must be a string"
            ));
        };
        let text = text.trim();
        if text.is_empty() {
            return Err(format!(
                "{tool}: seat_overrides.{seat}.{key} must not be blank"
            ));
        }
        let slot = match key.as_str() {
            "provider" => &mut agent.provider,
            "model" => &mut agent.model,
            "effort" => &mut agent.effort,
            other => {
                return Err(format!(
                    "{tool}: seat_overrides.{seat} has no '{other}' — only \
provider, model, effort"
                ))
            }
        };
        *slot = Some(text.to_string());
    }
    Ok(agent)
}

/// The task-wide ask plus per-seat overrides, from already-validated args.
fn parse_team_agents(
    tool: &str,
    object: &Map<String, Value>,
    all: SeatAgent,
) -> Result<TeamAgents, String> {
    let mut agents = TeamAgents {
        all,
        ..Default::default()
    };
    let Some(raw) = object.get("seat_overrides") else {
        return Ok(agents);
    };
    if raw.is_null() {
        return Ok(agents);
    }
    let Value::Object(seats) = raw else {
        return Err(format!(
            "{tool}: 'seat_overrides' must be an object keyed by seat ({})",
            SEATS.join(", ")
        ));
    };
    for (seat, value) in seats {
        let parsed = parse_seat_agent(tool, seat, value)?;
        match seat.as_str() {
            "tl" => agents.tl = parsed,
            "dev" => agents.dev = parsed,
            "reviewer" => agents.reviewer = parsed,
            other => {
                return Err(format!(
                    "{tool}: '{other}' is not a seat — only {}",
                    SEATS.join(", ")
                ))
            }
        }
    }
    Ok(agents)
}

/// Validate a raw tool call. Errors name the bad argument for the model.
pub(crate) fn parse_call(name: &str, args: &Value) -> Result<ToolCall, String> {
    let spec = spec_for(name).ok_or_else(|| format!("no such tool: {name}"))?;

    let empty = Map::new();
    let object = match args {
        Value::Object(map) => map,
        Value::Null => &empty,
        _ => return Err(format!("{name}: arguments must be a JSON object")),
    };

    for key in object.keys() {
        if !spec.params.iter().any(|param| param.name == key) {
            return Err(format!("{name}: unknown argument '{key}'"));
        }
    }

    let text = |param: &ToolParam| -> Result<Option<String>, String> {
        if param.kind == ParamKind::Object {
            // Read by the arm that knows the shape; nothing string-like here.
            return Ok(None);
        }
        match object.get(param.name) {
            None | Some(Value::Null) => {
                if param.required {
                    Err(format!("{name}: '{}' is required", param.name))
                } else {
                    Ok(None)
                }
            }
            Some(Value::String(value)) => {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    if param.required {
                        return Err(format!("{name}: '{}' must not be blank", param.name));
                    }
                    return Ok(None);
                }
                if let ParamKind::OneOf(options) = param.kind {
                    if !options.contains(&trimmed) {
                        return Err(format!(
                            "{name}: '{}' must be one of {}",
                            param.name,
                            options.join(", ")
                        ));
                    }
                }
                Ok(Some(trimmed.to_string()))
            }
            Some(_) => Err(format!("{name}: '{}' must be a string", param.name)),
        }
    };

    let get = |param_name: &str| -> Result<Option<String>, String> {
        let param = spec
            .params
            .iter()
            .find(|param| param.name == param_name)
            .expect("registry param must exist");
        text(param)
    };

    // Task-wide ask; per-seat overrides are layered over it by `per_seat`.
    let task_wide = || -> Result<SeatAgent, String> {
        Ok(SeatAgent {
            provider: get("provider")?,
            model: get("model")?,
            effort: get("effort")?,
        })
    };

    match spec.name {
        "propose_task" => Ok(ToolCall::ProposeTask {
            title: get("title")?.expect("required param yields Some"),
            context: get("context")?,
            acceptance_criteria: get("acceptance_criteria")?,
            team_id: get("team_id")?,
            why: get("why")?,
            agents: parse_team_agents(spec.name, object, task_wide()?)?,
        }),
        "revise_proposal" => Ok(ToolCall::ReviseProposal {
            proposal_id: get("proposal_id")?.expect("required param yields Some"),
            title: get("title")?,
            context: get("context")?,
            team_id: get("team_id")?,
            why: get("why")?,
            agents: parse_team_agents(spec.name, object, task_wide()?)?,
        }),
        "list_agents" => Ok(ToolCall::ListAgents),
        "task_definition" => Ok(ToolCall::TaskDefinition {
            run_id: get("run_id")?,
        }),
        "message_team" => Ok(ToolCall::MessageTeam {
            text: get("text")?.expect("required param yields Some"),
            run_id: get("run_id")?,
        }),
        "widen_scope" => Ok(ToolCall::WidenScope {
            addition: get("addition")?.expect("required param yields Some"),
            run_id: get("run_id")?,
        }),
        "list_teams" => Ok(ToolCall::ListTeams),
        "pending_questions" => Ok(ToolCall::PendingQuestions),
        "control_run" => Ok(ToolCall::ControlRun {
            action: get("action")?.expect("required param yields Some"),
            run_id: get("run_id")?,
        }),
        "respond_to_agent" => Ok(ToolCall::RespondToAgent {
            request_id: get("request_id")?.expect("required param yields Some"),
            answers: match object.get("answers") {
                Some(Value::Object(map)) if !map.is_empty() => map.clone(),
                Some(Value::Object(_)) => {
                    return Err(format!("{name}: 'answers' must not be empty"))
                }
                _ => return Err(format!("{name}: 'answers' must be an object")),
            },
        }),
        "task_status" => Ok(ToolCall::TaskStatus {
            run_id: get("run_id")?,
        }),
        other => Err(format!("no such tool: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No start/confirm tools — starting is a button.
    #[test]
    fn the_model_cannot_start_work() {
        for forbidden in ["start_task", "confirm_proposal", "start_team", "run_task"] {
            assert!(
                spec_for(forbidden).is_none(),
                "{forbidden} must not be callable by the model"
            );
        }
    }

    /// Acts without a card only via `ACTING_TOOLS` (release/unblock).
    #[test]
    fn only_release_or_unblock_may_act_without_a_card() {
        for tool in TOOLS.iter().filter(|tool| tool.effect == Effect::Acts) {
            assert!(
                ACTING_TOOLS.contains(&tool.name),
                "{} acts without a card but is not in ACTING_TOOLS — adding one \
must be a deliberate edit, not a field change",
                tool.name
            );
        }
        for name in ACTING_TOOLS {
            assert!(
                spec_for(name).is_some(),
                "{name} is allowlisted to act but no longer exists"
            );
        }
    }

    #[test]
    fn a_proposing_tool_says_it_does_not_start_work() {
        for tool in TOOLS.iter().filter(|tool| tool.effect == Effect::Proposes) {
            assert!(
                tool.name.starts_with("propose_") || tool.name.contains("proposal"),
                "{} stages a card; the model should be able to tell from the name \
that it is acting on a CARD, not on the task",
                tool.name
            );
            assert!(
                tool.summary.contains("NOT start") || tool.summary.contains("confirm"),
                "{}'s summary must tell the model it does not start work: {}",
                tool.name,
                tool.summary
            );
        }
    }

    #[test]
    fn every_tool_parses_its_own_name() {
        for tool in TOOLS {
            let required: Map<String, Value> = tool
                .params
                .iter()
                .filter(|param| param.required)
                .map(|param| {
                    let value = match param.kind {
                        ParamKind::Text => Value::String("x".to_string()),
                        ParamKind::OneOf(options) => Value::String(options[0].to_string()),
                        ParamKind::Object => json!({ "Question": "yes" }),
                    };
                    (param.name.to_string(), value)
                })
                .collect();
            assert!(
                parse_call(tool.name, &Value::Object(required)).is_ok(),
                "{} must accept a call carrying exactly its required params",
                tool.name
            );
        }
    }

    #[test]
    fn schemas_close_the_door_on_invented_arguments() {
        for tool in TOOLS {
            let schema = tool.input_schema();
            assert_eq!(schema["type"], "object", "{}", tool.name);
            assert_eq!(
                schema["additionalProperties"], false,
                "{} must reject arguments it did not declare",
                tool.name
            );
            let required = schema["required"].as_array().expect("required array");
            let declared = tool.params.iter().filter(|param| param.required).count();
            assert_eq!(required.len(), declared, "{}", tool.name);
        }
    }

    #[test]
    fn a_blank_title_is_not_a_task() {
        let err = parse_call("propose_task", &json!({ "title": "   " })).unwrap_err();
        assert!(
            err.contains("title"),
            "the model must be told which arg: {err}"
        );
    }

    #[test]
    fn a_missing_required_argument_names_itself() {
        let err = parse_call("propose_task", &json!({ "context": "no title here" })).unwrap_err();
        assert!(err.contains("'title' is required"), "{err}");
    }

    #[test]
    fn an_invented_argument_is_refused_rather_than_dropped() {
        let err =
            parse_call("propose_task", &json!({ "title": "t", "branch": "main" })).unwrap_err();
        assert!(err.contains("unknown argument 'branch'"), "{err}");
    }

    #[test]
    fn a_non_string_argument_is_refused() {
        let err = parse_call("propose_task", &json!({ "title": 7 })).unwrap_err();
        assert!(err.contains("must be a string"), "{err}");
    }

    #[test]
    fn optional_arguments_may_be_omitted_or_null() {
        let call = parse_call(
            "propose_task",
            &json!({ "title": "Add a parser", "context": null }),
        )
        .expect("null optional is not an error");
        assert_eq!(
            call,
            ToolCall::ProposeTask {
                title: "Add a parser".to_string(),
                context: None,
                acceptance_criteria: None,
                team_id: None,
                why: None,
                agents: TeamAgents::default(),
            }
        );
    }

    #[test]
    fn a_read_only_tool_takes_no_arguments_at_all() {
        assert_eq!(
            parse_call("list_teams", &Value::Null),
            Ok(ToolCall::ListTeams)
        );
        assert_eq!(
            parse_call("list_teams", &json!({})),
            Ok(ToolCall::ListTeams)
        );
    }

    /// A task-wide ask reaches every seat; that is what makes it task-wide.
    #[test]
    fn a_task_wide_model_lands_on_all_three_seats() {
        let ToolCall::ProposeTask { agents, .. } = parse_call(
            "propose_task",
            &json!({ "title": "t", "model": "claude-opus-5", "effort": "medium" }),
        )
        .expect("parse") else {
            panic!("wrong variant");
        };
        let (tl, dev, reviewer) = agents.per_seat();
        for seat in [&tl, &dev, &reviewer] {
            assert_eq!(seat.model.as_deref(), Some("claude-opus-5"));
            assert_eq!(seat.effort.as_deref(), Some("medium"));
        }
    }

    /// The trap this design exists to avoid: overriding ONE field of a seat must
    /// not drop the rest of the task's choice for that seat. Asking the reviewer
    /// to think harder should not silently move it to a different model.
    #[test]
    fn a_seat_override_replaces_only_the_fields_it_names() {
        let ToolCall::ProposeTask { agents, .. } = parse_call(
            "propose_task",
            &json!({
                "title": "t",
                "model": "claude-opus-5",
                "effort": "medium",
                "seat_overrides": { "reviewer": { "effort": "max" } },
            }),
        )
        .expect("parse") else {
            panic!("wrong variant");
        };
        let (tl, _dev, reviewer) = agents.per_seat();
        assert_eq!(
            reviewer.effort.as_deref(),
            Some("max"),
            "the override applies"
        );
        assert_eq!(
            reviewer.model.as_deref(),
            Some("claude-opus-5"),
            "overriding effort must not drop the model the task chose",
        );
        assert_eq!(
            tl.effort.as_deref(),
            Some("medium"),
            "other seats untouched"
        );
    }

    /// A seat may name a provider different from the task's, and that has to
    /// carry its own model — otherwise the seat runs a model its provider does
    /// not have.
    #[test]
    fn a_seat_can_move_to_another_provider_with_its_own_model() {
        let ToolCall::ProposeTask { agents, .. } = parse_call(
            "propose_task",
            &json!({
                "title": "t",
                "provider": "codex",
                "seat_overrides": {
                    "reviewer": { "provider": "claude_code", "model": "claude-opus-5" }
                },
            }),
        )
        .expect("parse") else {
            panic!("wrong variant");
        };
        let (tl, _dev, reviewer) = agents.per_seat();
        assert_eq!(reviewer.provider.as_deref(), Some("claude_code"));
        assert_eq!(reviewer.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(tl.provider.as_deref(), Some("codex"));
        assert_eq!(
            tl.model, None,
            "the task named no model, so the seat has none"
        );
    }

    /// Silently ignoring a misspelled seat would run the task on the defaults
    /// while the model believed it had asked for something else.
    /// A model id only means anything to the provider that published it. A seat
    /// that moves to another provider must NOT inherit the task's model, or it
    /// is staged with an id its own catalogue has never seen — and the resolver
    /// deliberately preserves an explicitly-named model, so the mistake survives
    /// provisioning and only surfaces when that seat finally starts.
    #[test]
    fn a_seat_that_changes_provider_does_not_inherit_the_other_ones_model() {
        let ToolCall::ProposeTask { agents, .. } = parse_call(
            "propose_task",
            &json!({
                "title": "t",
                "provider": "codex",
                "model": "gpt-5.6-codex",
                "effort": "medium",
                "seat_overrides": { "reviewer": { "provider": "claude_code" } },
            }),
        )
        .expect("parse") else {
            panic!("wrong variant");
        };
        let (tl, _dev, reviewer) = agents.per_seat();
        assert_eq!(reviewer.provider.as_deref(), Some("claude_code"));
        assert_eq!(
            reviewer.model, None,
            "a codex model id must not follow the seat onto claude_code",
        );
        assert_eq!(
            reviewer.effort.as_deref(),
            Some("medium"),
            "effort levels are shared across providers and get clamped, so they \
still inherit",
        );
        assert_eq!(
            tl.model.as_deref(),
            Some("gpt-5.6-codex"),
            "the seat that stayed put keeps the task's model",
        );
    }

    /// Naming a provider where the task named none is still a move: the task's
    /// model belongs to whatever the relay would have picked, not to this seat.
    #[test]
    fn a_seat_naming_a_provider_the_task_did_not_drops_the_inherited_model() {
        let ToolCall::ProposeTask { agents, .. } = parse_call(
            "propose_task",
            &json!({
                "title": "t",
                "model": "gpt-5.6-codex",
                "seat_overrides": { "dev": { "provider": "claude_code" } },
            }),
        )
        .expect("parse") else {
            panic!("wrong variant");
        };
        let (_tl, dev, _reviewer) = agents.per_seat();
        assert_eq!(dev.model, None, "{dev:?}");
    }

    #[test]
    fn a_seat_that_does_not_exist_is_refused_by_name() {
        let err = parse_call(
            "propose_task",
            &json!({ "title": "t", "seat_overrides": { "reveiwer": { "effort": "max" } } }),
        )
        .unwrap_err();
        assert!(err.contains("reveiwer"), "{err}");
        assert!(
            err.contains("reviewer"),
            "the error must name the real seats: {err}"
        );
    }

    #[test]
    fn a_misspelled_field_inside_a_seat_is_refused_by_name() {
        let err = parse_call(
            "propose_task",
            &json!({ "title": "t", "seat_overrides": { "dev": { "modle": "x" } } }),
        )
        .unwrap_err();
        assert!(err.contains("modle"), "{err}");
        assert!(err.contains("provider, model, effort"), "{err}");
    }

    #[test]
    fn a_seat_override_must_be_an_object_of_strings() {
        let err = parse_call(
            "propose_task",
            &json!({ "title": "t", "seat_overrides": { "dev": "claude-opus-5" } }),
        )
        .unwrap_err();
        assert!(err.contains("must be an object"), "{err}");

        let err = parse_call(
            "propose_task",
            &json!({ "title": "t", "seat_overrides": { "dev": { "effort": 5 } } }),
        )
        .unwrap_err();
        assert!(err.contains("must be a string"), "{err}");
    }

    /// Asking for nothing must stay indistinguishable from not asking, or every
    /// task would pin itself to today's default and stop following it.
    #[test]
    fn a_task_that_names_no_agent_pins_nothing() {
        let ToolCall::ProposeTask { agents, .. } =
            parse_call("propose_task", &json!({ "title": "t" })).expect("parse")
        else {
            panic!("wrong variant");
        };
        assert!(agents.is_empty());
        let (tl, dev, reviewer) = agents.per_seat();
        for seat in [&tl, &dev, &reviewer] {
            assert!(seat.provider.is_none() && seat.model.is_none() && seat.effort.is_none());
        }
    }

    #[test]
    fn revise_carries_the_same_agent_surface_as_propose() {
        // Whatever propose can express, revise must be able to correct — else the
        // only way to fix a model is to dismiss and re-stage.
        let propose = spec_for("propose_task").expect("propose_task");
        let revise = spec_for("revise_proposal").expect("revise_proposal");
        for name in ["provider", "model", "effort", "seat_overrides"] {
            assert!(
                propose.params.iter().any(|param| param.name == name),
                "propose_task lost {name}"
            );
            assert!(
                revise.params.iter().any(|param| param.name == name),
                "revise_proposal cannot correct {name}"
            );
        }
    }

    /// The gate measures against `agreed_scope`; a team that could widen it
    /// would always pass its own gate.
    #[test]
    fn the_team_can_never_widen_its_own_scope() {
        let spec = spec_for("widen_scope").expect("widen_scope");
        assert!(
            spec.summary.contains("never"),
            "the tool must say who may not call it: {}",
            spec.summary
        );
        assert!(ACTING_TOOLS.contains(&"widen_scope"));
    }

    #[test]
    fn widening_needs_something_to_add() {
        let err = parse_call("widen_scope", &json!({ "addition": "  " })).unwrap_err();
        assert!(err.contains("addition"), "{err}");
    }

    #[test]
    fn reading_the_task_definition_takes_no_arguments() {
        assert_eq!(
            parse_call("task_definition", &json!({})),
            Ok(ToolCall::TaskDefinition { run_id: None })
        );
    }

    #[test]
    fn an_unknown_tool_is_refused() {
        let err = parse_call("delete_everything", &json!({})).unwrap_err();
        assert!(err.contains("no such tool"), "{err}");
    }

    /// The Orchestrator's tool list is fetched once per session, and nothing
    /// tells the model when it changes. Deriving the list from live facts
    /// therefore froze it at whatever the workspace looked like at connect
    /// time: `revise_proposal` is gated on a pending proposal, so a session
    /// that started with none never saw it — and the Orchestrator correctly
    /// told the user it had no way to change a staged card. Same for
    /// `control_run` and the question tools, which only become relevant after
    /// work is running. Advertising is now unconditional; [`blocked_reason`] is
    /// what refuses a call the workspace cannot serve.
    #[test]
    fn every_tool_is_offered_whatever_the_workspace_looks_like() {
        let names: Vec<_> = available_tools().iter().map(|tool| tool.name).collect();
        assert_eq!(names.len(), TOOLS.len(), "{names:?}");
        // Named rather than counted: these four are the ones a state-derived
        // list drops, because none of them is reachable in the workspace the
        // session opens in.
        for late in [
            "revise_proposal",
            "control_run",
            "pending_questions",
            "respond_to_agent",
        ] {
            assert!(
                names.contains(&late),
                "{late} only becomes useful after the session has started, so a \
list built at connect time is exactly when it goes missing: {names:?}"
            );
        }
    }

    /// Visible but refused: the workspace cannot answer it yet.
    #[test]
    fn a_workspace_that_has_never_run_a_task_cannot_be_asked_for_status() {
        let facts = WorkspaceFacts {
            known_teams: 3,
            ..Default::default()
        };
        assert!(blocked_reason("propose_task", &facts).is_none());
        assert!(blocked_reason("list_teams", &facts).is_none());
        assert!(blocked_reason("task_status", &facts).is_some());
    }

    #[test]
    fn a_finished_run_can_still_be_asked_about() {
        // task_status follows known_runs; control_run needs active_runs.
        let facts = WorkspaceFacts {
            known_teams: 1,
            known_runs: 2,
            ..Default::default()
        };
        assert!(blocked_reason("task_status", &facts).is_none());
        assert!(blocked_reason("control_run", &facts).is_some());
    }

    #[test]
    fn a_parked_question_comes_with_a_way_to_read_it() {
        // respond_to_agent needs pending_questions for headers/options.
        let facts = WorkspaceFacts {
            known_teams: 1,
            active_runs: 1,
            known_runs: 1,
            parked_questions: 1,
            ..Default::default()
        };
        assert!(blocked_reason("respond_to_agent", &facts).is_none());
        assert!(
            blocked_reason("pending_questions", &facts).is_none(),
            "the tool that answers is useless without the one that reads"
        );
    }

    #[test]
    fn nothing_parked_refuses_both_question_tools() {
        let facts = WorkspaceFacts {
            known_teams: 1,
            active_runs: 1,
            known_runs: 1,
            ..Default::default()
        };
        assert!(blocked_reason("pending_questions", &facts).is_some());
        assert!(blocked_reason("respond_to_agent", &facts).is_some());
    }

    #[test]
    fn a_full_proposal_queue_refuses_another_task() {
        let facts = WorkspaceFacts {
            known_teams: 1,
            active_runs: 1,
            known_runs: 1,
            pending_proposals: MAX_PENDING_PROPOSALS,
            ..Default::default()
        };
        assert!(blocked_reason("propose_task", &facts).is_some());
        assert!(blocked_reason("task_status", &facts).is_none());
        assert!(
            blocked_reason("revise_proposal", &facts).is_none(),
            "a queue at the cap is exactly when the model needs to change a \
staged task rather than stage a new one"
        );
    }

    #[test]
    fn a_bare_workspace_still_offers_a_way_in() {
        // Nothing running, no teams loaded yet: the Orchestrator must still be able
        // to stage a task, or its first useful act is unreachable.
        assert!(blocked_reason("propose_task", &WorkspaceFacts::default()).is_none());
    }

    /// A refusal has to name what is missing, or the model reads it as a
    /// transient failure and calls again.
    #[test]
    fn a_refusal_says_what_the_workspace_is_missing() {
        let bare = WorkspaceFacts::default();
        for tool in TOOLS {
            let Some(reason) = blocked_reason(tool.name, &bare) else {
                continue;
            };
            assert!(
                !reason.is_empty() && !reason.contains("not available"),
                "{} is refused with '{reason}' — say what is missing, not that \
it failed",
                tool.name
            );
        }
    }

    /// Reasons are only paid for on a refusal, but they are still read by a
    /// model mid-turn; a paragraph buries the one fact that matters.
    #[test]
    fn a_refusal_stays_short_enough_to_read() {
        let busy = WorkspaceFacts {
            pending_proposals: MAX_PENDING_PROPOSALS,
            ..Default::default()
        };
        for facts in [WorkspaceFacts::default(), busy] {
            for tool in TOOLS {
                if let Some(reason) = blocked_reason(tool.name, &facts) {
                    assert!(
                        reason.len() <= 160,
                        "{}'s refusal is {} chars",
                        tool.name,
                        reason.len()
                    );
                }
            }
        }
    }

    #[test]
    fn summaries_stay_short_enough_to_ride_every_request() {
        for tool in TOOLS {
            assert!(
                tool.summary.len() <= 160,
                "{} summary is {} chars — descriptions are paid for on every \
request, not once",
                tool.name,
                tool.summary.len()
            );
            for param in tool.params {
                assert!(
                    param.summary.len() <= 120,
                    "{}.{} summary is {} chars",
                    tool.name,
                    param.name,
                    param.summary.len()
                );
            }
        }
    }

    #[test]
    fn tool_names_are_unique() {
        let mut names: Vec<_> = TOOLS.iter().map(|tool| tool.name).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len(), "duplicate tool name");
    }
}
