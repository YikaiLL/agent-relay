//! ACP transport: stdio framing, response correlation, and the translation of
//! `session/update` notifications into relay state.
//!
//! The demux mirrors `codex/rpc.rs` because ACP is the same shape of protocol —
//! JSON-RPC 2.0 over newline-framed stdio, including server→client requests.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::ChildStderr,
    sync::RwLock,
};

use crate::{
    protocol::{
        ThreadSummaryView, ToolCallView, TranscriptContentState, TranscriptEntryKind,
        TranscriptEntryView,
    },
    state::{ApprovalKind, PendingApproval, RelayState},
};

use super::{protocol, Captures, PendingResponses, SessionRuntime, Sessions};

pub(crate) struct ReaderContext {
    pub(crate) stdout: super::Inbound,
    pub(crate) stdin: super::Outbound,
    pub(crate) pending_responses: PendingResponses,
    pub(crate) state: Arc<RwLock<RelayState>>,
    pub(crate) sessions: Sessions,
    pub(crate) captures: Captures,
    pub(crate) provider_key: &'static str,
}

pub(crate) async fn write_line(
    stdin: &mut (dyn tokio::io::AsyncWrite + Send + Unpin),
    value: &Value,
    display_name: &str,
) -> Result<(), String> {
    let serialized = serde_json::to_string(value)
        .map_err(|error| format!("failed to encode JSON-RPC message: {error}"))?;
    stdin
        .write_all(serialized.as_bytes())
        .await
        .map_err(|error| format!("failed to write to {display_name} stdin: {error}"))?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|error| format!("failed to finalize {display_name} message: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("failed to flush {display_name} stdin: {error}"))
}

pub(crate) fn spawn_stdout_reader(context: ReaderContext) {
    let ReaderContext {
        stdout,
        stdin,
        pending_responses,
        state,
        sessions,
        captures,
        provider_key,
    } = context;

    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    handle_line(
                        &line,
                        &stdin,
                        &pending_responses,
                        &state,
                        &sessions,
                        &captures,
                        provider_key,
                    )
                    .await;
                }
                Ok(None) => {
                    fail_pending(
                        &pending_responses,
                        format!("{provider_key} ACP stream closed"),
                    )
                    .await;
                    let mut relay = state.write().await;
                    relay.set_provider_connection(provider_key, false);
                    relay.fail_in_flight_turns_for_provider(provider_key);
                    relay.push_log("error", format!("{provider_key} ACP stdout closed."));
                    relay.notify();
                    break;
                }
                Err(error) => {
                    fail_pending(
                        &pending_responses,
                        format!("{provider_key} ACP stream failed: {error}"),
                    )
                    .await;
                    let mut relay = state.write().await;
                    relay.set_provider_connection(provider_key, false);
                    relay.fail_in_flight_turns_for_provider(provider_key);
                    relay.push_log(
                        "error",
                        format!("Failed to read {provider_key} stdout: {error}"),
                    );
                    relay.notify();
                    break;
                }
            }
        }
    });
}

/// Fail every in-flight request when the stream dies.
///
/// Without this a caller waits out its own timeout — 60s for an ordinary
/// request, and an hour for a `session/prompt` task — on a process that is
/// already gone.
async fn fail_pending(pending_responses: &PendingResponses, reason: String) {
    let pending: Vec<_> = pending_responses.lock().await.drain().collect();
    for (_, sender) in pending {
        let _ = sender.send(Err(reason.clone()));
    }
}

pub(crate) fn spawn_stderr_reader(
    stderr: ChildStderr,
    state: Arc<RwLock<RelayState>>,
    provider_key: &'static str,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let mut relay = state.write().await;
                    relay.push_log(provider_key, line);
                    relay.notify();
                }
                Ok(None) => break,
                Err(error) => {
                    let mut relay = state.write().await;
                    relay.push_log(
                        "error",
                        format!("Failed to read {provider_key} stderr: {error}"),
                    );
                    relay.notify();
                    break;
                }
            }
        }
    });
}

