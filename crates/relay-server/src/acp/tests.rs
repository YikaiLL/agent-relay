//! Translation tests driven by wire payloads captured verbatim from the
//! 2026-08-11 `cursor-agent 2026.08.04-aaa8809` spike.

use serde_json::json;

use super::rpc::{capture_op, plan_update, TranscriptOp};
use super::SessionRuntime;
use crate::protocol::TranscriptEntryView;

fn session() -> SessionRuntime {
    SessionRuntime::default()
}

/// Drive a whole `session/load` replay through the same path `read_thread` uses.
fn replay(updates: &[serde_json::Value]) -> Vec<TranscriptEntryView> {
    let mut runtime = session();
    let mut buffer = Vec::new();
    for update in updates {
        capture_op(&mut buffer, plan_update(update, &mut runtime));
    }
    buffer
}

fn user(text: &str) -> serde_json::Value {
    json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":text}})
}

fn agent(text: &str) -> serde_json::Value {
    json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}})
}

#[test]
fn agent_chunks_accumulate_into_one_item() {
    let mut runtime = session();
    let mut last = TranscriptOp::Ignore;
    for piece in ["`hello", ".txt", "` says"] {
        last = plan_update(
            &json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":piece}}),
            &mut runtime,
        );
    }
    match last {
        TranscriptOp::AgentChunk {
            item_id,
            delta,
            text,
        } => {
            assert_eq!(item_id, "acp-msg-1", "all chunks share one minted item");
            assert_eq!(delta, "` says", "the delta is just the newest piece");
            assert_eq!(text, "`hello.txt` says", "text is the accumulation");
        }
        other => panic!("expected AgentChunk, got {other:?}"),
    }
}

#[test]
fn a_tool_call_closes_the_open_message_so_text_does_not_bleed_across_it() {
    let mut runtime = session();
    plan_update(
        &json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"before"}}),
        &mut runtime,
    );
    plan_update(
        &json!({"sessionUpdate":"tool_call","toolCallId":"call-1","title":"`cat`","status":"pending"}),
        &mut runtime,
    );
    let after = plan_update(
        &json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"after"}}),
        &mut runtime,
    );
    match after {
        TranscriptOp::AgentChunk { item_id, text, .. } => {
            assert_eq!(item_id, "acp-msg-2", "a new message entry opened");
            assert_eq!(text, "after", "accumulation restarted");
        }
        other => panic!("expected AgentChunk, got {other:?}"),
    }
}

#[test]
fn tool_call_and_its_update_share_one_item_despite_the_newline_in_acps_id() {
    // Measured: a live toolCallId embeds a raw newline, which is exactly why the
    // relay mints its own ids and keys off ACP's only as a lookup.
    let raw_id =
        "call-3309e706-88e5-472b-91ce-f92ed275425c-0\nfc_b5ce28f3-0445-9b76-a044-dfd055991a59_0";
    let mut runtime = session();

    let started = plan_update(
        &json!({
            "sessionUpdate":"tool_call","toolCallId":raw_id,
            "title":"`cat hello.txt`","kind":"execute","status":"pending",
            "rawInput":{"command":"cat hello.txt"}
        }),
        &mut runtime,
    );
    let completed = plan_update(
        &json!({
            "sessionUpdate":"tool_call_update","toolCallId":raw_id,"status":"completed",
            "rawOutput":{"exitCode":0,"stdout":"hello from the acp spike\n","stderr":""}
        }),
        &mut runtime,
    );

    let (
        TranscriptOp::Tool {
            item_id: a,
            command,
            status: started_status,
            ..
        },
        TranscriptOp::Tool {
            item_id: b,
            output,
            status: done_status,
            ..
        },
    ) = (started, completed)
    else {
        panic!("expected two Tool ops");
    };
    assert_eq!(
        a, b,
        "the update must land on the started call, not a new row"
    );
    assert!(
        !a.contains('\n'),
        "minted ids must not inherit ACP's newline"
    );
    assert_eq!(command.as_deref(), Some("cat hello.txt"));
    assert_eq!(output.as_deref(), Some("hello from the acp spike\n"));
    assert_eq!(started_status, "pending");
    assert_eq!(done_status, "completed");
}

