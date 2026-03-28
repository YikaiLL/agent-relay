use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::json;
use std::{env, path::PathBuf};
use tokio::sync::watch;

use crate::{
    codex::ThreadSyncData,
    protocol::{LogEntryView, ThreadSummaryView, TranscriptEntryView},
};

use super::{
    persistence::{PersistedRelayState, PersistenceStore},
    *,
};

fn test_persisted_state() -> PersistedRelayState {
    let mut paired_devices = std::collections::HashMap::new();
    paired_devices.insert(
        "phone-1".to_string(),
        PairedDevice {
            device_id: "phone-1".to_string(),
            label: "Primary Phone".to_string(),
            shared_secret: "shared-secret".to_string(),
            token_hash: "token-hash".to_string(),
            device_verify_key: None,
            created_at: 7,
            last_seen_at: Some(9),
            last_peer_id: Some("surface-1".to_string()),
        },
    );
    PersistedRelayState {
        schema_version: PERSISTED_STATE_VERSION,
        active_thread_id: Some("thread-1".to_string()),
        active_controller_device_id: Some("device-a".to_string()),
        active_controller_last_seen_at: Some(123),
        current_status: "running".to_string(),
        active_flags: vec!["busy".to_string()],
        current_cwd: "/tmp/project".to_string(),
        model: DEFAULT_MODEL.to_string(),
        approval_policy: DEFAULT_APPROVAL_POLICY.to_string(),
        sandbox: DEFAULT_SANDBOX.to_string(),
        reasoning_effort: DEFAULT_EFFORT.to_string(),
        paired_devices,
        transcript: vec![TranscriptRecord {
            item_id: "history-0".to_string(),
            role: "assistant".to_string(),
            text: "hello".to_string(),
            status: "completed".to_string(),
            turn_id: Some("turn-1".to_string()),
        }],
        logs: vec![LogEntryView {
            kind: "info".to_string(),
            message: "persisted".to_string(),
            created_at: 1,
        }],
    }
}

fn test_state() -> RelayState {
    let (change_tx, _) = watch::channel(0_u64);
    RelayState::new(
        "/tmp/project".to_string(),
        change_tx,
        SecurityProfile::private(),
    )
}

fn test_broker_config(
    broker_url: &str,
    channel_id: &str,
    peer_id: &str,
) -> crate::broker::BrokerConfig {
    crate::broker::BrokerConfig::from_parts(
        Some(broker_url.to_string()),
        None,
        Some(channel_id.to_string()),
        Some(peer_id.to_string()),
        None,
        Some("test-broker-ticket-secret".to_string()),
        None,
        None,
    )
    .expect("broker config should parse")
    .expect("broker config should be enabled")
}

fn issue_test_pairing_ticket(
    relay: &mut RelayState,
    broker_url: &str,
    channel_id: &str,
    peer_id: &str,
    expires_in_seconds: Option<u64>,
) -> crate::protocol::PairingTicketView {
    let broker = test_broker_config(broker_url, channel_id, peer_id);
    relay
        .issue_pairing_ticket(&broker, expires_in_seconds)
        .expect("pairing ticket should issue")
}

fn test_thread(id: &str, cwd: &str) -> ThreadSummaryView {
    ThreadSummaryView {
        id: id.to_string(),
        name: Some("Test Thread".to_string()),
        preview: "Test preview".to_string(),
        cwd: cwd.to_string(),
        updated_at: 1,
        source: "codex".to_string(),
        status: "idle".to_string(),
        model_provider: "openai".to_string(),
    }
}

fn test_pending_approval(thread_id: &str) -> PendingApproval {
    PendingApproval {
        request_id: "req-1".to_string(),
        raw_request_id: json!(1),
        kind: ApprovalKind::Command,
        thread_id: thread_id.to_string(),
        summary: "Need approval".to_string(),
        detail: Some("Test command".to_string()),
        command: Some("ls".to_string()),
        cwd: Some("/tmp/project".to_string()),
        requested_permissions: None,
        available_decisions: vec!["approve".to_string(), "deny".to_string()],
        supports_session_scope: true,
    }
}