#[allow(clippy::too_many_arguments)]
async fn handle_line(
    line: &str,
    stdin: &super::Outbound,
    pending_responses: &PendingResponses,
    state: &Arc<RwLock<RelayState>>,
    sessions: &Sessions,
    captures: &Captures,
    provider_key: &'static str,
) {
    let payload: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => {
            let mut relay = state.write().await;
            relay.push_log(provider_key, line.to_string());
            relay.notify();
            return;
        }
    };

    let has_id = payload.get("id").is_some();
    let has_method = payload.get("method").is_some();

    // Server → client request (permissions, and Cursor's `cursor/*` extensions).
    if has_id && has_method {
        handle_server_request(payload, stdin, state, sessions, provider_key).await;
        return;
    }

    // Response to one of ours.
    if has_id && (payload.get("result").is_some() || payload.get("error").is_some()) {
        let request_id = normalize_id(payload.get("id").unwrap_or(&Value::Null));
        if let Some(sender) = pending_responses.lock().await.remove(&request_id) {
            let result = if let Some(error) = payload.get("error") {
                Err(acp_error_message(error))
            } else {
                Ok(payload.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = sender.send(result);
        }
        return;
    }

    if has_method {
        handle_notification(payload, state, sessions, captures, provider_key).await;
        return;
    }

    let mut relay = state.write().await;
    relay.push_log(provider_key, line.to_string());
    relay.notify();
}

fn normalize_id(id: &Value) -> String {
    match id {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// ACP errors carry the useful text in `data.message`; `message` alone is often
/// just the JSON-RPC class ("Invalid params").
pub(crate) fn acp_error_message(error: &Value) -> String {
    let outer = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown ACP error");
    match error
        .get("data")
        .and_then(|data| data.get("message"))
        .and_then(Value::as_str)
    {
        Some(detail) if detail != outer => format!("{outer}: {detail}"),
        _ => outer.to_string(),
    }
}

async fn handle_notification(
    payload: Value,
    state: &Arc<RwLock<RelayState>>,
    sessions: &Sessions,
    captures: &Captures,
    provider_key: &'static str,
) {
    let method = payload.get("method").and_then(Value::as_str).unwrap_or("");
    if method != "session/update" {
        return;
    }
    let Some(params) = payload.get("params") else {
        return;
    };
    let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
        return;
    };
    let Some(update) = params.get("update") else {
        return;
    };

    let op = {
        let mut sessions = sessions.lock().await;
        let session = sessions.entry(session_id.to_string()).or_default();
        plan_update(update, session)
    };
    if matches!(op, TranscriptOp::Ignore) {
        return;
    }

    // A `session/load` replay is captured for `read_thread` instead of being
    // written into live state.
    {
        let mut captures = captures.lock().await;
        if let Some(buffer) = captures.get_mut(session_id) {
            capture_op(buffer, op);
            return;
        }
    }

    let turn_id = sessions
        .lock()
        .await
        .get(session_id)
        .and_then(|session| session.turn_id.clone());

    let mut relay = state.write().await;
    if apply_op(&mut relay, session_id, turn_id, op, provider_key) {
        relay.notify();
    }
}

/// What a `session/update` means, decided without touching `RelayState`.
///
/// Splitting the decision from the application is what lets a `session/load`
/// replay and a live turn share one translation: the replay drops the ops into
/// a buffer, the live path applies them to state.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum TranscriptOp {
    User {
        item_id: String,
        text: String,
    },
    AgentChunk {
        item_id: String,
        delta: String,
        text: String,
    },
    ThoughtChunk {
        item_id: String,
        delta: String,
        text: String,
    },
    Tool {
        item_id: String,
        title: String,
        command: Option<String>,
        output: Option<String>,
        status: String,
    },
    Title(String),
    /// The agent moved the session to a different mode on its own initiative.
    ModeChanged(String),
    Ignore,
}

/// Map ACP tool statuses onto the relay's transcript-item statuses.
fn tool_status(raw: Option<&str>) -> String {
    match raw {
        Some("completed") => "completed",
        Some("failed") | Some("error") => "failed",
        Some("in_progress") => "running",
        _ => "pending",
    }
    .to_string()
}

/// Tool output, from either shape.
///
/// `content` is the portable ACP representation (an array of content blocks);
/// `rawOutput` is Cursor's richer extension carrying `{exitCode, stdout, stderr}`.
/// Preferring `rawOutput` keeps shell output faithful where it exists, while the
/// `content` fallback is what makes this bridge work against a non-Cursor agent.
fn tool_output(update: &Value) -> Option<String> {
    if let Some(raw) = update.get("rawOutput") {
        let stdout = raw.get("stdout").and_then(Value::as_str).unwrap_or("");
        let stderr = raw.get("stderr").and_then(Value::as_str).unwrap_or("");
        let joined = format!("{stdout}{stderr}");
        if !joined.is_empty() {
            return Some(joined);
        }
    }
    let text = protocol::content_text(update.get("content")?);
    (!text.is_empty()).then_some(text)
}

pub(crate) fn plan_update(update: &Value, session: &mut SessionRuntime) -> TranscriptOp {
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match kind {
        "user_message_chunk" => {
            let text = protocol::content_text(update.get("content").unwrap_or(&Value::Null));
            if text.is_empty() {
                return TranscriptOp::Ignore;
            }
            // A user message is a turn boundary: whatever the agent was saying
            // belongs to the *previous* turn and is finished. Without this, a
            // replayed `user → agent → user → agent` history appends the second
            // reply onto the first one's entry — misordering the transcript and
            // renumbering items relative to the live run, which closes its
            // streams on every `start_turn`.
            session.close_streams();
            TranscriptOp::User {
                item_id: session.next_item_id("user"),
                text,
            }
        }
        "agent_message_chunk" => {
            let delta = protocol::content_text(update.get("content").unwrap_or(&Value::Null));
            if delta.is_empty() {
                return TranscriptOp::Ignore;
            }
            let item_id = match session.agent_item.clone() {
                Some(existing) => existing,
                None => {
                    let minted = session.next_item_id("msg");
                    session.agent_item = Some(minted.clone());
                    session.agent_text.clear();
                    minted
                }
            };
            session.agent_text.push_str(&delta);
            TranscriptOp::AgentChunk {
                item_id,
                delta,
                text: session.agent_text.clone(),
            }
        }
        "agent_thought_chunk" => {
            let delta = protocol::content_text(update.get("content").unwrap_or(&Value::Null));
            if delta.is_empty() {
                return TranscriptOp::Ignore;
            }
            let item_id = match session.thought_item.clone() {
                Some(existing) => existing,
                None => {
                    let minted = session.next_item_id("thought");
                    session.thought_item = Some(minted.clone());
                    session.thought_text.clear();
                    minted
                }
            };
            session.thought_text.push_str(&delta);
            TranscriptOp::ThoughtChunk {
                item_id,
                delta,
                text: session.thought_text.clone(),
            }
        }
        "tool_call" | "tool_call_update" => {
            let Some(raw_id) = update.get("toolCallId").and_then(Value::as_str) else {
                return TranscriptOp::Ignore;
            };
            // A tool call interrupts any streaming message, so the next chunk
            // opens a new entry rather than appending across the boundary.
            session.agent_item = None;
            session.agent_text.clear();
            session.thought_item = None;
            session.thought_text.clear();

            let item_id = match session.tool_items.get(raw_id) {
                Some(existing) => existing.clone(),
                None => {
                    let minted = session.next_item_id("tool");
                    session
                        .tool_items
                        .insert(raw_id.to_string(), minted.clone());
                    minted
                }
            };

            // Merge into the accumulated view: ACP tool updates are partial, so
            // a field absent from *this* event means "unchanged", not "empty".
            let meta = session.tool_meta.entry(item_id.clone()).or_default();
            if let Some(title) = update
                .get("title")
                .and_then(Value::as_str)
                .filter(|title| !title.is_empty())
            {
                meta.title = title.to_string();
            }
            if let Some(command) = update
                .get("rawInput")
                .and_then(|input| input.get("command"))
                .and_then(Value::as_str)
            {
                meta.command = Some(command.to_string());
            }
            if let Some(output) = tool_output(update) {
                meta.output = Some(output);
            }
            if let Some(status) = update.get("status").and_then(Value::as_str) {
                meta.status = tool_status(Some(status));
            }

            TranscriptOp::Tool {
                item_id,
                title: meta.title.clone(),
                command: meta.command.clone(),
                output: meta.output.clone(),
                status: meta.status.clone(),
            }
        }
        // ACP lets the agent change mode itself and announce it here. Ignoring
        // it would leave the relay believing a thread is still read-only after
        // the agent moved it back to full `agent` mode.
        "current_mode_update" => update
            .get("currentModeId")
            .and_then(Value::as_str)
            .filter(|mode| !mode.is_empty())
            .map(|mode| TranscriptOp::ModeChanged(mode.to_string()))
            .unwrap_or(TranscriptOp::Ignore),
        "session_info_update" => update
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.is_empty())
            .map(|title| TranscriptOp::Title(title.to_string()))
            .unwrap_or(TranscriptOp::Ignore),
        // `available_commands_update`, `plan`, `usage_update` have no relay
        // equivalent yet.
        _ => TranscriptOp::Ignore,
    }
}