#[test]
fn replay_ids_match_live_ids_because_ordinals_are_per_kind() {
    // ACP reassigns its own ids on `session/load` (a live `call-…` replays as
    // `replay-0-1`), so item identity has to come from per-kind ordering. Live
    // and replay differ only by the leading user_message_chunk, which is why the
    // counters are per kind rather than global.
    let mut live = session();
    plan_update(
        &json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Running `cat`"}}),
        &mut live,
    );
    let live_tool = plan_update(
        &json!({"sessionUpdate":"tool_call","toolCallId":"call-live","title":"`cat`","status":"pending"}),
        &mut live,
    );

    let mut replay = session();
    plan_update(
        &json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Run cat"}}),
        &mut replay,
    );
    plan_update(
        &json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Running `cat`"}}),
        &mut replay,
    );
    let replay_tool = plan_update(
        &json!({"sessionUpdate":"tool_call","toolCallId":"replay-0-1","title":"`cat`","status":"pending"}),
        &mut replay,
    );

    let (
        TranscriptOp::Tool {
            item_id: live_id, ..
        },
        TranscriptOp::Tool {
            item_id: replay_id, ..
        },
    ) = (live_tool, replay_tool)
    else {
        panic!("expected Tool ops");
    };
    assert_eq!(
        live_id, replay_id,
        "a reload must not renumber the item a fork anchor points at"
    );
}

#[test]
fn thought_chunks_are_reasoning_not_agent_text() {
    let mut runtime = session();
    let op = plan_update(
        &json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"thinking"}}),
        &mut runtime,
    );
    assert!(
        matches!(op, TranscriptOp::ThoughtChunk { .. }),
        "got {op:?}"
    );
}

#[test]
fn session_info_update_carries_the_generated_title() {
    let mut runtime = session();
    let op = plan_update(
        &json!({"sessionUpdate":"session_info_update","title":"Cat File Content"}),
        &mut runtime,
    );
    assert_eq!(op, TranscriptOp::Title("Cat File Content".to_string()));
}

#[test]
fn unknown_and_empty_updates_are_ignored_rather_than_producing_blank_entries() {
    let mut runtime = session();
    for payload in [
        json!({"sessionUpdate":"available_commands_update","availableCommands":[]}),
        json!({"sessionUpdate":"usage_update","used":10}),
        json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":""}}),
        json!({"sessionUpdate":"tool_call","title":"no id"}),
        json!({}),
    ] {
        assert_eq!(
            plan_update(&payload, &mut runtime),
            TranscriptOp::Ignore,
            "payload should be ignored: {payload}"
        );
    }
    // Nothing was minted, so a later real chunk still starts at ordinal 1.
    let op = plan_update(
        &json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}),
        &mut runtime,
    );
    assert!(matches!(op, TranscriptOp::AgentChunk { ref item_id, .. } if item_id == "acp-msg-1"));
}

#[test]
fn acp_error_messages_surface_the_nested_detail() {
    // The useful text lives in `data.message`; `message` alone is the JSON-RPC
    // class and would tell the user nothing.
    let error = json!({
        "code": -32000,
        "message": "Authentication required",
        "data": {"message": "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'."}
    });
    let rendered = super::rpc::acp_error_message(&error);
    assert!(rendered.contains("agent login"), "got {rendered}");

    // A duplicated detail must not be printed twice.
    let dup = json!({"message":"boom","data":{"message":"boom"}});
    assert_eq!(super::rpc::acp_error_message(&dup), "boom");
    assert_eq!(
        super::rpc::acp_error_message(&json!({})),
        "unknown ACP error"
    );
}

// ---------------------------------------------------------------------------
// Regressions from the 2026-08-11 Codex review of the ACP skeleton.
// ---------------------------------------------------------------------------

#[test]
fn multi_turn_replay_keeps_each_assistant_reply_in_its_own_entry() {
    // A `user_message_chunk` is a turn boundary: the previous assistant message
    // is finished. Without closing the open stream, `agent2` appends onto
    // `acp-msg-1` and the reloaded history reads as one giant reply attached to
    // the first question.
    let entries = replay(&[user("q1"), agent("a1"), user("q2"), agent("a2")]);

    let texts: Vec<_> = entries
        .iter()
        .map(|entry| (entry.kind, entry.text.clone().unwrap_or_default()))
        .collect();
    assert_eq!(
        texts,
        vec![
            (
                crate::protocol::TranscriptEntryKind::UserText,
                "q1".to_string()
            ),
            (
                crate::protocol::TranscriptEntryKind::AgentText,
                "a1".to_string()
            ),
            (
                crate::protocol::TranscriptEntryKind::UserText,
                "q2".to_string()
            ),
            (
                crate::protocol::TranscriptEntryKind::AgentText,
                "a2".to_string()
            ),
        ],
        "each reply belongs to the question it answered"
    );

    let ids: Vec<_> = entries
        .iter()
        .filter_map(|entry| entry.item_id.clone())
        .collect();
    assert_eq!(ids.len(), 4);
    assert_eq!(
        ids.iter().collect::<std::collections::HashSet<_>>().len(),
        4,
        "no two entries may share an item id: {ids:?}"
    );
}