#[test]
fn activate_thread_sets_active_controller_on_start() {
    let mut relay = test_state();

    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );

    assert_eq!(relay.active_thread_id.as_deref(), Some("thread-1"));
    assert_eq!(
        relay.active_controller_device_id.as_deref(),
        Some("device-a")
    );
    assert!(relay.can_device_send_message("device-a"));
    assert!(!relay.can_device_send_message("device-b"));
}

#[test]
fn snapshot_exposes_private_security_mode_defaults() {
    let relay = test_state();
    let snapshot = relay.snapshot();

    assert_eq!(
        snapshot.security_mode,
        crate::protocol::SecurityMode::Private
    );
    assert!(!snapshot.broker_connected);
    assert_eq!(snapshot.broker_channel_id, None);
    assert_eq!(snapshot.broker_peer_id, None);
    assert!(snapshot.e2ee_enabled);
    assert!(!snapshot.broker_can_read_content);
    assert!(!snapshot.audit_enabled);
    assert!(snapshot.paired_devices.is_empty());
}

#[test]
fn passive_device_cannot_send_message_until_takeover() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );

    let error = relay
        .ensure_device_can_send_message("device-b")
        .expect_err("passive device should be blocked from sending");

    assert!(error.contains("another device currently has control"));

    assert!(relay.set_active_controller("device-b"));
    assert_eq!(
        relay.active_controller_device_id.as_deref(),
        Some("device-b")
    );
    assert!(relay.ensure_device_can_send_message("device-b").is_ok());
}

#[test]
fn approval_is_allowed_from_passive_owner_device() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    relay
        .pending_approvals
        .insert("req-1".to_string(), test_pending_approval("thread-1"));

    assert!(relay.can_device_approve("device-a"));
    assert!(relay.can_device_approve("device-b"));
    assert!(relay.ensure_device_can_approve("device-b").is_ok());
    assert!(!relay.can_device_send_message("device-b"));
}

#[test]
fn load_thread_data_sets_active_controller_on_resume() {
    let mut relay = test_state();
    relay.load_thread_data(
        ThreadSyncData {
            thread: test_thread("thread-9", "/tmp/project"),
            status: "running".to_string(),
            active_flags: vec!["busy".to_string()],
            transcript: Vec::new(),
        },
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "phone-device",
    );

    assert_eq!(relay.active_thread_id.as_deref(), Some("thread-9"));
    assert_eq!(
        relay.active_controller_device_id.as_deref(),
        Some("phone-device")
    );
    assert_eq!(relay.current_status, "running");
}

#[test]
fn stale_controller_lease_expires_and_releases_session() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    relay.active_controller_last_seen_at = Some(100);

    let expired = relay.expire_stale_controller(100 + CONTROLLER_LEASE_SECS);

    assert_eq!(expired.as_deref(), Some("device-a"));
    assert_eq!(relay.active_controller_device_id, None);
    assert_eq!(relay.active_controller_last_seen_at, None);
    assert!(relay.can_device_send_message("device-b"));
}

#[test]
fn active_controller_heartbeat_extends_lease() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    relay.active_controller_last_seen_at = Some(100);

    assert!(relay.refresh_controller_lease("device-a", 112));
    assert_eq!(
        relay.controller_lease_expires_at(),
        Some(112 + CONTROLLER_LEASE_SECS)
    );
    assert_eq!(
        relay.expire_stale_controller(100 + CONTROLLER_LEASE_SECS),
        None
    );
    assert_eq!(
        relay.active_controller_device_id.as_deref(),
        Some("device-a")
    );
}

#[test]
fn normalize_cwd_expands_home_directory() {
    let home = env::var("HOME").expect("HOME should be set for tests");
    let normalized = normalize_cwd("~/git/agent-relay");

    assert_eq!(
        normalized,
        PathBuf::from(home)
            .join("git/agent-relay")
            .display()
            .to_string()
    );
}

#[test]
fn filter_threads_matches_tilde_scoped_workspace() {
    let home = env::var("HOME").expect("HOME should be set for tests");
    let project_root = PathBuf::from(home).join("git/agent-relay");
    let nested_root = project_root.join("crates/relay-server");

    let threads = vec![
        test_thread("thread-1", &project_root.display().to_string()),
        test_thread("thread-2", &nested_root.display().to_string()),
        test_thread("thread-3", "/tmp/other-project"),
    ];

    let filtered = filter_threads(threads, Some("~/git/agent-relay"), 20);

    assert_eq!(filtered.len(), 2);
    assert_eq!(filtered[0].id, "thread-1");
    assert_eq!(filtered[1].id, "thread-2");
}