fn tool_view(title: &str, command: Option<&str>, output: Option<&str>) -> ToolCallView {
    ToolCallView {
        item_type: if command.is_some() {
            "command_execution".to_string()
        } else {
            "tool_call".to_string()
        },
        name: title.to_string(),
        title: title.to_string(),
        detail: None,
        query: None,
        path: None,
        url: None,
        command: command.map(str::to_string),
        input_preview: command.map(str::to_string),
        result_preview: output.map(str::to_string),
        diff: None,
        file_changes: Vec::new(),
        apply_state: None,
        file_changes_omitted: false,
        can_apply: None,
    }
}

/// Fold an op into a replay buffer, merging with the entry it continues.
pub(crate) fn capture_op(buffer: &mut Vec<TranscriptEntryView>, op: TranscriptOp) {
    let entry = match op {
        TranscriptOp::User { item_id, text } => TranscriptEntryView {
            item_id: Some(item_id),
            kind: TranscriptEntryKind::UserText,
            text: Some(text),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            content_state: TranscriptContentState::Full,
        },
        TranscriptOp::AgentChunk { item_id, text, .. } => TranscriptEntryView {
            item_id: Some(item_id),
            kind: TranscriptEntryKind::AgentText,
            text: Some(text),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            content_state: TranscriptContentState::Full,
        },
        TranscriptOp::ThoughtChunk { item_id, text, .. } => TranscriptEntryView {
            item_id: Some(item_id),
            kind: TranscriptEntryKind::Reasoning,
            text: Some(text),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            content_state: TranscriptContentState::Full,
        },
        TranscriptOp::Tool {
            item_id,
            title,
            command,
            output,
            status,
        } => TranscriptEntryView {
            item_id: Some(item_id),
            kind: TranscriptEntryKind::ToolCall,
            text: Some(title.clone()),
            status,
            turn_id: None,
            tool: Some(tool_view(&title, command.as_deref(), output.as_deref())),
            content_state: TranscriptContentState::Full,
        },
        TranscriptOp::Title(_) | TranscriptOp::ModeChanged(_) | TranscriptOp::Ignore => return,
    };

    // Chunked kinds re-emit the accumulated text under a stable id; replace in
    // place so the buffer holds one entry per item rather than one per chunk.
    if let Some(existing) = buffer
        .iter_mut()
        .find(|candidate| candidate.item_id == entry.item_id)
    {
        *existing = entry;
    } else {
        buffer.push(entry);
    }
}