#[test]
fn a_user_turn_boundary_makes_live_and_replay_ids_agree_without_tools() {
    // The no-tool multi-turn case is the common one, and it is where live and
    // replay diverge if only tool calls close the stream: live closes on every
    // `start_turn`, replay only saw `user_message_chunk`.
    let mut live = session();
    // Turn 1 — `start_turn` closes streams before the prompt goes out.
    live.close_streams();
    plan_update(&agent("a1"), &mut live);
    // Turn 2.
    live.close_streams();
    let live_second = plan_update(&agent("a2"), &mut live);

    let mut replayed = session();
    plan_update(&user("q1"), &mut replayed);
    plan_update(&agent("a1"), &mut replayed);
    plan_update(&user("q2"), &mut replayed);
    let replay_second = plan_update(&agent("a2"), &mut replayed);

    let (
        TranscriptOp::AgentChunk {
            item_id: live_id, ..
        },
        TranscriptOp::AgentChunk {
            item_id: replay_id, ..
        },
    ) = (live_second, replay_second)
    else {
        panic!("expected AgentChunk ops");
    };
    assert_eq!(
        live_id, replay_id,
        "a reload must not renumber the second reply"
    );
}

#[test]
fn a_tool_completion_keeps_the_title_and_command_from_its_start() {
    // ACP tool updates are partial: `tool_call_update` carries only
    // toolCallId/status/rawOutput. Treating the absent fields as empty and then
    // replacing the whole entry loses what the tool actually was.
    let raw_id = "call-abc\nfc_def";
    let entries = replay(&[
        json!({
            "sessionUpdate":"tool_call","toolCallId":raw_id,
            "title":"`cat hello.txt`","kind":"execute","status":"pending",
            "rawInput":{"command":"cat hello.txt"}
        }),
        json!({
            "sessionUpdate":"tool_call_update","toolCallId":raw_id,"status":"completed",
            "rawOutput":{"exitCode":0,"stdout":"hello from the acp spike\n","stderr":""}
        }),
    ]);

    assert_eq!(entries.len(), 1, "the update belongs to the started call");
    let entry = &entries[0];
    assert_eq!(entry.status, "completed");
    assert_eq!(
        entry.text.as_deref(),
        Some("`cat hello.txt`"),
        "the title from `tool_call` must survive the completion"
    );
    let tool = entry.tool.as_ref().expect("tool view");
    assert_eq!(tool.title, "`cat hello.txt`");
    assert_eq!(
        tool.command.as_deref(),
        Some("cat hello.txt"),
        "rawInput only rides on the start event"
    );
    assert_eq!(
        tool.result_preview.as_deref(),
        Some("hello from the acp spike\n")
    );
}

#[test]
fn standard_acp_tool_content_is_read_not_just_cursors_raw_output() {
    // `rawOutput` is a Cursor extension; the portable shape is a `content`
    // array. A generic ACP bridge has to understand the spec'd one.
    let entries = replay(&[
        json!({
            "sessionUpdate":"tool_call","toolCallId":"t1",
            "title":"Read file","kind":"read","status":"pending"
        }),
        json!({
            "sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed",
            "content":[{"type":"content","content":{"type":"text","text":"file body"}}]
        }),
    ]);
    let tool = entries[0].tool.as_ref().expect("tool view");
    assert_eq!(tool.result_preview.as_deref(), Some("file body"));
}

#[test]
fn listing_threads_caches_each_cwd_so_a_cold_session_can_be_loaded() {
    // `session/load` needs an absolute cwd. After a relay restart the session
    // map is empty, and the only place the cwd appears is the `session/list`
    // response — so listing has to seed the cache or every cold `read_thread` /
    // `resume_thread` sends `cwd: ""`.
    let mut sessions = std::collections::HashMap::new();
    let listed = vec![crate::acp::protocol::thread_summary(
        &json!({"sessionId":"s1","cwd":"/Users/luchi/git/agent-relay","title":"t1",
                    "updatedAt":"2026-08-11T16:39:48.293Z"}),
        "cursor",
        0,
    )
    .expect("thread")];

    crate::acp::absorb_thread_cwds(&mut sessions, &listed);

    assert_eq!(
        sessions.get("s1").map(|s| s.cwd.as_str()),
        Some("/Users/luchi/git/agent-relay")
    );
}