#[test]
fn passive_device_cannot_refresh_another_devices_lease() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    relay.active_controller_last_seen_at = Some(100);

    assert!(!relay.refresh_controller_lease("device-b", 112));
    assert_eq!(relay.active_controller_last_seen_at, Some(100));
    assert_eq!(
        relay.active_controller_device_id.as_deref(),
        Some("device-a")
    );
}

#[test]
fn require_device_id_rejects_empty_values() {
    assert_eq!(
        require_device_id(Some("   ".to_string())).unwrap_err(),
        "device_id is required"
    );
    assert_eq!(
        require_device_id(None).unwrap_err(),
        "device_id is required"
    );
    assert_eq!(
        require_device_id(Some("device-a".to_string())).unwrap(),
        "device-a"
    );
}

#[test]
fn persisted_state_round_trip_drops_ephemeral_fields() {
    let mut relay = test_state();
    relay.activate_thread(
        test_thread("thread-1", "/tmp/project"),
        "/tmp/project",
        DEFAULT_MODEL,
        DEFAULT_APPROVAL_POLICY,
        DEFAULT_SANDBOX,
        DEFAULT_EFFORT,
        "device-a",
    );
    relay.active_controller_last_seen_at = Some(99);
    relay.active_turn_id = Some("turn-ephemeral".to_string());
    relay.transcript.push(TranscriptRecord {
        item_id: "history-0".to_string(),
        role: "assistant".to_string(),
        text: "hello".to_string(),
        status: "completed".to_string(),
        turn_id: Some("turn-1".to_string()),
    });
    relay
        .pending_approvals
        .insert("req-1".to_string(), test_pending_approval("thread-1"));

    let persisted = PersistedRelayState::from_relay(&relay);
    let (change_tx, _) = watch::channel(0_u64);
    let mut restored = RelayState::new(
        "/tmp/other".to_string(),
        change_tx,
        SecurityProfile::private(),
    );
    restored.apply_persisted(&persisted);

    assert_eq!(restored.active_thread_id.as_deref(), Some("thread-1"));
    assert_eq!(
        restored.active_controller_device_id.as_deref(),
        Some("device-a")
    );
    assert_eq!(restored.active_controller_last_seen_at, Some(99));
    assert_eq!(restored.active_turn_id, None);
    assert_eq!(restored.pending_approvals.len(), 0);
    assert_eq!(restored.paired_devices.len(), 0);
    assert_eq!(restored.transcript.len(), 1);
    assert_eq!(restored.logs.len(), persisted.logs.len());
    assert_eq!(restored.logs[0].message, persisted.logs[0].message);
}

#[test]
fn restore_thread_data_keeps_persisted_controller_and_settings() {
    let mut relay = test_state();
    relay
        .pending_approvals
        .insert("req-1".to_string(), test_pending_approval("thread-1"));

    let persisted = test_persisted_state();
    relay.restore_thread_data(
        ThreadSyncData {
            thread: test_thread("thread-1", "/tmp/project"),
            status: "running".to_string(),
            active_flags: vec!["busy".to_string()],
            transcript: vec![TranscriptEntryView {
                role: "user".to_string(),
                text: "ping".to_string(),
                status: "completed".to_string(),
                turn_id: Some("turn-2".to_string()),
            }],
        },
        &persisted,
    );

    assert_eq!(relay.active_thread_id.as_deref(), Some("thread-1"));
    assert_eq!(
        relay.active_controller_device_id.as_deref(),
        Some("device-a")
    );
    assert_eq!(relay.active_controller_last_seen_at, Some(123));
    assert_eq!(relay.model, DEFAULT_MODEL);
    assert_eq!(relay.approval_policy, DEFAULT_APPROVAL_POLICY);
    assert_eq!(relay.sandbox, DEFAULT_SANDBOX);
    assert_eq!(relay.reasoning_effort, DEFAULT_EFFORT);
    assert_eq!(relay.paired_devices.len(), 1);
    assert_eq!(relay.pending_approvals.len(), 0);
    assert_eq!(relay.transcript.len(), 1);
    assert_eq!(relay.transcript[0].text, "ping");
}

