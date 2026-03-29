use super::*;
use crate::protocol::SendMessageInput;
use axum::{extract::Path, routing::post, Json, Router};
use ed25519_dalek::{Signer, SigningKey};
use relay_broker::public_control::{
    DeviceGrantBulkRevokeRequest, DeviceGrantBulkRevokeResponse, DeviceGrantRequest,
    DeviceGrantResponse, DeviceGrantRevokeRequest, DeviceGrantRevokeResponse,
    PairingWsTokenRequest, PairingWsTokenResponse, RelayWsTokenRequest, RelayWsTokenResponse,
};
use tokio::net::TcpListener;

use super::session_claim::{decode_and_verify_session_claim, unix_now};

async fn spawn_public_control_mock() -> String {
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
        .route("/api/public/relay/ws-token", post(relay_ws_token))
        .route("/api/public/pairing/ws-token", post(pairing_ws_token))
        .route("/api/public/devices", post(device_grant))
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
    )
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

#[test]
fn broker_config_supports_distinct_public_url_for_pairing() {
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
    )
    .expect("config should parse")
    .expect("config should be enabled");

    assert_eq!(config.public_base_url(), "ws://192.168.1.105:8788");
}

#[test]
fn broker_config_requires_channel() {
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
    )
    .expect_err("missing channel should fail");
    assert!(error.contains("RELAY_BROKER_CHANNEL_ID"));
}

#[test]
fn broker_config_disables_when_url_is_missing() {
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
    )
    .expect("missing url should be accepted");
    assert!(config.is_none());
}

#[test]
fn broker_config_rejects_invalid_public_url_scheme() {
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
    )
    .expect_err("invalid public url scheme should fail");
    assert!(error.contains("RELAY_BROKER_PUBLIC_URL"));
}

#[test]
fn broker_config_requires_join_ticket_secret_in_self_hosted_mode() {
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
    )
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
    )
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
}

#[test]
fn broker_config_public_mode_requires_relay_refresh_token() {
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
    )
    .expect_err("public mode should require a relay refresh token");
    assert!(
        error.contains(RELAY_BROKER_RELAY_ID_ENV)
            || error.contains(RELAY_BROKER_RELAY_REFRESH_TOKEN_ENV)
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
        Some("3600".to_string()),
    )
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
        "kind": "remote_action",
        "action_id": "act-1",
        "auth": {
            "device_id": "phone-1",
            "device_token": "token-1"
        },
        "request": {
            "type": "send_message",
            "input": {
                "text": "hello"
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
            auth,
            request: RemoteActionRequest::SendMessage { input },
            session_claim,
        } => {
            assert_eq!(action_id, "act-1");
            assert!(device_id.is_none());
            let auth = auth.expect("auth should be present");
            assert_eq!(auth.device_id, "phone-1");
            assert_eq!(auth.device_token, "token-1");
            assert!(session_claim.is_none());
            assert_eq!(input.text, "hello");
        }
        other => panic!("unexpected request: {other:?}"),
    }
}

#[test]
fn parse_inbound_payload_parses_list_threads_requests() {
    let payload = serde_json::json!({
        "kind": "remote_action",
        "action_id": "act-threads",
        "auth": {
            "device_id": "phone-1",
            "device_token": "token-1"
        },
        "request": {
            "type": "list_threads",
            "query": {
                "cwd": "/tmp/project",
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
            assert_eq!(query.cwd.as_deref(), Some("/tmp/project"));
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
                effort: None,
                device_id: None,
            },
        },
    )
    .expect("encrypted action should encrypt");
    let payload = serde_json::json!({
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
fn parse_inbound_payload_parses_claim_device_proof() {
    let payload = serde_json::json!({
        "kind": "remote_action",
        "action_id": "claim-1",
        "auth": {
            "device_id": "phone-1",
            "device_token": "token-1"
        },
        "request": {
            "type": "claim_device",
            "proof": "signed-proof"
        }
    });

    let action = parse_inbound_payload(payload)
        .expect("payload should parse")
        .expect("payload should be handled");
    match action {
        InboundBrokerPayload::RemoteAction {
            action_id,
            auth,
            request: RemoteActionRequest::ClaimDevice { proof },
            ..
        } => {
            assert_eq!(action_id, "claim-1");
            assert_eq!(proof, "signed-proof");
            let auth = auth.expect("auth should be present");
            assert_eq!(auth.device_id, "phone-1");
            assert_eq!(auth.device_token, "token-1");
        }
        other => panic!("unexpected request: {other:?}"),
    }
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
    let signature = STANDARD.encode(
        signing_key
            .sign(device_claim_proof_message("claim-1", "device-a", "peer-a").as_bytes())
            .to_bytes(),
    );

    verify_device_claim_proof("claim-1", "device-a", "peer-a", &verify_key, &signature)
        .expect("claim proof should verify");
}

#[test]
fn device_claim_proof_rejects_different_peer() {
    let signing_key = SigningKey::from_bytes(&[6_u8; 32]);
    let verify_key = STANDARD.encode(signing_key.verifying_key().to_bytes());
    let signature = STANDARD.encode(
        signing_key
            .sign(device_claim_proof_message("claim-1", "device-a", "peer-a").as_bytes())
            .to_bytes(),
    );

    let error = verify_device_claim_proof("claim-1", "device-a", "peer-b", &verify_key, &signature)
        .expect_err("claim proof should reject a different peer");
    assert!(error.contains("device claim proof is invalid"));
}