/// Apply an op to live state. Returns whether anything changed.
fn apply_op(
    relay: &mut RelayState,
    thread_id: &str,
    turn_id: Option<String>,
    op: TranscriptOp,
    provider_key: &'static str,
) -> bool {
    let route = thread_route(relay, thread_id, provider_key);
    if matches!(route, ThreadRoute::Drop) {
        return false;
    }
    let background = matches!(route, ThreadRoute::Background);
    let now = crate::state::unix_now();
    let turn = turn_id.unwrap_or_default();

    match op {
        TranscriptOp::User { item_id, text } => {
            apply_user_message(relay, thread_id, item_id, text, turn, provider_key);
        }
        TranscriptOp::AgentChunk {
            item_id,
            delta,
            text,
        } => {
            if background {
                relay.bg_start_agent_message(thread_id, item_id.clone(), turn.clone(), now);
                relay.bg_append_agent_delta(thread_id, &item_id, &delta, &turn, now);
                relay.bg_complete_agent_message(thread_id, item_id, text, turn, now);
            } else {
                relay.start_agent_message_for_thread(thread_id, item_id.clone(), turn.clone());
                relay.append_agent_delta_for_thread(thread_id, &item_id, &delta, &turn);
                relay.complete_agent_message_for_thread(thread_id, item_id, text, turn);
                relay.touch_thread_progress(thread_id, Some("responding"), None);
            }
        }
        TranscriptOp::ThoughtChunk { item_id, text, .. } => {
            let entry = (
                TranscriptEntryKind::Reasoning,
                Some(text),
                "completed".to_string(),
            );
            if background {
                relay.bg_upsert_transcript_item(
                    thread_id,
                    item_id,
                    entry.0,
                    entry.1,
                    entry.2,
                    Some(turn),
                    None,
                    now,
                );
            } else {
                relay.upsert_transcript_item_for_thread(
                    thread_id,
                    item_id,
                    entry.0,
                    entry.1,
                    entry.2,
                    Some(turn),
                    None,
                );
                relay.touch_thread_progress(thread_id, Some("thinking"), None);
            }
        }
        TranscriptOp::Tool {
            item_id,
            title,
            command,
            output,
            status,
        } => {
            let tool = tool_view(&title, command.as_deref(), output.as_deref());
            if background {
                relay.bg_upsert_transcript_item(
                    thread_id,
                    item_id,
                    TranscriptEntryKind::ToolCall,
                    Some(title),
                    status,
                    Some(turn),
                    Some(tool),
                    now,
                );
            } else {
                relay.upsert_transcript_item_for_thread(
                    thread_id,
                    item_id,
                    TranscriptEntryKind::ToolCall,
                    Some(title.clone()),
                    status,
                    Some(turn),
                    Some(tool),
                );
                relay.touch_thread_progress(thread_id, Some("working"), Some(&title));
            }
        }
        TranscriptOp::Title(title) => {
            let Some(mut thread) = relay
                .threads
                .iter()
                .find(|thread| thread.id == thread_id)
                .cloned()
            else {
                return false;
            };
            // Never overwrite a title the user set.
            if thread.renamed {
                return false;
            }
            thread.name = Some(title);
            relay.upsert_thread(thread);
        }
        TranscriptOp::ModeChanged(mode) => {
            // Surface it: a thread the user set to read-only silently leaving
            // `plan` is a permission change they never asked for, and the relay
            // cannot enforce ACP modes itself.
            relay.push_log(
                provider_key,
                format!("`{thread_id}` switched to `{mode}` mode."),
            );
        }
        TranscriptOp::Ignore => return false,
    }
    true
}