#[test]
fn pairing_ticket_registers_and_authenticates_remote_device() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    let (device, token) = relay
        .consume_pairing_ticket(
            &ticket.pairing_id,
            &ticket.pairing_secret,
            Some("My Phone".to_string()),
            Some("Primary Phone".to_string()),
            None,
            "surface-a",
            100,
        )
        .expect("pairing should succeed");

    assert_eq!(device.device_id, "my-phone");
    assert_eq!(device.label, "Primary Phone");
    assert_eq!(relay.pending_pairings.len(), 0);
    assert_eq!(relay.paired_devices.len(), 1);

    let authenticated = relay
        .authenticate_paired_device(&device.device_id, &token, "surface-b", 101)
        .expect("device token should authenticate");
    assert_eq!(authenticated, "my-phone");
    assert_eq!(
        relay
            .paired_devices
            .get("my-phone")
            .and_then(|device| device.last_peer_id.as_deref()),
        Some("surface-b")
    );
}

#[test]
fn pairing_ticket_includes_scannable_broker_link() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "wss://relay.example.com",
        "room-a",
        "relay-a",
        Some(60),
    );

    assert!(ticket
        .pairing_url
        .starts_with("https://relay.example.com/?pairing="));
    assert!(ticket.pairing_qr_svg.contains("<svg"));

    let encoded = ticket
        .pairing_url
        .split("pairing=")
        .nth(1)
        .expect("pairing url should include pairing param");
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .expect("pairing payload should decode");
    let payload: serde_json::Value =
        serde_json::from_slice(&decoded).expect("pairing payload should be valid json");

    assert_eq!(payload["pairing_id"], ticket.pairing_id);
    assert_eq!(payload["pairing_secret"], ticket.pairing_secret);
    assert_eq!(payload["broker_url"], "wss://relay.example.com");
    assert_eq!(payload["pairing_join_ticket"], ticket.pairing_join_ticket);
}

#[test]
fn pairing_rejects_invalid_secret_and_bad_device_token() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    let error = relay
        .consume_pairing_ticket(
            &ticket.pairing_id,
            "wrong-secret",
            Some("phone-2".to_string()),
            None,
            None,
            "surface-a",
            100,
        )
        .expect_err("invalid pairing secret should fail");
    assert!(error.contains("invalid"));

    let replacement = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );
    let (device, token) = relay
        .consume_pairing_ticket(
            &replacement.pairing_id,
            &replacement.pairing_secret,
            Some("phone-2".to_string()),
            None,
            None,
            "surface-a",
            100,
        )
        .expect("replacement ticket should pair");
    let auth_error = relay
        .authenticate_paired_device(&device.device_id, "bad-token", "surface-a", 101)
        .expect_err("bad device token should fail");
    assert!(auth_error.contains("invalid"));
    assert_ne!(token, "bad-token");
}

#[test]
fn revoking_paired_device_removes_it() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );
    let (device, _token) = relay
        .consume_pairing_ticket(
            &ticket.pairing_id,
            &ticket.pairing_secret,
            Some("tablet".to_string()),
            Some("Tablet".to_string()),
            None,
            "surface-tablet",
            100,
        )
        .expect("pairing should succeed");

    assert!(relay.revoke_paired_device(&device.device_id));
    assert!(!relay.revoke_paired_device(&device.device_id));
    assert!(relay.paired_devices.is_empty());
}

#[tokio::test]
async fn persistence_store_round_trips_to_disk() {
    let unique = format!("agent-relay-test-{}-{}", std::process::id(), unix_now());
    let directory = std::env::temp_dir().join(unique);
    let path = directory.join("session.json");
    let store = PersistenceStore::from_path(path);
    let persisted = test_persisted_state();

    store.save(&persisted).await.expect("state should save");
    let loaded = store
        .load()
        .await
        .expect("state should load")
        .expect("state should exist");

    assert_eq!(loaded.active_thread_id, persisted.active_thread_id);
    assert_eq!(
        loaded.active_controller_device_id,
        persisted.active_controller_device_id
    );
    assert_eq!(loaded.transcript.len(), 1);

    tokio::fs::remove_dir_all(&directory)
        .await
        .expect("temp persisted state directory should be removable");
}