#[test]
fn caching_cwds_never_clobbers_a_live_session() {
    // A listing is a weaker source than the cwd the relay opened the session
    // with; it must fill gaps, not overwrite.
    let mut sessions = std::collections::HashMap::new();
    sessions.insert(
        "s1".to_string(),
        crate::acp::SessionRuntime {
            cwd: "/live/path".to_string(),
            approval_policy: "on-request".to_string(),
            ..Default::default()
        },
    );
    let listed = vec![crate::acp::protocol::thread_summary(
        &json!({"sessionId":"s1","cwd":"/stale/path"}),
        "cursor",
        0,
    )
    .expect("thread")];

    crate::acp::absorb_thread_cwds(&mut sessions, &listed);

    assert_eq!(sessions["s1"].cwd, "/live/path");
    assert_eq!(
        sessions["s1"].approval_policy, "on-request",
        "listing must not reset policy either"
    );
}

#[test]
fn a_blank_cwd_from_the_agent_is_not_cached_as_if_it_were_real() {
    let mut sessions = std::collections::HashMap::new();
    let listed =
        vec![
            crate::acp::protocol::thread_summary(&json!({"sessionId":"s1"}), "cursor", 0)
                .expect("thread"),
        ];
    crate::acp::absorb_thread_cwds(&mut sessions, &listed);
    assert!(
        sessions.get("s1").is_none_or(|s| s.cwd.is_empty()),
        "an empty cwd is absence, not a value"
    );
}

#[test]
fn auto_approve_grants_once_never_always() {
    // `allow_always` writes the grant into the AGENT's own allowlist, where the
    // relay can no longer see or revoke it — a `bypass` thread would silently
    // widen Cursor's standing permissions beyond that thread and beyond the
    // relay's lifetime. `allow_once` keeps every call round-tripping, so the
    // relay stays the policy authority.
    let options = vec![
        json!({"optionId":"allow-once","name":"Allow once","kind":"allow_once"}),
        json!({"optionId":"allow-always","name":"Allow always","kind":"allow_always"}),
        json!({"optionId":"reject-once","name":"Reject","kind":"reject_once"}),
    ];
    assert_eq!(
        crate::acp::rpc::auto_approve_option_id(&options).as_deref(),
        Some("allow-once")
    );

    // Superseded: this used to fall back to `allow_always` when no single-shot
    // option existed. See `auto_approve_cancels_rather_than_granting_a_permanent_allowlist_entry`
    // for why that was wrong — the turn is cancelled instead, not deadlocked.
    let only_always = vec![json!({"optionId":"allow-always","kind":"allow_always"})];
    assert_eq!(crate::acp::rpc::auto_approve_option_id(&only_always), None);

    // Nothing allowable at all: no option, so the caller cancels rather than
    // picking a reject and pretending it approved.
    let deny_only = vec![json!({"optionId":"reject-once","kind":"reject_once"})];
    assert_eq!(crate::acp::rpc::auto_approve_option_id(&deny_only), None);
}

#[test]
fn a_model_change_is_only_sent_when_it_actually_changes() {
    // `session/set_model` is session-level config, not a per-turn argument, so
    // the bridge has to track what the session is on. Re-sending it on every
    // turn would be a wasted round trip on the hot path; never sending it means
    // the relay reports a model the agent is not running.
    let mut runtime = SessionRuntime::default();
    let sonnet = "claude-sonnet-4-6[thinking=true,context=200k,effort=medium]";

    assert_eq!(
        runtime.model_change_needed(sonnet).as_deref(),
        Some(sonnet),
        "first selection must be pushed"
    );
    runtime.model = sonnet.to_string();
    assert_eq!(
        runtime.model_change_needed(sonnet),
        None,
        "same model must not re-send"
    );
    assert_eq!(
        runtime
            .model_change_needed("gpt-5.5[context=272k,reasoning=medium,fast=false]")
            .as_deref(),
        Some("gpt-5.5[context=272k,reasoning=medium,fast=false]")
    );
}

#[test]
fn an_empty_or_placeholder_model_never_overrides_the_sessions_own_default() {
    // The relay passes "" (and codex's literal "default") in paths that mean
    // "whatever the provider picks". Pushing those as a model id would be
    // rejected by the agent, or worse, silently accepted as a bogus model.
    let mut runtime = SessionRuntime::default();
    for placeholder in ["", "default"] {
        assert_eq!(
            runtime.model_change_needed(placeholder),
            None,
            "`{placeholder}` is not a model selection"
        );
    }
    runtime.model = "gpt-5.5[]".to_string();
    assert_eq!(runtime.model_change_needed(""), None);
    assert_eq!(
        runtime.model, "gpt-5.5[]",
        "a placeholder must not clear a real selection"
    );
}