pub(crate) fn apply_user_message(
    relay: &mut RelayState,
    thread_id: &str,
    item_id: String,
    text: String,
    turn_id: String,
    provider_key: &'static str,
) {
    if matches!(
        thread_route(relay, thread_id, provider_key),
        ThreadRoute::Background
    ) {
        relay.bg_upsert_user_message(thread_id, item_id, text, turn_id, crate::state::unix_now());
    } else {
        relay.upsert_user_message_for_thread(thread_id, item_id, text, turn_id);
    }
}

pub(crate) fn apply_turn_started(
    relay: &mut RelayState,
    thread_id: &str,
    turn_id: &str,
    provider_key: &'static str,
) {
    match thread_route(relay, thread_id, provider_key) {
        ThreadRoute::Background => {
            relay.bg_set_active_turn(
                thread_id,
                Some(turn_id.to_string()),
                crate::state::unix_now(),
            );
            relay.bg_set_thread_status(
                thread_id,
                "working".to_string(),
                Vec::new(),
                crate::state::unix_now(),
            );
        }
        ThreadRoute::Active => {
            relay.set_active_turn(Some(turn_id.to_string()));
            relay.set_thread_status(thread_id, "working".to_string(), Vec::new());
            relay.touch_progress(Some("thinking"), None);
        }
        ThreadRoute::Drop => {}
    }
}

