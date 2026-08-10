use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::*;
use crate::protocol::{
    SendMessageInput, ThreadTranscriptResponse, TranscriptEntryKind, TranscriptEntryView,
};
use crate::state::{
    AppState, PendingTranscriptDelta, RelayState, SecurityProfile, TranscriptDeltaKind,
};
use axum::{extract::Path, routing::post, Json, Router};
use base64::engine::general_purpose::STANDARD;
use ed25519_dalek::{Signer, SigningKey, Verifier};
use rand::{rngs::StdRng, SeedableRng};
use relay_broker::public_control::{
    ClientGrantRequest, ClientGrantResponse, DeviceGrantBulkRevokeRequest,
    DeviceGrantBulkRevokeResponse, DeviceGrantRequest, DeviceGrantResponse,
    DeviceGrantRevokeRequest, DeviceGrantRevokeResponse, PairingWsTokenRequest,
    PairingWsTokenResponse, RelayEnrollmentChallengeRequest, RelayEnrollmentChallengeResponse,
    RelayEnrollmentCompleteRequest, RelayEnrollmentResponse, RelayWsTokenRequest,
    RelayWsTokenResponse,
};
use tokio::time::Instant;
use tokio::{
    net::TcpListener,
    sync::{watch, RwLock},
};

use super::session_claim::{decode_and_verify_session_claim, unix_now};

fn temp_registration_path(prefix: &str) -> String {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be monotonic enough for tests")
        .as_nanos();
    std::env::temp_dir()
        .join(format!("{prefix}-{unique}.json"))
        .display()
        .to_string()
}

async fn spawn_public_control_mock() -> String {
    async fn relay_enrollment_challenge(
        Json(request): Json<RelayEnrollmentChallengeRequest>,
    ) -> Json<RelayEnrollmentChallengeResponse> {
        Json(RelayEnrollmentChallengeResponse {
            relay_verify_key: request.relay_verify_key,
            challenge_id: "rch-1".to_string(),
            challenge: "rc-1".to_string(),
            expires_at: unix_now() + 300,
        })
    }

    async fn relay_enrollment_complete(
        Json(request): Json<RelayEnrollmentCompleteRequest>,
    ) -> Json<RelayEnrollmentResponse> {
        assert_eq!(request.challenge_id, "rch-1");
        let verify_key_bytes: [u8; 32] = STANDARD
            .decode(&request.relay_verify_key)
            .expect("verify key should decode")
            .try_into()
            .expect("verify key length should match");
        let verify_key =
            ed25519_dalek::VerifyingKey::from_bytes(&verify_key_bytes).expect("verify key valid");
        let signature_bytes: [u8; 64] = STANDARD
            .decode(&request.challenge_signature)
            .expect("signature should decode")
            .try_into()
            .expect("signature length should match");
        let signature = ed25519_dalek::Signature::from_bytes(&signature_bytes);
        verify_key
            .verify("agent-relay:relay-enroll:rch-1:rc-1".as_bytes(), &signature)
            .expect("signature should verify");
        Json(RelayEnrollmentResponse {
            relay_id: "relay-enrolled".to_string(),
            broker_room_id: "room-enrolled".to_string(),
            relay_refresh_token: "relay-refresh-enrolled".to_string(),
            created_at: unix_now(),
            relay_label: request.relay_label,
        })
    }

    async fn relay_ws_token(
        Json(request): Json<RelayWsTokenRequest>,
    ) -> Json<RelayWsTokenResponse> {
        Json(RelayWsTokenResponse {
            relay_id: request.relay_id,
            broker_room_id: request.broker_room_id,
            relay_ws_token: "relay-ws-token".to_string(),
            relay_ws_token_expires_at: 111,
        })
    }

    async fn pairing_ws_token(
        Json(request): Json<PairingWsTokenRequest>,
    ) -> Json<PairingWsTokenResponse> {
        Json(PairingWsTokenResponse {
            relay_id: request.relay_id,
            broker_room_id: request.broker_room_id,
            pairing_join_ticket: format!("pairing-token-{}", request.pairing_id),
            pairing_join_ticket_expires_at: request.expires_at,
        })
    }

    async fn device_grant(Json(request): Json<DeviceGrantRequest>) -> Json<DeviceGrantResponse> {
        Json(DeviceGrantResponse {
            relay_id: request.relay_id,
            broker_room_id: request.broker_room_id,
            device_id: request.device_id.clone(),
            device_refresh_token: format!("refresh-{}", request.device_id),
            device_ws_token: format!("device-ws-{}", request.device_id),
            device_ws_token_expires_at: 222,
        })
    }

    async fn client_grant(Json(request): Json<ClientGrantRequest>) -> Json<ClientGrantResponse> {
        Json(ClientGrantResponse {
            claim_id: format!("claim-for-{}", request.device_id),
            claim_nonce: format!("nonce-for-{}", request.device_id),
            claim_expires_at: 999,
            relay_id: request.relay_id,
            broker_room_id: request.broker_room_id,
            device_id: request.device_id,
            relay_label: Some("Demo Relay".to_string()),
        })
    }

    async fn revoke_device(
        Path(device_id): Path<String>,
        Json(request): Json<DeviceGrantRevokeRequest>,
    ) -> Json<DeviceGrantRevokeResponse> {
        Json(DeviceGrantRevokeResponse {
            relay_id: request.relay_id,
            broker_room_id: request.broker_room_id,
            device_id,
            revoked: true,
            revoked_grant_count: 1,
        })
    }

    async fn revoke_other(
        Json(request): Json<DeviceGrantBulkRevokeRequest>,
    ) -> Json<DeviceGrantBulkRevokeResponse> {
        Json(DeviceGrantBulkRevokeResponse {
            relay_id: request.relay_id,
            broker_room_id: request.broker_room_id,
            kept_device_id: request.keep_device_id,
            revoked_device_ids: vec!["device-b".to_string()],
            revoked_count: 1,
        })
    }

    let app = Router::new()
        .route(
            "/api/public/relay-enrollment/challenge",
            post(relay_enrollment_challenge),
        )
        .route(
            "/api/public/relay-enrollment/complete",
            post(relay_enrollment_complete),
        )
        .route("/api/public/relay/ws-token", post(relay_ws_token))
        .route("/api/public/pairing/ws-token", post(pairing_ws_token))
        .route("/api/public/devices", post(device_grant))
        .route("/api/public/clients/grants", post(client_grant))
        .route("/api/public/devices/:device_id/revoke", post(revoke_device))
        .route("/api/public/devices/revoke-others", post(revoke_other));
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("mock control plane should serve");
    });
    format!("http://{address}")
}

fn broker_test_state() -> AppState {
    let (change_tx, _) = watch::channel(0_u64);
    let relay = Arc::new(RwLock::new(RelayState::new(
        "/tmp/broker-test".to_string(),
        change_tx.clone(),
        SecurityProfile::private(),
    )));
    AppState::from_parts(relay, HashMap::new(), change_tx)
}