#[test]
fn a_session_reset_is_refused_while_a_turn_is_in_flight() {
    // `read_thread`'s replay resets the shared per-session counters. Doing that
    // under a live turn makes the turn resume minting from `msg-1`, colliding
    // with the ids the replay just produced and overwriting settled entries —
    // which is worse than the lost deltas, because it corrupts history rather
    // than dropping the tail.
    let mut runtime = SessionRuntime {
        turn_id: Some("acp-turn-7".to_string()),
        ..Default::default()
    };
    runtime.next_item_id("msg");
    runtime.next_item_id("msg");

    assert!(
        !runtime.can_replay_into(),
        "a session with a live turn must not be reset for a replay"
    );

    runtime.turn_id = None;
    assert!(runtime.can_replay_into());

    runtime.reset_for_replay();
    assert_eq!(
        runtime.next_item_id("msg"),
        "acp-msg-1",
        "a replay renumbers from the start"
    );
}

#[test]
fn resetting_for_replay_keeps_the_session_identity_it_needs_afterwards() {
    // The reset is about transcript numbering only; losing cwd or policy would
    // break the next `session/load` and the approval gate.
    let mut runtime = SessionRuntime {
        cwd: "/repo".to_string(),
        approval_policy: "on-request".to_string(),
        model: "gpt-5.5[]".to_string(),
        ..Default::default()
    };
    runtime.next_item_id("tool");
    runtime
        .tool_items
        .insert("acp-id".to_string(), "acp-tool-1".to_string());

    runtime.reset_for_replay();

    assert_eq!(runtime.cwd, "/repo");
    assert_eq!(runtime.approval_policy, "on-request");
    assert_eq!(runtime.model, "gpt-5.5[]");
    assert!(runtime.tool_items.is_empty());
    assert!(runtime.tool_meta.is_empty());
}

#[test]
fn capabilities_are_read_from_the_handshake_not_assumed() {
    use crate::acp::protocol::AgentCapabilities;

    // Verbatim from the 2026-08-11 spike.
    let measured = json!({
        "protocolVersion": 1,
        "agentCapabilities": {
            "loadSession": true,
            "mcpCapabilities": {"http": true, "sse": true},
            "promptCapabilities": {"audio": false, "embeddedContext": false, "image": true},
            "sessionCapabilities": {"list": {}}
        }
    });
    let caps = AgentCapabilities::from_initialize(&measured);
    assert!(caps.load_session);
    // An empty object marks the capability present — treating it as falsy would
    // disable session listing against the one agent known to support it.
    assert!(caps.list_sessions);
    assert!(caps.prompt_images);

    // An agent that advertises nothing gets nothing enabled, rather than the
    // bridge assuming Cursor's answers.
    let bare = AgentCapabilities::from_initialize(&json!({"protocolVersion": 1}));
    assert_eq!(bare, AgentCapabilities::default());
    assert!(!bare.load_session && !bare.list_sessions && !bare.prompt_images);

    // Explicit false must win over presence.
    let denied = AgentCapabilities::from_initialize(&json!({
        "agentCapabilities": {"loadSession": false, "sessionCapabilities": {"list": false}}
    }));
    assert!(!denied.load_session);
    assert!(!denied.list_sessions);
}

#[test]
fn a_content_only_update_does_not_regress_a_completed_tool_to_pending() {
    // ACP allows every field except `toolCallId` to be omitted from a
    // `tool_call_update`. Recomputing status from each payload alone turns an
    // absent status into "pending", so a trailing content-only update marks a
    // finished tool as still running.
    let entries = replay(&[
        json!({"sessionUpdate":"tool_call","toolCallId":"t1","title":"`nl hello.txt`",
               "kind":"execute","status":"pending","rawInput":{"command":"nl hello.txt"}}),
        json!({"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed",
               "rawOutput":{"exitCode":0,"stdout":"1 hi\n","stderr":""}}),
        // Content-only: no status, no title, no input.
        json!({"sessionUpdate":"tool_call_update","toolCallId":"t1",
               "content":[{"type":"content","content":{"type":"text","text":"1 hi"}}]}),
    ]);

    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(
        entry.status, "completed",
        "status must not fall back to pending"
    );
    assert_eq!(entry.text.as_deref(), Some("`nl hello.txt`"));
    let tool = entry.tool.as_ref().expect("tool view");
    assert_eq!(tool.command.as_deref(), Some("nl hello.txt"));
    assert!(tool.result_preview.is_some());
}