pub(crate) fn apply_turn_finished(
    relay: &mut RelayState,
    thread_id: &str,
    turn_id: &str,
    outcome: Result<Value, String>,
    provider_key: &'static str,
) {
    let failure = match &outcome {
        Ok(result) => {
            // `stopReason` is the turn's verdict; `end_turn` is the only clean one.
            match result.get("stopReason").and_then(Value::as_str) {
                Some("end_turn") | Some("cancelled") | None => None,
                Some(other) => Some(other.to_string()),
            }
        }
        Err(error) => Some(error.clone()),
    };

    if let Some(reason) = &failure {
        // A failed turn must be visible IN the transcript, not just in the log.
        let item_id = format!("turn-error:{turn_id}");
        relay.upsert_transcript_item_for_thread(
            thread_id,
            item_id,
            TranscriptEntryKind::Error,
            Some(reason.clone()),
            "failed".to_string(),
            Some(turn_id.to_string()),
            None,
        );
    }

    match thread_route(relay, thread_id, provider_key) {
        ThreadRoute::Background => {
            relay.bg_set_active_turn(thread_id, None, crate::state::unix_now());
            relay.bg_set_thread_status(
                thread_id,
                "idle".to_string(),
                Vec::new(),
                crate::state::unix_now(),
            );
        }
        _ => {
            relay.set_active_turn(None);
            relay.set_thread_status(thread_id, "idle".to_string(), Vec::new());
            relay.clear_thread_progress(thread_id);
        }
    }
}

async fn handle_server_request(
    payload: Value,
    stdin: &super::Outbound,
    state: &Arc<RwLock<RelayState>>,
    sessions: &Sessions,
    provider_key: &'static str,
) {
    let method = payload.get("method").and_then(Value::as_str).unwrap_or("");
    let request_id = payload.get("id").cloned().unwrap_or(Value::Null);
    let params = payload.get("params").cloned().unwrap_or(Value::Null);

    if method != "session/request_permission" {
        // Unhandled server request: answer with an empty result so the agent is
        // never left blocking on a method the relay does not implement.
        let mut stdin = stdin.lock().await;
        let _ = write_line(
            &mut **stdin,
            &json!({ "jsonrpc": "2.0", "id": request_id, "result": {} }),
            provider_key,
        )
        .await;
        return;
    }

    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let auto_approve = sessions
        .lock()
        .await
        .get(&session_id)
        .map(|session| protocol::auto_approves(&session.approval_policy))
        .unwrap_or(false);

    if auto_approve {
        let outcome = match auto_approve_option_id(&options) {
            Some(id) => json!({ "outcome": "selected", "optionId": id }),
            None => json!({ "outcome": "cancelled" }),
        };
        let mut stdin = stdin.lock().await;
        let _ = write_line(
            &mut **stdin,
            &json!({ "jsonrpc": "2.0", "id": request_id, "result": { "outcome": outcome } }),
            provider_key,
        )
        .await;
        return;
    }

    let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
    let title = tool_call
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Tool call")
        .to_string();
    let command = match tool_call
        .get("rawInput")
        .and_then(|input| input.get("command"))
        .and_then(Value::as_str)
    {
        Some(command) => Some(command.to_string()),
        // Cursor's permission request omits `rawInput`; recover it from the
        // `tool_call` the relay already recorded.
        None => {
            let raw_id = tool_call.get("toolCallId").and_then(Value::as_str);
            match raw_id {
                Some(raw_id) => sessions
                    .lock()
                    .await
                    .get(&session_id)
                    .and_then(|session| command_for_tool_call(session, raw_id)),
                None => None,
            }
        }
    };
    let context = protocol::content_text(tool_call.get("content").unwrap_or(&Value::Null));
    let (available_decisions, supports_session_scope) = protocol::approval_decisions(&options);

    let cwd = sessions
        .lock()
        .await
        .get(&session_id)
        .map(|session| session.cwd.clone())
        .filter(|cwd| !cwd.is_empty());

    let mut relay = state.write().await;
    relay.add_pending_approval(PendingApproval {
        request_id: format!("acp-approval-{}", normalize_id(&request_id)),
        raw_request_id: request_id,
        kind: ApprovalKind::Command,
        thread_id: session_id.clone(),
        summary: title,
        detail: (!context.is_empty()).then(|| context.clone()),
        command,
        cwd,
        context_preview: (!context.is_empty()).then_some(context),
        // The bridge answers with an ACP `optionId`, so the raw option list has
        // to survive the round trip.
        requested_permissions: Some(Value::Array(options)),
        available_decisions,
        supports_session_scope,
    });
    relay.set_thread_status(
        &session_id,
        "waiting".to_string(),
        vec!["waitingOnApproval".to_string()],
    );
    relay.notify();
}