async fn spawn_heartbeat_test_broker(respond_to_ping: bool) -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("broker should accept");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("websocket handshake should succeed");
        let welcome = ServerMessage::Welcome {
            protocol_version: BROKER_PROTOCOL_VERSION,
            channel_id: "room-stalled".to_string(),
            peer_id: "relay-stalled".to_string(),
            peers: Vec::new(),
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&welcome).expect("welcome should serialize"),
            ))
            .await
            .expect("welcome should send");

        if !respond_to_ping {
            // Model a connection that remains ESTABLISHED locally after the remote
            // path has died: keep the socket open, but never read, write, close, or
            // answer Ping.
            std::future::pending::<()>().await;
            drop(socket);
            return;
        }

        while let Some(frame) = socket.next().await {
            match frame.expect("heartbeat frame should read") {
                Message::Ping(payload) => socket
                    .send(Message::Pong(payload))
                    .await
                    .expect("heartbeat pong should send"),
                Message::Close(_) => return,
                _ => {}
            }
        }
    });
    format!("ws://{address}")
}

async fn heartbeat_test_config(broker_url: String) -> BrokerConfig {
    BrokerConfig::from_parts(
        Some(broker_url),
        None,
        None,
        Some("room-stalled".to_string()),
        Some("relay-stalled".to_string()),
        Some("self_hosted".to_string()),
        Some("test-broker-ticket-secret".to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("config should parse")
    .expect("config should be enabled")
}

#[tokio::test]
async fn broker_session_times_out_when_peer_goes_silent() {
    let config = heartbeat_test_config(spawn_heartbeat_test_broker(false).await).await;
    let state = broker_test_state();
    let mut change_rx = state.subscribe();

    let error = tokio::time::timeout(
        Duration::from_secs(1),
        run_broker_session_with_liveness(
            &state,
            &mut change_rx,
            &config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_millis(50),
                pong_timeout: Duration::from_millis(25),
            },
        ),
    )
    .await
    .expect("silent broker should hit the liveness deadline")
    .expect_err("silent broker session should end");

    assert!(
        error.message().contains("heartbeat timed out"),
        "silent broker should fail with a heartbeat timeout, got: {}",
        error.message()
    );
    assert!(
        error.connected_duration().is_some(),
        "post-welcome heartbeat failures should carry connected duration"
    );
}

#[tokio::test]
async fn broker_session_stays_connected_when_peer_answers_pings() {
    let config = heartbeat_test_config(spawn_heartbeat_test_broker(true).await).await;
    let state = broker_test_state();
    let mut change_rx = state.subscribe();

    let outcome = tokio::time::timeout(
        Duration::from_millis(250),
        run_broker_session_with_liveness(
            &state,
            &mut change_rx,
            &config,
            BrokerLivenessConfig {
                ping_interval: Duration::from_millis(50),
                pong_timeout: Duration::from_millis(25),
            },
        ),
    )
    .await;

    assert!(
        outcome.is_err(),
        "responsive broker session should remain connected"
    );
    assert!(
        state.snapshot().await.broker_connected,
        "responsive broker should remain broker_connected"
    );
}

#[tokio::test]
async fn broker_config_builds_websocket_url() {
    let config = BrokerConfig::from_parts(
        Some("ws://127.0.0.1:8788".to_string()),
        None,
        None,
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        None,
        Some("test-broker-ticket-secret".to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("config should parse")
    .expect("config should be enabled");

    assert_eq!(config.public_base_url(), "ws://127.0.0.1:8788");
    assert_eq!(config.url.as_str(), "ws://127.0.0.1:8788/ws/demo-room");
    let relay_url = config
        .relay_connect_url()
        .await
        .expect("relay connect url should mint");
    assert!(relay_url
        .as_str()
        .starts_with("ws://127.0.0.1:8788/ws/demo-room?"));
    assert!(relay_url.as_str().contains("peer_id=relay-1"));
    assert!(relay_url.as_str().contains("role=relay"));
    assert!(relay_url.as_str().contains("join_ticket="));
    assert_eq!(config.auth_mode(), BrokerAuthMode::SelfHostedSharedSecret);
}

#[tokio::test]
async fn broker_config_supports_distinct_public_url_for_pairing() {
    let config = BrokerConfig::from_parts(
        Some("ws://127.0.0.1:8788".to_string()),
        Some("ws://192.168.1.105:8788".to_string()),
        None,
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        None,
        Some("test-broker-ticket-secret".to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("config should parse")
    .expect("config should be enabled");

    assert_eq!(config.public_base_url(), "ws://192.168.1.105:8788");
}

#[tokio::test]
async fn broker_config_requires_channel() {
    let error = BrokerConfig::from_parts(
        Some("ws://127.0.0.1:8788".to_string()),
        None,
        None,
        None,
        Some("relay-1".to_string()),
        None,
        Some("test-broker-ticket-secret".to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("missing channel should fail");
    assert!(error.contains("RELAY_BROKER_CHANNEL_ID"));
}

#[tokio::test]
async fn broker_config_disables_when_url_is_missing() {
    let config = BrokerConfig::from_parts(
        None,
        None,
        None,
        Some("demo-room".to_string()),
        None,
        None,
        Some("test-broker-ticket-secret".to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("missing url should be accepted");
    assert!(config.is_none());
}

#[tokio::test]
async fn broker_config_rejects_invalid_public_url_scheme() {
    let error = BrokerConfig::from_parts(
        Some("ws://127.0.0.1:8788".to_string()),
        Some("http://192.168.1.105:8788".to_string()),
        None,
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        None,
        Some("test-broker-ticket-secret".to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("invalid public url scheme should fail");
    assert!(error.contains("RELAY_BROKER_PUBLIC_URL"));
}

#[tokio::test]
async fn broker_config_requires_join_ticket_secret_in_self_hosted_mode() {
    let error = BrokerConfig::from_parts(
        Some("ws://127.0.0.1:8788".to_string()),
        None,
        None,
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        Some("self_hosted".to_string()),
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("missing ticket secret should fail");
    assert!(error.contains(relay_broker::join_ticket::JOIN_TICKET_SECRET_ENV));
}

#[tokio::test]
async fn broker_config_public_mode_uses_control_plane_tokens() {
    let control_url = spawn_public_control_mock().await;
    let config = BrokerConfig::from_parts(
        Some("wss://broker.example.com".to_string()),
        Some("wss://public-broker.example.com".to_string()),
        Some(control_url),
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        Some("public".to_string()),
        None,
        Some("relay-owner-1".to_string()),
        Some("relay-refresh-1".to_string()),
        None,
        None,
        None,
    )
    .await
    .expect("config should parse")
    .expect("config should be enabled");

    assert_eq!(config.auth_mode(), BrokerAuthMode::PublicControlPlane);
    let relay_url = config
        .relay_connect_url()
        .await
        .expect("public mode should fetch a relay ws token");
    assert!(relay_url.as_str().contains("join_ticket=relay-ws-token"));
    let pairing = config
        .pairing_join_credential("pair-1", 123)
        .await
        .expect("public mode should fetch a pairing token");
    assert_eq!(pairing.token, "pairing-token-pair-1");
    let device = config
        .device_broker_credential("device-1", None)
        .await
        .expect("public mode should fetch a device token bundle");
    assert_eq!(device.join_credential.token, "device-ws-device-1");
    assert_eq!(device.refresh_token.as_deref(), Some("refresh-device-1"));
    let client_grant = config
        .client_broker_grant(
            "device-1",
            &STANDARD.encode([5_u8; 32]),
            Some("Phone".to_string()),
        )
        .await
        .expect("public mode should fetch a client grant")
        .expect("public mode should issue a client grant");
    assert_eq!(client_grant.claim_id, "claim-for-device-1");
    assert_eq!(client_grant.claim_nonce, "nonce-for-device-1");
    assert_eq!(client_grant.claim_expires_at, 999);
    assert_eq!(client_grant.relay_id, "relay-owner-1");
    assert_eq!(client_grant.relay_label.as_deref(), Some("Demo Relay"));
}

/// A broker that rejects device grants with the `device_limit_reached` 403.
async fn spawn_device_limit_mock() -> String {
    async fn device_grant_over_limit() -> (axum::http::StatusCode, Json<serde_json::Value>) {
        (
            axum::http::StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "device_limit_reached",
                "message": "device limit reached: this license allows 2 device(s); \
                            remove a device to add a new one",
            })),
        )
    }
    let app = Router::new().route("/api/public/devices", post(device_grant_over_limit));
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should resolve");
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("device-limit mock should serve");
    });
    format!("http://{address}")
}

// Cross-layer contract: when the broker rejects a device grant over the cap, the
// relay must surface the human-readable reason (so the approving operator sees
// "remove a device"), not a generic failure. Guards the error-body shape the
// relay depends on.
#[tokio::test]
async fn device_broker_credential_surfaces_device_limit_error() {
    let control_url = spawn_device_limit_mock().await;
    let config = BrokerConfig::from_parts(
        Some("wss://broker.example.com".to_string()),
        Some("wss://public-broker.example.com".to_string()),
        Some(control_url),
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        Some("public".to_string()),
        None,
        Some("relay-owner-1".to_string()),
        Some("relay-refresh-1".to_string()),
        None,
        None,
        None,
    )
    .await
    .expect("config should parse")
    .expect("config should be enabled");

    let error = config
        .device_broker_credential("device-x", None)
        .await
        .expect_err("an over-cap device grant must surface an error");
    assert!(
        error.contains("device limit reached"),
        "the operator-facing error must explain the device limit, got: {error}"
    );
}

#[tokio::test]
async fn broker_config_public_mode_returns_pending_enrollment_until_cached_registration_exists() {
    let control_url = spawn_public_control_mock().await;
    let registration_path = temp_registration_path("agent-relay-public-registration");
    let identity_path = temp_registration_path("agent-relay-public-identity");

    let pending = BrokerConfig::from_parts_resolution(
        Some("wss://broker.example.com".to_string()),
        Some("wss://public-broker.example.com".to_string()),
        Some(control_url.clone()),
        None,
        Some("relay-auto".to_string()),
        Some("public".to_string()),
        None,
        None,
        None,
        Some(identity_path.clone()),
        Some(registration_path.clone()),
        None,
        None, // license_code
    )
    .await
    .expect("config resolution should parse");
    assert!(matches!(
        pending,
        BrokerConfigResolution::PendingPublicEnrollment(_)
    ));

    let BrokerConfigResolution::PendingPublicEnrollment(pending) = pending else {
        panic!("expected pending public enrollment");
    };
    let client = reqwest::Client::new();
    let registration = perform_public_relay_enrollment(&client, &pending)
        .await
        .expect("challenge enrollment should succeed");
    assert_eq!(registration.relay_id, "relay-enrolled");
    assert_eq!(registration.broker_room_id, "room-enrolled");

    let cached = BrokerConfig::from_parts(
        Some("wss://broker.example.com".to_string()),
        Some("wss://public-broker.example.com".to_string()),
        Some(control_url),
        None,
        Some("relay-auto".to_string()),
        Some("public".to_string()),
        None,
        None,
        None,
        Some(identity_path),
        Some(registration_path),
        None,
    )
    .await
    .expect("cached config should parse")
    .expect("cached config should be enabled");

    assert_eq!(cached.broker_room_id(), "room-enrolled");
    let cached_pairing = cached
        .pairing_join_credential("pair-cached", 123)
        .await
        .expect("cached relay should reuse the saved registration");
    assert_eq!(cached_pairing.token, "pairing-token-pair-cached");
}

#[test]
fn reconnect_backoff_grows_to_cap_with_jitter() {
    let mut backoff = RetryBackoff::new(Duration::from_secs(2), Duration::from_secs(60));
    let mut rng = StdRng::seed_from_u64(7);

    for (index, expected_cap_secs) in [2, 4, 8, 16, 32, 60, 60].into_iter().enumerate() {
        let retry = backoff.next_delay(&mut rng);
        assert_eq!(retry.cap, Duration::from_secs(expected_cap_secs));
        assert_eq!(retry.consecutive_failures, index as u32 + 1);
        assert!(
            retry.delay >= retry.cap / 2 && retry.delay <= retry.cap,
            "retry delay {:?} should stay inside the jitter window for cap {:?}",
            retry.delay,
            retry.cap
        );
    }
}

#[test]
fn reconnect_backoff_resets_only_after_a_stable_session() {
    let mut backoff = RetryBackoff::new(Duration::from_secs(2), Duration::from_secs(60));
    let mut rng = StdRng::seed_from_u64(11);

    assert_eq!(backoff.next_delay(&mut rng).cap, Duration::from_secs(2));
    assert_eq!(backoff.next_delay(&mut rng).cap, Duration::from_secs(4));

    backoff.reset_after_stable_session(Duration::from_secs(
        BROKER_RECONNECT_STABLE_SESSION_SECS - 1,
    ));
    assert_eq!(backoff.next_delay(&mut rng).cap, Duration::from_secs(8));

    backoff.reset_after_stable_session(Duration::from_secs(BROKER_RECONNECT_STABLE_SESSION_SECS));
    let retry = backoff.next_delay(&mut rng);
    assert_eq!(retry.cap, Duration::from_secs(2));
    assert_eq!(retry.consecutive_failures, 1);
}

#[test]
fn snapshot_publish_gate_throttles_burst_snapshot_updates() {
    let mut gate = SnapshotPublishGate::new(Duration::from_millis(500));
    let start = Instant::now();

    assert!(gate.ready_or_deadline(start).is_ok());
    assert!(!gate.has_pending_publish());

    let delayed_until = gate
        .ready_or_deadline(start + Duration::from_millis(100))
        .expect_err("burst update should be delayed");
    assert_eq!(delayed_until, start + Duration::from_millis(500));
    assert!(gate.has_pending_publish());

    assert!(gate
        .ready_or_deadline(start + Duration::from_millis(500))
        .is_ok());
    assert!(!gate.has_pending_publish());
}

#[test]
fn snapshot_publish_decision_flushes_pending_deltas_before_ready_snapshot() {
    let mut gate = SnapshotPublishGate::new(Duration::from_millis(500));
    let start = Instant::now();

    assert_eq!(
        snapshot_publish_decision(&mut gate, start, true),
        SnapshotPublishDecision::FlushTranscriptDeltasThenPublishSnapshot
    );
    assert!(!gate.has_pending_publish());

    let delayed_until = start + Duration::from_millis(500);
    assert_eq!(
        snapshot_publish_decision(&mut gate, start + Duration::from_millis(100), true),
        SnapshotPublishDecision::DelayUntil(delayed_until)
    );
    assert!(gate.has_pending_publish());
}

#[test]
fn transcript_delta_coalescing_merges_contiguous_item_updates() {
    let first = PendingTranscriptDelta {
        thread_id: "thread-1".to_string(),
        base_revision: 10,
        revision: 11,
        entry_seq: 4,
        server_time: 100,
        item_id: "item-1".to_string(),
        turn_id: Some("turn-1".to_string()),
        delta: "hel".to_string(),
        kind: TranscriptDeltaKind::AgentText,
        text_offset: Some(0),
    };
    let second = PendingTranscriptDelta {
        base_revision: 11,
        revision: 12,
        server_time: 101,
        delta: "lo".to_string(),
        ..first.clone()
    };
    let command = PendingTranscriptDelta {
        base_revision: 12,
        revision: 13,
        server_time: 102,
        delta: "!".to_string(),
        kind: TranscriptDeltaKind::CommandOutput,
        ..first.clone()
    };

    let coalesced = coalesce_transcript_deltas(vec![first, second, command]);

    assert_eq!(coalesced.len(), 2);
    assert_eq!(coalesced[0].base_revision, 10);
    assert_eq!(coalesced[0].revision, 12);
    assert_eq!(coalesced[0].server_time, 101);
    assert_eq!(coalesced[0].delta, "hello");
    // The coalesced delta begins where the first chunk began, so it keeps the
    // first chunk's text_offset (not the second's).
    assert_eq!(coalesced[0].text_offset, Some(0));
    assert_eq!(coalesced[1].delta, "!");
}

#[test]
fn targeted_messages_inner_payloads_include_relay_protocol_version() {
    let payload = OutboundBrokerPayload::TargetedMessages {
        messages: vec![TargetedBrokerMessage {
            target_peer_id: "surface-1".to_string(),
            payload: Box::new(OutboundBrokerPayload::EncryptedTranscriptDelta {
                target_peer_id: "surface-1".to_string(),
                device_id: "device-1".to_string(),
                envelope: EncryptedEnvelope {
                    nonce: "nonce".to_string(),
                    ciphertext: "ciphertext".to_string(),
                },
            }),
        }],
    };

    let frame: serde_json::Value =
        serde_json::from_str(&frame_text_for_payload(&payload)).expect("frame should parse");
    let outer_payload = frame
        .get("payload")
        .expect("frame should contain publish payload");
    assert_eq!(
        outer_payload
            .get("protocol_version")
            .and_then(serde_json::Value::as_u64),
        Some(RELAY_PROTOCOL_VERSION)
    );
    let inner_payload = outer_payload
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .and_then(|messages| messages.first())
        .and_then(|message| message.get("payload"))
        .expect("targeted message should contain inner payload");
    assert_eq!(
        inner_payload
            .get("protocol_version")
            .and_then(serde_json::Value::as_u64),
        Some(RELAY_PROTOCOL_VERSION)
    );
    assert_eq!(
        inner_payload
            .get("kind")
            .and_then(serde_json::Value::as_str),
        Some("encrypted_transcript_delta")
    );
}

#[tokio::test]
async fn perform_public_relay_enrollment_uses_relay_keypair_challenge_flow() {
    let control_url = spawn_public_control_mock().await;
    let registration_path = temp_registration_path("agent-relay-public-registration");
    let identity_path = temp_registration_path("agent-relay-public-identity");
    let pending = PendingPublicEnrollment {
        control_url: Url::parse(&control_url).expect("control url should parse"),
        registration_path: std::path::PathBuf::from(&registration_path),
        identity_path: std::path::PathBuf::from(&identity_path),
        license_code: None,
    };

    let registration = perform_public_relay_enrollment(&reqwest::Client::new(), &pending)
        .await
        .expect("automatic relay enrollment should succeed");

    assert_eq!(registration.relay_id, "relay-enrolled");
    assert_eq!(registration.broker_room_id, "room-enrolled");
    assert_eq!(registration.relay_refresh_token, "relay-refresh-enrolled");

    let cached = load_public_relay_registration(
        std::path::Path::new(&registration_path),
        pending.control_url.as_str(),
    )
    .await
    .expect("cached registration should load")
    .expect("cached registration should exist");
    assert_eq!(cached, registration);

    let identity = load_or_create_public_relay_identity(
        std::path::Path::new(&identity_path),
        pending.control_url.as_str(),
    )
    .await
    .expect("relay identity should persist");
    let reloaded_identity = load_or_create_public_relay_identity(
        std::path::Path::new(&identity_path),
        pending.control_url.as_str(),
    )
    .await
    .expect("relay identity should reload");
    assert_eq!(
        STANDARD.encode(identity.signing_key.verifying_key().to_bytes()),
        STANDARD.encode(reloaded_identity.signing_key.verifying_key().to_bytes())
    );
}

#[tokio::test]
async fn broker_config_public_mode_requires_relay_refresh_token() {
    let error = BrokerConfig::from_parts(
        Some("wss://broker.example.com".to_string()),
        None,
        Some("https://broker.example.com".to_string()),
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        Some("public".to_string()),
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("public mode should require a relay refresh token");
    assert!(
        error.contains(RELAY_BROKER_RELAY_ID_ENV)
            || error.contains(RELAY_BROKER_RELAY_REFRESH_TOKEN_ENV)
            || error.contains("not enrolled yet")
    );
}

#[tokio::test]
async fn broker_config_self_hosted_can_issue_expiring_device_join_credentials() {
    let config = BrokerConfig::from_parts(
        Some("ws://127.0.0.1:8788".to_string()),
        None,
        None,
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        Some("self_hosted".to_string()),
        Some("test-broker-ticket-secret".to_string()),
        None,
        None,
        None,
        None,
        Some("3600".to_string()),
    )
    .await
    .expect("config should parse")
    .expect("config should be enabled");

    let credential = config
        .device_broker_credential("device-1", None)
        .await
        .expect("device credential should mint");
    assert!(credential.join_credential.expires_at.is_some());
    assert_eq!(config.device_join_ttl_secs(), Some(3600));
}

#[test]
fn parse_inbound_payload_parses_remote_action_requests() {
    let payload = serde_json::json!({
        "protocol_version": RELAY_PROTOCOL_VERSION,
        "kind": "remote_action",
        "action_id": "act-1",
        "device_id": "phone-1",
        "request": {
            "type": "send_message",
            "input": {
                "text": "hello",
                "thread_id": "thread-1"
            }
        }
    });

    let action = parse_inbound_payload(payload)
        .expect("payload should parse")
        .expect("payload should be handled");
    match action {
        InboundBrokerPayload::RemoteAction {
            action_id,
            device_id,
            request: RemoteActionRequest::SendMessage { input },
            session_claim,
        } => {
            assert_eq!(action_id, "act-1");
            assert_eq!(device_id.as_deref(), Some("phone-1"));
            assert!(session_claim.is_none());
            assert_eq!(input.text, "hello");
        }
        other => panic!("unexpected request: {other:?}"),
    }
}

#[test]
fn parse_inbound_payload_parses_list_threads_requests() {
    let payload = serde_json::json!({
        "protocol_version": RELAY_PROTOCOL_VERSION,
        "kind": "remote_action",
        "action_id": "act-threads",
        "device_id": "phone-1",
        "request": {
            "type": "list_threads",
            "query": {
                "limit": 40
            }
        }
    });

    let action = parse_inbound_payload(payload)
        .expect("payload should parse")
        .expect("payload should be handled");
    match action {
        InboundBrokerPayload::RemoteAction {
            action_id,
            request: RemoteActionRequest::ListThreads { query },
            ..
        } => {
            assert_eq!(action_id, "act-threads");
            assert_eq!(query.limit, Some(40));
        }
        other => panic!("unexpected request: {other:?}"),
    }
}

#[test]
fn parse_inbound_payload_parses_pairing_requests() {
    let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
    let device_id = "phone-1";
    let envelope = encrypt_json(
        "pairing-secret",
        &PairingRequestPlaintext {
            device_id: Some(device_id.to_string()),
            device_label: Some("My Phone".to_string()),
            device_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
            pairing_proof: STANDARD.encode(
                signing_key
                    .sign(pairing_proof_message("pair-1", Some(device_id)).as_bytes())
                    .to_bytes(),
            ),
        },
    )
    .expect("pairing request should encrypt");
    let payload = serde_json::json!({
        "protocol_version": RELAY_PROTOCOL_VERSION,
        "kind": "pairing_request",
        "pairing_id": "pair-1",
        "envelope": envelope
    });

    let request = parse_inbound_payload(payload)
        .expect("payload should parse")
        .expect("pairing request should be handled");
    match request {
        InboundBrokerPayload::PairingRequest {
            pairing_id,
            envelope,
        } => {
            assert_eq!(pairing_id, "pair-1");
            let decrypted: PairingRequestPlaintext =
                decrypt_json("pairing-secret", &envelope).expect("payload should decrypt");
            assert_eq!(decrypted.device_id.as_deref(), Some("phone-1"));
            assert_eq!(decrypted.device_label.as_deref(), Some("My Phone"));
            verify_pairing_request_proof(
                "pair-1",
                decrypted.device_id.as_deref(),
                &decrypted.device_verify_key,
                &decrypted.pairing_proof,
            )
            .expect("pairing proof should verify");
        }
        other => panic!("unexpected request: {other:?}"),
    }
}

#[test]
fn parse_inbound_payload_parses_encrypted_remote_actions() {
    let envelope = encrypt_json(
        "device-secret",
        &RemoteActionRequest::SendMessage {
            input: SendMessageInput {
                text: "encrypted hello".to_string(),
                model: None,
                effort: None,
                device_id: None,
                thread_id: "thread-1".to_string(),
            },
        },
    )
    .expect("encrypted action should encrypt");
    let payload = serde_json::json!({
        "protocol_version": RELAY_PROTOCOL_VERSION,
        "kind": "encrypted_remote_action",
        "action_id": "act-2",
        "device_id": "phone-1",
        "envelope": envelope
    });

    let action = parse_inbound_payload(payload)
        .expect("payload should parse")
        .expect("payload should be handled");
    match action {
        InboundBrokerPayload::EncryptedRemoteAction {
            action_id,
            device_id,
            session_claim,
            envelope,
        } => {
            assert_eq!(action_id, "act-2");
            assert_eq!(device_id.as_deref(), Some("phone-1"));
            assert!(session_claim.is_none());
            let request: RemoteActionRequest =
                decrypt_json("device-secret", &envelope).expect("payload should decrypt");
            match request {
                RemoteActionRequest::SendMessage { input } => {
                    assert_eq!(input.text, "encrypted hello");
                }
                other => panic!("unexpected request: {other:?}"),
            }
        }
        other => panic!("unexpected request: {other:?}"),
    }
}

#[test]
fn parse_inbound_payload_parses_claim_challenge_request() {
    let payload = serde_json::json!({
        "protocol_version": RELAY_PROTOCOL_VERSION,
        "kind": "remote_action",
        "action_id": "claim-start-1",
        "device_id": "phone-1",
        "request": {
            "type": "claim_challenge",
            "proof": "claim-init-proof"
        }
    });

    let action = parse_inbound_payload(payload)
        .expect("payload should parse")
        .expect("payload should be handled");
    match action {
        InboundBrokerPayload::RemoteAction {
            action_id,
            device_id,
            request: RemoteActionRequest::ClaimChallenge { proof },
            ..
        } => {
            assert_eq!(action_id, "claim-start-1");
            assert_eq!(device_id.as_deref(), Some("phone-1"));
            assert_eq!(proof, "claim-init-proof");
        }
        other => panic!("unexpected request: {other:?}"),
    }
}

#[test]
fn parse_inbound_payload_parses_claim_device_proof() {
    let payload = serde_json::json!({
        "protocol_version": RELAY_PROTOCOL_VERSION,
        "kind": "remote_action",
        "action_id": "claim-finish-1",
        "device_id": "phone-1",
        "request": {
            "type": "claim_device",
            "challenge_id": "challenge-1",
            "proof": "signed-proof"
        }
    });

    let action = parse_inbound_payload(payload)
        .expect("payload should parse")
        .expect("payload should be handled");
    match action {
        InboundBrokerPayload::RemoteAction {
            action_id,
            device_id,
            request:
                RemoteActionRequest::ClaimDevice {
                    challenge_id,
                    proof,
                },
            ..
        } => {
            assert_eq!(action_id, "claim-finish-1");
            assert_eq!(device_id.as_deref(), Some("phone-1"));
            assert_eq!(challenge_id, "challenge-1");
            assert_eq!(proof, "signed-proof");
        }
        other => panic!("unexpected request: {other:?}"),
    }
}

#[test]
fn parse_inbound_payload_requires_relay_protocol_version() {
    let payload = serde_json::json!({
        "kind": "remote_action",
        "action_id": "act-missing-version",
        "device_id": "phone-1",
        "request": {
            "type": "claim_challenge",
            "proof": "claim-init-proof"
        }
    });

    let error = parse_inbound_payload(payload).expect_err("protocol version should be required");
    assert!(error.contains("protocol_version is required"));
}

#[test]
fn parse_inbound_payload_rejects_unsupported_relay_protocol_version() {
    let payload = serde_json::json!({
        "protocol_version": RELAY_PROTOCOL_VERSION + 1,
        "kind": "remote_action",
        "action_id": "act-new-version",
        "device_id": "phone-1",
        "request": {
            "type": "claim_challenge",
            "proof": "claim-init-proof"
        }
    });

    let error =
        parse_inbound_payload(payload).expect_err("unsupported protocol version should reject");
    assert!(error.contains("unsupported relay payload protocol_version"));
}

#[test]
fn validate_broker_protocol_version_rejects_unsupported_welcome_version() {
    let error = validate_broker_protocol_version(BROKER_PROTOCOL_VERSION + 1)
        .expect_err("unsupported broker protocol should reject");
    assert!(error.contains("unsupported broker protocol_version"));
}

#[test]
fn parse_inbound_payload_ignores_non_action_payloads() {
    let payload = serde_json::json!({
        "kind": "session_snapshot",
        "snapshot": {
            "current_status": "idle"
        }
    });

    let action = parse_inbound_payload(payload).expect("non-action payload should be ignored");
    assert!(action.is_none());
}

#[test]
fn session_claim_round_trips_for_same_peer() {
    let claim = issue_session_claim("device-a", "peer-a").expect("claim should issue");

    let payload =
        decode_and_verify_session_claim(&claim.token, "peer-a").expect("claim should verify");

    assert_eq!(payload.device_id, "device-a");
    assert!(claim.expires_at > unix_now());
}

#[test]
fn session_claim_rejects_different_peer() {
    let claim = issue_session_claim("device-a", "peer-a").expect("claim should issue");
    let error = decode_and_verify_session_claim(&claim.token, "peer-b")
        .expect_err("claim should reject a different peer");

    assert!(error.contains("different broker peer"));
}

#[test]
fn device_claim_proof_round_trips_for_same_peer_and_action() {
    let signing_key = SigningKey::from_bytes(&[5_u8; 32]);
    let verify_key = STANDARD.encode(signing_key.verifying_key().to_bytes());
    let challenge_id = "claim-1";
    let challenge = "server-challenge";
    let signature = STANDARD.encode(
        signing_key
            .sign(
                device_claim_proof_message(challenge_id, challenge, "device-a", "peer-a")
                    .as_bytes(),
            )
            .to_bytes(),
    );

    verify_device_claim_challenge_proof(
        challenge_id,
        challenge,
        "device-a",
        "peer-a",
        &verify_key,
        &signature,
    )
    .expect("claim proof should verify");
}

#[test]
fn device_claim_proof_rejects_different_peer() {
    let signing_key = SigningKey::from_bytes(&[6_u8; 32]);
    let verify_key = STANDARD.encode(signing_key.verifying_key().to_bytes());
    let challenge_id = "claim-1";
    let challenge = "server-challenge";
    let signature = STANDARD.encode(
        signing_key
            .sign(
                device_claim_proof_message(challenge_id, challenge, "device-a", "peer-a")
                    .as_bytes(),
            )
            .to_bytes(),
    );

    let error = verify_device_claim_challenge_proof(
        challenge_id,
        challenge,
        "device-a",
        "peer-b",
        &verify_key,
        &signature,
    )
    .expect_err("claim proof should reject a different peer");
    assert!(error.contains("device claim proof is invalid"));
}

#[test]
fn summarize_thread_transcript_response_reports_entry_and_char_counts() {
    let summary = summarize_thread_transcript_response(&ThreadTranscriptResponse {
        thread_id: "thread-1".to_string(),
        revision: 5,
        server_time: 6,
        entry_seq_start: Some(1),
        entry_seq_end: Some(2),
        entries: vec![
            TranscriptEntryView {
                item_id: Some("item-1".to_string()),
                kind: TranscriptEntryKind::AgentText,
                text: Some("helloworld".to_string()),
                status: "completed".to_string(),
                turn_id: Some("turn-1".to_string()),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
            },
            TranscriptEntryView {
                item_id: Some("item-2".to_string()),
                kind: TranscriptEntryKind::ToolCall,
                text: Some("done".to_string()),
                status: "completed".to_string(),
                turn_id: Some("turn-1".to_string()),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
            },
        ],
        next_cursor: Some(8),
        prev_cursor: Some(3),
        thread_state: None,
    });

    assert!(summary.contains("thread_id=thread-1"));
    assert!(summary.contains("entries=2"));
    assert!(summary.contains("chars=14"));
    assert!(summary.contains("next_cursor=8"));
    assert!(summary.contains("prev_cursor=3"));
}

// A workspace-write-sandboxed agent can't write outside the workspace on its
// own, but the relay (which isn't sandboxed) can. The registration cache is
// written through a `<name>.tmp` sibling; a symlink pre-planted there would let
// a plain write land the cache bytes on the symlink's external target. Creating
// the temp file exclusively must refuse the symlink rather than write through
// it.
#[cfg(unix)]
#[tokio::test]
async fn save_public_relay_registration_refuses_a_preplanted_temp_symlink() {
    let dir = tempfile::tempdir().expect("tempdir");
    let victim = dir.path().join("victim.txt");
    std::fs::write(&victim, b"do not touch me").unwrap();

    let registration_path = dir.path().join("public-broker-registration.json");
    let temp_path = registration_path.with_extension("tmp");
    std::os::unix::fs::symlink(&victim, &temp_path).unwrap();

    let registration = PublicRelayRegistration {
        relay_id: "relay-x".into(),
        broker_room_id: "room-x".into(),
        relay_refresh_token: "refresh-x".into(),
    };
    let result = save_public_relay_registration(
        &registration_path,
        "https://control.example",
        &registration,
    )
    .await;

    assert!(
        result.is_err(),
        "save must refuse to write through a pre-planted symlink at the temp path"
    );
    assert_eq!(
        std::fs::read(&victim).unwrap(),
        b"do not touch me",
        "the external file the planted symlink points to must be untouched"
    );
    assert!(
        !registration_path.exists(),
        "save must not have completed the rename onto the real registration path"
    );
}

// The broker registration (relay_id + refresh token) and the identity seed are
// this relay's identity to the public broker. Deriving them from the launch
// directory meant `cd ~/elsewhere && sealwire cloud` re-enrolled as a brand new
// relay, orphaning the devices already paired with the old one.
#[test]
fn broker_identity_files_are_shared_across_launch_directories() {
    let _lock = crate::state_paths::env_lock();
    let home = tempfile::tempdir().unwrap();
    let _home = crate::state_paths::EnvVarGuard::set("HOME", Some(home.path()));
    let _state = crate::state_paths::EnvVarGuard::set("RELAY_STATE_PATH", None);

    let a = std::path::Path::new("/tmp/workspace-a");
    let b = std::path::Path::new("/tmp/workspace-b");

    assert_eq!(
        resolve_public_relay_registration_path(a, None),
        resolve_public_relay_registration_path(b, None),
        "broker registration must not fork per launch directory"
    );
    assert_eq!(
        resolve_public_relay_identity_path(a, None),
        resolve_public_relay_identity_path(b, None),
        "the relay signing seed must not fork per launch directory"
    );
    assert_eq!(
        resolve_public_relay_registration_path(a, None),
        home.path()
            .join(".agent-relay")
            .join("public-broker-registration.json"),
    );
    assert_eq!(
        resolve_public_relay_identity_path(a, None),
        home.path()
            .join(".agent-relay")
            .join("public-broker-identity.json"),
    );
}

#[test]
fn broker_identity_files_follow_an_explicit_state_path() {
    let _lock = crate::state_paths::env_lock();
    let home = tempfile::tempdir().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let _home = crate::state_paths::EnvVarGuard::set("HOME", Some(home.path()));
    let _state = crate::state_paths::EnvVarGuard::set(
        "RELAY_STATE_PATH",
        Some(&scratch.path().join("scratch-session.json")),
    );

    let a = std::path::Path::new("/tmp/workspace-a");
    assert_eq!(
        resolve_public_relay_registration_path(a, None),
        scratch.path().join("public-broker-registration.json"),
    );
    assert_eq!(
        resolve_public_relay_identity_path(a, None),
        scratch.path().join("public-broker-identity.json"),
    );
}

// An explicit per-file override still wins — the escape hatch for a split
// setup that deliberately keeps one file elsewhere.
#[test]
fn an_explicit_broker_path_override_still_wins() {
    let _lock = crate::state_paths::env_lock();
    let home = tempfile::tempdir().unwrap();
    let _home = crate::state_paths::EnvVarGuard::set("HOME", Some(home.path()));
    let _state = crate::state_paths::EnvVarGuard::set("RELAY_STATE_PATH", None);

    assert_eq!(
        resolve_public_relay_registration_path(
            std::path::Path::new("/tmp/workspace-a"),
            Some("/tmp/explicit-registration.json".to_string()),
        ),
        std::path::Path::new("/tmp/explicit-registration.json"),
    );
}

/// End-to-end delivery contract for transcript deltas, in BOTH security modes.
///
/// Everything above this point tested the state layer (who *should* be a target). These
/// drive real relay state through `build_transcript_delta_messages` to the actual wire
/// payloads: which peer each frame is addressed to, and what that peer can read.
mod transcript_delta_delivery {
    use super::*;
    use crate::state::{PairedDevice, RelayState};

    const SECRET_A: &str = "payload-secret-phone-a";
    const SECRET_B: &str = "payload-secret-phone-b";

    fn delta(thread_id: &str, text: &str) -> PendingTranscriptDelta {
        PendingTranscriptDelta {
            thread_id: thread_id.to_string(),
            base_revision: 4,
            revision: 5,
            entry_seq: 2,
            server_time: 1_700,
            item_id: "item-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            delta: text.to_string(),
            kind: TranscriptDeltaKind::AgentText,
            text_offset: Some(11),
        }
    }

    fn relay_with_two_phones() -> RelayState {
        let (change_tx, _) = watch::channel(0_u64);
        let mut relay = RelayState::new(
            "/tmp/project".to_string(),
            change_tx,
            SecurityProfile::private(),
        );
        for (device_id, peer_id, secret) in [
            ("phone-a", "peer-a", SECRET_A),
            ("phone-b", "peer-b", SECRET_B),
        ] {
            relay.paired_devices.insert(
                device_id.to_string(),
                PairedDevice {
                    device_id: device_id.to_string(),
                    label: device_id.to_string(),
                    payload_secret: secret.to_string(),
                    device_verify_key: String::new(),
                    created_at: 0,
                    last_seen_at: None,
                    last_peer_id: Some(peer_id.to_string()),
                    broker_join_ticket_expires_at: None,
                    path_scope: Vec::new(),
                },
            );
            relay.mark_surface_peer_online(peer_id);
            relay.bind_surface_peer_to_device(device_id, peer_id);
            relay.register_broker_surface(peer_id);
        }
        relay
    }

    fn targets_for(relay: &RelayState, thread_id: &str) -> Vec<BrokerTarget> {
        relay
            .broker_targets_for_thread(thread_id)
            .into_iter()
            .map(|(device_id, peer_id, payload_secret)| BrokerTarget {
                device_id,
                peer_id,
                payload_secret,
            })
            .collect()
    }

    fn addressed_peers(messages: &[TargetedBrokerMessage]) -> Vec<String> {
        let mut peers: Vec<String> = messages
            .iter()
            .map(|message| message.target_peer_id.clone())
            .collect();
        peers.sort();
        peers
    }

    /// MANAGED: one frame per watching peer, addressed to that peer. The pre-targeting
    /// behavior was a single un-addressed broadcast the whole room received.
    #[test]
    fn managed_mode_addresses_only_the_watching_peer() {
        let mut relay = relay_with_two_phones();
        relay.set_watched_threads("peer-a", "phone-a", vec!["thread-x".to_string()]);
        relay.set_watched_threads("peer-b", "phone-b", vec!["thread-other".to_string()]);

        let messages = build_transcript_delta_messages(
            targets_for(&relay, "thread-x"),
            true,
            &delta("thread-x", "hello"),
        )
        .expect("managed delivery should build");

        assert_eq!(addressed_peers(&messages), vec!["peer-a".to_string()]);
        match &*messages[0].payload {
            OutboundBrokerPayload::TranscriptDelta {
                thread_id,
                delta,
                delta_kind,
                text_offset,
                ..
            } => {
                assert_eq!(thread_id, "thread-x");
                assert_eq!(delta, "hello");
                assert_eq!(delta_kind, "agent_text");
                assert_eq!(*text_offset, Some(11));
            }
            other => panic!("managed mode must send a plaintext delta, got: {other:?}"),
        }
    }

    /// E2EE: one envelope per watching peer, and ONLY that peer's device key opens it.
    #[test]
    fn e2ee_mode_encrypts_per_device_and_addresses_only_the_watcher() {
        let mut relay = relay_with_two_phones();
        relay.set_watched_threads("peer-a", "phone-a", vec!["thread-x".to_string()]);
        relay.set_watched_threads("peer-b", "phone-b", vec!["thread-other".to_string()]);

        let messages = build_transcript_delta_messages(
            targets_for(&relay, "thread-x"),
            false,
            &delta("thread-x", "secret text"),
        )
        .expect("e2ee delivery should build");

        assert_eq!(addressed_peers(&messages), vec!["peer-a".to_string()]);
        match &*messages[0].payload {
            OutboundBrokerPayload::EncryptedTranscriptDelta {
                target_peer_id,
                device_id,
                envelope,
            } => {
                assert_eq!(target_peer_id, "peer-a");
                assert_eq!(device_id, "phone-a");
                let opened: serde_json::Value =
                    decrypt_json(SECRET_A, envelope).expect("the addressed device must decrypt");
                assert_eq!(opened["delta"], "secret text");
                assert_eq!(opened["thread_id"], "thread-x");
                assert_eq!(opened["text_offset"], 11);
                // The other paired device must not be able to read it, even if the frame
                // reached it: targeting is not the only barrier.
                assert!(
                    decrypt_json::<serde_json::Value>(SECRET_B, envelope).is_err(),
                    "another device's key must not open this envelope"
                );
            }
            other => panic!("private mode must encrypt, got: {other:?}"),
        }
    }

    /// Two devices watching the same thread each get their OWN envelope, sealed to their
    /// own key — not one shared ciphertext.
    #[test]
    fn e2ee_mode_seals_a_separate_envelope_per_watching_device() {
        let mut relay = relay_with_two_phones();
        relay.set_watched_threads("peer-a", "phone-a", vec!["thread-x".to_string()]);
        relay.set_watched_threads("peer-b", "phone-b", vec!["thread-x".to_string()]);

        let messages = build_transcript_delta_messages(
            targets_for(&relay, "thread-x"),
            false,
            &delta("thread-x", "shared"),
        )
        .expect("e2ee delivery should build");

        assert_eq!(
            addressed_peers(&messages),
            vec!["peer-a".to_string(), "peer-b".to_string()]
        );
        for message in &messages {
            let (secret, expected_device) = if message.target_peer_id == "peer-a" {
                (SECRET_A, "phone-a")
            } else {
                (SECRET_B, "phone-b")
            };
            match &*message.payload {
                OutboundBrokerPayload::EncryptedTranscriptDelta {
                    device_id,
                    envelope,
                    ..
                } => {
                    assert_eq!(device_id, expected_device);
                    let opened: serde_json::Value =
                        decrypt_json(secret, envelope).expect("each device opens its own envelope");
                    assert_eq!(opened["delta"], "shared");
                }
                other => panic!("expected an encrypted delta, got: {other:?}"),
            }
        }
    }

    /// A thread nobody declared produces no frames at all, in either mode. This is the
    /// whole point of declaring: an unwatched background thread costs nothing.
    #[test]
    fn an_unwatched_thread_produces_no_frames_in_either_mode() {
        let mut relay = relay_with_two_phones();
        relay.set_watched_threads("peer-a", "phone-a", vec!["thread-other".to_string()]);
        relay.set_watched_threads("peer-b", "phone-b", vec!["thread-other".to_string()]);

        for broker_can_read_content in [true, false] {
            let messages = build_transcript_delta_messages(
                targets_for(&relay, "thread-x"),
                broker_can_read_content,
                &delta("thread-x", "hello"),
            )
            .expect("building should succeed");
            assert!(
                messages.is_empty(),
                "an unwatched thread must produce no frames (broker_readable={broker_can_read_content})"
            );
        }
    }

    /// Two surfaces of the SAME device viewing different threads each get only their own
    /// thread — the device-union targeting sent both threads to both peers.
    #[test]
    fn two_surfaces_of_one_device_receive_only_their_own_thread() {
        let (change_tx, _) = watch::channel(0_u64);
        let mut relay = RelayState::new(
            "/tmp/project".to_string(),
            change_tx,
            SecurityProfile::private(),
        );
        relay.paired_devices.insert(
            "phone".to_string(),
            PairedDevice {
                device_id: "phone".to_string(),
                label: "phone".to_string(),
                payload_secret: SECRET_A.to_string(),
                device_verify_key: String::new(),
                created_at: 0,
                last_seen_at: None,
                last_peer_id: Some("peer-2".to_string()),
                broker_join_ticket_expires_at: None,
                path_scope: Vec::new(),
            },
        );
        for peer in ["peer-1", "peer-2"] {
            relay.mark_surface_peer_online(peer);
            relay.bind_surface_peer_to_device("phone", peer);
            relay.register_broker_surface(peer);
        }
        relay.set_watched_threads("peer-1", "phone", vec!["thread-a".to_string()]);
        relay.set_watched_threads("peer-2", "phone", vec!["thread-b".to_string()]);

        let a = build_transcript_delta_messages(
            targets_for(&relay, "thread-a"),
            true,
            &delta("thread-a", "A"),
        )
        .expect("build");
        assert_eq!(addressed_peers(&a), vec!["peer-1".to_string()]);

        let b = build_transcript_delta_messages(
            targets_for(&relay, "thread-b"),
            true,
            &delta("thread-b", "B"),
        )
        .expect("build");
        assert_eq!(addressed_peers(&b), vec!["peer-2".to_string()]);
    }

    /// A device whose path scope excludes the thread gets nothing, even though it
    /// declared the watch — delivery re-checks, so tightening a scope takes effect.
    #[test]
    fn a_scope_that_excludes_the_thread_produces_no_frames() {
        let mut relay = relay_with_two_phones();
        relay.ensure_runtime_for_thread("thread-x").current_cwd = "/tmp/project/secret".to_string();
        relay.set_watched_threads("peer-a", "phone-a", vec!["thread-x".to_string()]);
        assert_eq!(
            targets_for(&relay, "thread-x").len(),
            1,
            "legal while unscoped"
        );

        relay
            .paired_devices
            .get_mut("phone-a")
            .expect("paired")
            .path_scope = vec!["/tmp/project/allowed".to_string()];

        let messages = build_transcript_delta_messages(
            targets_for(&relay, "thread-x"),
            false,
            &delta("thread-x", "nope"),
        )
        .expect("build");
        assert!(
            messages.is_empty(),
            "a device whose scope no longer covers the thread must receive nothing"
        );
    }
}

#[test]
fn a_pairing_result_is_addressed_to_one_peer_and_never_broadcast() {
    // SECURITY: the pairing result seals payload_secret + refresh tokens with the
    // pairing_secret printed into the QR. If it goes out as a bare payload the
    // broker fans it out to the whole room, so any bystander replaying the same
    // pairing join ticket gets the envelope and can open it with the QR's secret.
    // The `targeted_messages` wrapper is what confines it to one peer.
    let result = crate::state::PendingPairingResult {
        pairing_id: "pair-abc".to_string(),
        target_peer_id: "surface-intended".to_string(),
        pairing_secret: "pairing-secret-from-the-qr".to_string(),
        device: None,
        payload_secret: Some("payload-secret-must-stay-sealed".to_string()),
        relay_id: Some("relay-1".to_string()),
        relay_label: None,
        client_claim_id: Some("claim-1".to_string()),
        client_claim_nonce: Some("cn-must-stay-sealed".to_string()),
        client_claim_expires_at: Some(300),
        device_refresh_token: Some("dref-must-stay-sealed".to_string()),
        device_join_ticket: Some("join-ticket-must-stay-sealed".to_string()),
        device_join_ticket_expires_at: Some(300),
        error: None,
    };

    let message = pairing_result_targeted_message(result).expect("pairing result should seal");
    assert_eq!(
        message.target_peer_id, "surface-intended",
        "the wrapper must address the peer that completed the handshake"
    );

    let frame = frame_text_for_payload(&OutboundBrokerPayload::TargetedMessages {
        messages: vec![message],
    });
    let parsed: serde_json::Value =
        serde_json::from_str(&frame).expect("outbound frame should parse");
    assert_eq!(
        parsed["payload"]["kind"], "targeted_messages",
        "a pairing result published bare is broadcast by the broker; frame was {frame}"
    );
    assert_eq!(
        parsed["payload"]["messages"][0]["target_peer_id"], "surface-intended",
        "the broker routes on the wrapper's target_peer_id"
    );

    for secret in [
        "payload-secret-must-stay-sealed",
        "cref-must-stay-sealed",
        "dref-must-stay-sealed",
        "join-ticket-must-stay-sealed",
    ] {
        assert!(
            !frame.contains(secret),
            "{secret} must be sealed inside the envelope, not readable in the frame"
        );
    }
}