#[test]
fn an_agent_mode_change_is_tracked_so_a_thread_cannot_silently_leave_plan() {
    // ACP lets the AGENT change mode and announce it with `current_mode_update`.
    // Ignoring it means a thread the relay believes is read-only may already be
    // back in `agent` mode.
    let mut runtime = session();
    let op = plan_update(
        &json!({"sessionUpdate":"current_mode_update","currentModeId":"agent"}),
        &mut runtime,
    );
    assert_eq!(op, TranscriptOp::ModeChanged("agent".to_string()));

    let ignored = plan_update(
        &json!({"sessionUpdate":"current_mode_update"}),
        &mut runtime,
    );
    assert_eq!(ignored, TranscriptOp::Ignore);
}

// ---------------------------------------------------------------------------
// Model catalog cache — ACP reports models only on `session/new`, so the first
// session of a fresh process would otherwise face an empty picker.
// ---------------------------------------------------------------------------

#[test]
fn a_cached_catalog_survives_a_restart_so_the_picker_is_not_empty() {
    use crate::acp::{read_cached_models, write_cached_models};

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("acp-models-cursor.json");

    // Nothing cached yet: the very first run of a fresh install.
    assert!(read_cached_models(&path).is_empty());

    let harvested = crate::acp::protocol::model_options(
        &[
            json!({"modelId":"default[]","name":"Auto"}),
            json!({"modelId":"claude-sonnet-4-6[thinking=true]","name":"claude-sonnet-4-6"}),
        ],
        Some("default[]"),
        "cursor",
    );
    write_cached_models(&path, &harvested);

    let restored = read_cached_models(&path);
    assert_eq!(restored.len(), 2);
    // The bracketed id is what `session/set_model` needs back, so it has to
    // survive the round trip byte for byte.
    assert_eq!(restored[1].model, "claude-sonnet-4-6[thinking=true]");
    assert_eq!(restored[1].provider, "cursor");
    assert_eq!(
        restored[1].supported_reasoning_efforts,
        Vec::<String>::new()
    );
    assert!(restored[0].is_default);
}

#[test]
fn a_corrupt_or_unreadable_cache_is_absence_not_an_error() {
    use crate::acp::read_cached_models;

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("acp-models-cursor.json");
    std::fs::write(&path, "{ this is not json").expect("write");
    // A stale cache must never block startup — it degrades to "not harvested
    // yet", which is exactly the pre-cache behaviour.
    assert!(read_cached_models(&path).is_empty());
}

// ---------------------------------------------------------------------------
// Transport lifecycle, driven over `tokio::io::duplex`. These are the paths a
// live agent cannot be asked to produce on cue: a failed write and a dead
// stream, both of which can strand a turn.
// ---------------------------------------------------------------------------

use tokio::sync::{watch, RwLock};

use crate::acp::AcpBridge;
use crate::state::{RelayState, SecurityProfile};

fn relay_state() -> std::sync::Arc<RwLock<RelayState>> {
    let (change_tx, _) = watch::channel(0_u64);
    std::sync::Arc::new(RwLock::new(RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )))
}

#[tokio::test]
async fn a_failed_prompt_write_leaves_no_thread_stuck_working() {
    let state = relay_state();
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("t1".to_string());
    }

    // Outbound half whose peer is dropped: every write fails.
    let (outbound, peer) = tokio::io::duplex(64);
    drop(peer);
    let (_inbound_writer, inbound) = tokio::io::duplex(64);

    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");
    bridge.seed_session_for_test("t1", "/tmp/project").await;

    let sent =
        crate::provider::ProviderBridge::start_turn(&bridge, "t1", "hello", "", "", &[]).await;
    assert!(sent.is_err(), "a dead pipe must surface as a failed send");

    assert_eq!(
        bridge.session_turn_for_test("t1").await,
        None,
        "the session must not still own a turn the agent never received"
    );

    let relay = state.read().await;
    assert_ne!(
        relay.current_status, "working",
        "a thread cannot be left working on a turn that was never sent — no \
         event is coming to settle it"
    );
}

#[tokio::test]
async fn a_dead_stream_fails_in_flight_requests_instead_of_hanging_them() {
    let state = relay_state();

    let (outbound, mut outbound_peer) = tokio::io::duplex(4096);
    let (inbound_writer, inbound) = tokio::io::duplex(4096);

    let bridge = std::sync::Arc::new(AcpBridge::for_test(
        state.clone(),
        outbound,
        inbound,
        "cursor",
    ));

    // Fire a request that nobody will ever answer.
    let pending = {
        let bridge = bridge.clone();
        tokio::spawn(async move { bridge.send_request("session/list", json!({})).await })
    };

    // Wait until it is actually on the wire, so the drop below races nothing.
    let mut buffer = vec![0_u8; 512];
    tokio::io::AsyncReadExt::read(&mut outbound_peer, &mut buffer)
        .await
        .expect("request should reach the peer");

    // The agent dies.
    drop(inbound_writer);

    // Without draining `pending_responses` on EOF this would sit for the full
    // 60s request timeout (and an hour for a prompt) on a process that is gone.
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), pending)
        .await
        .expect("the request must not outlive the stream")
        .expect("task panicked");
    let error = outcome.expect_err("a dead stream cannot produce a result");
    assert!(
        error.contains("closed") || error.contains("failed"),
        "unhelpful error for a dead stream: {error}"
    );
}