/// The command behind a tool call, recovered from the session's accumulated
/// view.
///
/// `session/request_permission` carries only a title and status — the command
/// rode on the earlier `tool_call` update — so the approval card has to look it
/// back up or show the user nothing but a label.
pub(crate) fn command_for_tool_call(session: &SessionRuntime, raw_id: &str) -> Option<String> {
    let item_id = session.tool_items.get(raw_id)?;
    session
        .tool_meta
        .get(item_id)
        .and_then(|meta| meta.command.clone())
}

/// The option to auto-answer a permission request with under a no-prompt policy.
///
/// Deliberately prefers `allow_once` over `allow_always`: an "always" grant is
/// recorded in the *agent's* own allowlist, outliving the thread and the relay
/// process and invisible to the relay's policy layer. Answering once per call
/// keeps every tool use round-tripping through the bridge, so the relay remains
/// the authority on what this thread may do. `allow_always` is only used when
/// the agent offers no single-shot option, since deadlocking the turn is worse.
pub(crate) fn auto_approve_option_id(options: &[Value]) -> Option<String> {
    for kind in ["allow_once", "allow_always"] {
        if let Some(id) = options
            .iter()
            .find(|option| option.get("kind").and_then(Value::as_str) == Some(kind))
            .and_then(|option| option.get("optionId").and_then(Value::as_str))
        {
            return Some(id.to_string());
        }
    }
    None
}

/// Serve `read_thread` from the relay's own runtime when a turn is streaming.
///
/// Returns `None` when there is nothing to serve — either no runtime (so the
/// relay has no transcript and the provider read is unavoidable) or no live turn
/// (so a replay is safe and gives the provider's authoritative view).
///
/// The `cwd` guard matters: `resume_session_inner` and `ensure_thread_runtime_loaded`
/// path-scope-check `thread.cwd`, so an empty one would be rejected downstream —
/// better to fall through to the provider than to answer with a thread row that
/// fails validation.
pub(crate) fn sync_data_from_runtime(
    relay: &RelayState,
    thread_id: &str,
    provider_key: &str,
) -> Option<crate::provider::ThreadSyncData> {
    let runtime = relay.runtime_for_thread(thread_id)?;
    if !runtime.has_live_turn() || runtime.current_cwd.is_empty() {
        return None;
    }

    let transcript = runtime.transcript_views();
    let mut thread = runtime
        .summary
        .clone()
        .unwrap_or_else(|| ThreadSummaryView {
            id: thread_id.to_string(),
            name: None,
            preview: transcript
                .iter()
                .rev()
                .find_map(|entry| entry.text.clone())
                .unwrap_or_default(),
            cwd: runtime.current_cwd.clone(),
            updated_at: runtime.last_update_at,
            source: provider_key.to_string(),
            status: runtime.current_status.clone(),
            model_provider: provider_key.to_string(),
            provider: provider_key.to_string(),
            forked_from: None,
            renamed: false,
        });
    // The runtime's live cwd wins over whatever a cached summary carries:
    // `resume_session_inner` and `ensure_thread_runtime_loaded` path-scope-check
    // this field, and an empty or stale one is rejected downstream.
    thread.cwd = runtime.current_cwd.clone();

    Some(crate::provider::ThreadSyncData {
        thread,
        status: runtime.current_status.clone(),
        active_flags: runtime.active_flags.clone(),
        transcript,
    })
}

/// Where an event for `thread_id` should land.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ThreadRoute {
    Active,
    Background,
    Drop,
}

/// ACP stamps every notification with `sessionId`, so routing is a direct
/// comparison against the active thread — no "which thread did this mean?"
/// inference is needed. Without this, a background thread's events leak into
/// whatever transcript the user happens to be looking at.
fn thread_route(relay: &RelayState, thread_id: &str, provider_key: &str) -> ThreadRoute {
    match relay.active_thread_id.as_deref() {
        Some(active) if active == thread_id => ThreadRoute::Active,
        Some(_) => ThreadRoute::Background,
        None if thread_belongs_to_provider(relay, thread_id, provider_key) => {
            ThreadRoute::Background
        }
        None => ThreadRoute::Drop,
    }
}

fn thread_belongs_to_provider(relay: &RelayState, thread_id: &str, provider_key: &str) -> bool {
    if let Some(thread) = relay.threads.iter().find(|thread| thread.id == thread_id) {
        return thread.provider == provider_key
            || thread.source == provider_key
            || thread.model_provider == provider_key;
    }
    relay.provider_name.is_empty() || relay.provider_name == provider_key
}