#[test]
fn pairing_request_waits_for_local_approval_before_device_is_created() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    let request = relay
        .register_pairing_request(
            &ticket.pairing_id,
            Some("phone-approve".to_string()),
            Some("Approve Phone".to_string()),
            "surface-a",
            "verify-key-1".to_string(),
            100,
        )
        .expect("pairing request should register");

    assert_eq!(request.device_id, "phone-approve");
    assert_eq!(relay.paired_devices.len(), 0);
    assert_eq!(relay.pending_pairing_requests.len(), 1);

    let result = relay
        .decide_pairing_request(&ticket.pairing_id, true, 101)
        .expect("approval should complete pairing");

    assert_eq!(relay.pending_pairing_requests.len(), 0);
    assert_eq!(relay.pending_pairings.len(), 0);
    assert_eq!(relay.paired_devices.len(), 1);
    assert_eq!(result.target_peer_id, "surface-a");
    assert!(result.device_token.is_some());
    assert_eq!(
        result
            .device
            .as_ref()
            .map(|device| device.device_id.as_str()),
        Some("phone-approve")
    );
}

#[test]
fn rejecting_pairing_request_returns_error_without_creating_device() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    relay
        .register_pairing_request(
            &ticket.pairing_id,
            Some("phone-reject".to_string()),
            Some("Reject Phone".to_string()),
            "surface-b",
            "verify-key-2".to_string(),
            100,
        )
        .expect("pairing request should register");

    let result = relay
        .decide_pairing_request(&ticket.pairing_id, false, 101)
        .expect("rejection should succeed");

    assert_eq!(relay.pending_pairing_requests.len(), 0);
    assert_eq!(relay.pending_pairings.len(), 0);
    assert!(relay.paired_devices.is_empty());
    assert!(result.device.is_none());
    assert!(result.device_token.is_none());
    assert_eq!(
        result.error.as_deref(),
        Some("pairing request was rejected on the local relay")
    );
}

#[test]
fn repeated_pairing_request_rebinds_to_latest_broker_peer() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    relay
        .register_pairing_request(
            &ticket.pairing_id,
            Some("phone-rebind".to_string()),
            Some("Rebind Phone".to_string()),
            "surface-old",
            "verify-key-3".to_string(),
            100,
        )
        .expect("initial pairing request should register");

    let rebound = relay
        .register_pairing_request(
            &ticket.pairing_id,
            Some("phone-rebind".to_string()),
            Some("Rebind Phone".to_string()),
            "surface-new",
            "verify-key-3".to_string(),
            101,
        )
        .expect("retry should rebind to the latest broker peer");

    assert_eq!(rebound.broker_peer_id, "surface-new");

    let result = relay
        .decide_pairing_request(&ticket.pairing_id, true, 102)
        .expect("approval should use the rebound broker peer");
    assert_eq!(result.target_peer_id, "surface-new");
}

#[test]
fn completed_pairing_can_replay_result_to_reconnected_peer() {
    let mut relay = test_state();
    let ticket = issue_test_pairing_ticket(
        &mut relay,
        "ws://127.0.0.1:8789",
        "room-a",
        "relay-a",
        Some(60),
    );

    relay
        .register_pairing_request(
            &ticket.pairing_id,
            Some("phone-replay".to_string()),
            Some("Replay Phone".to_string()),
            "surface-a",
            "verify-key-4".to_string(),
            100,
        )
        .expect("pairing request should register");
    relay
        .decide_pairing_request(&ticket.pairing_id, true, 101)
        .expect("approval should complete pairing");

    let replay = relay
        .completed_pairing_result(&ticket.pairing_id, "verify-key-4", "surface-b", 102)
        .expect("completed pairing lookup should succeed")
        .expect("completed pairing should be replayable");

    assert_eq!(replay.target_peer_id, "surface-b");
    assert_eq!(
        replay
            .device
            .as_ref()
            .map(|device| device.device_id.as_str()),
        Some("phone-replay")
    );
    assert!(replay.device_token.is_some());
}