#[tokio::test]
async fn reading_a_thread_mid_turn_serves_the_relay_and_never_touches_the_wire() {
    let state = relay_state();
    {
        let mut relay = state.write().await;
        relay.active_thread_id = Some("t1".to_string());
        let runtime = relay.ensure_runtime_for_thread("t1");
        runtime.current_cwd = "/tmp/project".to_string();
        runtime.active_turn_id = Some("acp-turn-1".to_string());
        runtime.current_status = "working".to_string();
    }
    {
        let mut relay = state.write().await;
        relay.upsert_user_message_for_thread(
            "t1",
            "acp-user-1".to_string(),
            "hi".to_string(),
            "acp-turn-1".to_string(),
        );
    }

    let (outbound, mut outbound_peer) = tokio::io::duplex(4096);
    let (_inbound_writer, inbound) = tokio::io::duplex(4096);
    let bridge = AcpBridge::for_test(state.clone(), outbound, inbound, "cursor");
    bridge.seed_session_for_test("t1", "/tmp/project").await;

    let data = crate::provider::ProviderBridge::read_thread(&bridge, "t1")
        .await
        .expect("a thread with a live turn is readable");

    assert_eq!(data.transcript.len(), 1);
    assert_eq!(data.transcript[0].item_id.as_deref(), Some("acp-user-1"));
    assert_eq!(data.thread.cwd, "/tmp/project");

    // Nothing was written: no `session/load`, so no replay to swallow the live
    // turn's updates and no reset to renumber its items.
    let mut buffer = vec![0_u8; 256];
    let quiet = tokio::time::timeout(
        std::time::Duration::from_millis(200),
        tokio::io::AsyncReadExt::read(&mut outbound_peer, &mut buffer),
    )
    .await;
    assert!(
        quiet.is_err(),
        "read_thread must not issue a session/load while a turn is streaming"
    );
}

#[test]
fn an_approval_recovers_the_command_from_the_tool_call_that_preceded_it() {
    // Measured: `session/request_permission`'s `toolCall` carries a title and a
    // status but NO `rawInput` — the command only ever arrives on the earlier
    // `tool_call` update. Reading it off the request alone leaves the approval
    // card with nothing to show but a title, which is the one thing a user needs
    // to see before allowing a shell command to run.
    let mut runtime = session();
    plan_update(
        &json!({
            "sessionUpdate":"tool_call","toolCallId":"call-7","title":"`nl -ba note.txt`",
            "kind":"execute","status":"pending","rawInput":{"command":"nl -ba note.txt"}
        }),
        &mut runtime,
    );

    assert_eq!(
        crate::acp::rpc::command_for_tool_call(&runtime, "call-7").as_deref(),
        Some("nl -ba note.txt")
    );
    // A tool the relay never saw start has nothing to recover, and must not
    // invent one.
    assert_eq!(
        crate::acp::rpc::command_for_tool_call(&runtime, "unknown"),
        None
    );
}

// ---------------------------------------------------------------------------
// Round-3 review: read-only mode drift, capture leaks, approval fallback,
// and catalog defaults.
// ---------------------------------------------------------------------------

#[test]
fn a_mode_update_is_read_under_either_spelling() {
    // The ACP spec names the field `modeId`; Cursor sends `currentModeId`.
    // A bridge that claims to be generic has to accept both, and reading only
    // the measured one means a spec-compliant agent's mode change is invisible.
    for field in ["modeId", "currentModeId"] {
        let mut runtime = session();
        let op = plan_update(
            &json!({"sessionUpdate":"current_mode_update", field: "agent"}),
            &mut runtime,
        );
        assert_eq!(
            op,
            TranscriptOp::ModeChanged("agent".to_string()),
            "`{field}` must be understood"
        );
    }
}

#[test]
fn leaving_the_required_mode_is_drift_that_must_be_repaired() {
    // ACP lets the agent change its own mode. A thread the relay put in `plan`
    // for a read-only review can therefore be moved back to full `agent` by the
    // agent itself — the relay has to notice, not just narrate.
    let mut runtime = SessionRuntime {
        required_mode: Some("plan"),
        mode: "plan".to_string(),
        ..Default::default()
    };
    assert_eq!(runtime.mode_drift(), None);

    runtime.mode = "agent".to_string();
    assert_eq!(
        runtime.mode_drift(),
        Some("plan"),
        "a read-only thread that left plan must report the mode to restore"
    );

    // A thread with no read-only requirement may sit in any mode.
    let free = SessionRuntime {
        required_mode: None,
        mode: "plan".to_string(),
        ..Default::default()
    };
    assert_eq!(free.mode_drift(), None);
}

#[test]
fn auto_approve_cancels_rather_than_granting_a_permanent_allowlist_entry() {
    // Supersedes the round-2 fallback. The premise there — that `allow_always`
    // beats deadlocking the turn — was wrong: returning nothing makes the caller
    // answer `cancelled`, which ends the turn cleanly. A no-prompt policy must
    // never be the thing that writes a user-global, on-disk grant.
    let only_always = vec![json!({"optionId":"allow-always","kind":"allow_always"})];
    assert_eq!(
        crate::acp::rpc::auto_approve_option_id(&only_always),
        None,
        "a broad grant is worse than a cancelled turn"
    );

    let with_once = vec![
        json!({"optionId":"allow-once","kind":"allow_once"}),
        json!({"optionId":"allow-always","kind":"allow_always"}),
    ];
    assert_eq!(
        crate::acp::rpc::auto_approve_option_id(&with_once).as_deref(),
        Some("allow-once")
    );
}

#[test]
fn only_a_new_session_defines_the_providers_default_model() {
    use crate::acp::protocol::model_options;

    let available = vec![
        json!({"modelId":"default[]","name":"Auto"}),
        json!({"modelId":"claude-sonnet-4-6[thinking=true]","name":"claude-sonnet-4-6"}),
    ];

    // `session/new` reports the model a FRESH session starts on — that is the
    // provider's default.
    let fresh = model_options(&available, Some("default[]"), "cursor");
    assert!(fresh[0].is_default);
    assert!(!fresh[1].is_default);

    // `session/load` reports the model THAT session happens to use. Treating it
    // as the provider default means opening an old Sonnet thread silently makes
    // every future new session start on Sonnet.
    let loaded = model_options(&available, None, "cursor");
    assert!(
        loaded.iter().all(|option| !option.is_default),
        "a loaded session's model must not be marketed as the provider default"
    );
}

#[tokio::test]
async fn an_aborted_read_does_not_leave_a_capture_swallowing_live_updates() {
    // `read_thread` installs a capture, awaits `session/load`, then removes it.
    // If the future is dropped mid-await — a client disconnect, an aborted task —
    // the manual cleanup never runs and the capture stays installed forever.
    // Every later `session/update` for that session is then diverted into a
    // buffer nobody reads: a permanent transcript blackhole.
    let state = relay_state();

    let (outbound, _outbound_peer) = tokio::io::duplex(4096);
    // Nothing ever answers the load, so the read parks until it is aborted.
    let (inbound_writer, inbound) = tokio::io::duplex(4096);

    let bridge = std::sync::Arc::new(AcpBridge::for_test(
        state.clone(),
        outbound,
        inbound,
        "cursor",
    ));
    bridge.seed_session_for_test("t1", "/tmp/project").await;
    bridge.allow_session_load_for_test().await;

    let reading = {
        let bridge = bridge.clone();
        tokio::spawn(async move {
            let _ = crate::provider::ProviderBridge::read_thread(&*bridge, "t1").await;
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    reading.abort();
    let _ = reading.await;

    assert!(
        !bridge.has_capture_for_test("t1").await,
        "an aborted read must not leave its capture installed"
    );

    // And the proof that it matters: a live update now reaches RelayState.
    let update = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "t1",
            "update": {"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"alive"}}
        }
    }))
    .unwrap();
    {
        let mut writer = inbound_writer;
        tokio::io::AsyncWriteExt::write_all(&mut writer, format!("{update}\n").as_bytes())
            .await
            .expect("write update");
        tokio::io::AsyncWriteExt::flush(&mut writer)
            .await
            .expect("flush");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let relay = state.read().await;
        let entries = relay
            .runtime_for_thread("t1")
            .map(|runtime| runtime.transcript_views())
            .unwrap_or_default();
        assert!(
            entries
                .iter()
                .any(|entry| entry.text.as_deref() == Some("alive")),
            "a delta after an aborted read must reach the transcript, not a dead buffer"
        );
    }
}
