use super::*;
use crate::protocol::SendMessageInput;
use ed25519_dalek::{Signer, SigningKey};

use super::session_claim::{decode_and_verify_session_claim, unix_now};

#[test]
fn broker_config_builds_websocket_url() {
    let config = BrokerConfig::from_parts(
        Some("ws://127.0.0.1:8788".to_string()),
        None,
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        None,
        Some("test-broker-ticket-secret".to_string()),
        None,
        None,
    )
    .expect("config should parse")
    .expect("config should be enabled");

    assert_eq!(config.public_base_url(), "ws://127.0.0.1:8788");
    assert!(config
        .url
        .as_str()
        .starts_with("ws://127.0.0.1:8788/ws/demo-room?"));
    assert!(config.url.as_str().contains("peer_id=relay-1"));
    assert!(config.url.as_str().contains("role=relay"));
    assert!(config.url.as_str().contains("join_ticket="));
    assert_eq!(config.auth_mode(), BrokerAuthMode::SelfHostedSharedSecret);
}

#[test]
fn broker_config_supports_distinct_public_url_for_pairing() {
    let config = BrokerConfig::from_parts(
        Some("ws://127.0.0.1:8788".to_string()),
        Some("ws://192.168.1.105:8788".to_string()),
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        None,
        Some("test-broker-ticket-secret".to_string()),
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
        Some("relay-1".to_string()),
        None,
        Some("test-broker-ticket-secret".to_string()),
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
        Some("demo-room".to_string()),
        None,
        None,
        Some("test-broker-ticket-secret".to_string()),
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
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        None,
        Some("test-broker-ticket-secret".to_string()),
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
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        Some("self_hosted".to_string()),
        None,
        None,
        None,
    )
    .expect_err("missing ticket secret should fail");
    assert!(error.contains(relay_broker::join_ticket::JOIN_TICKET_SECRET_ENV));
}

#[test]
fn broker_config_public_mode_uses_relay_ws_token_for_relay_connection() {
    let config = BrokerConfig::from_parts(
        Some("wss://broker.example.com".to_string()),
        Some("wss://public-broker.example.com".to_string()),
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        Some("public".to_string()),
        None,
        Some("relay-ws-token".to_string()),
        None,
    )
    .expect("config should parse")
    .expect("config should be enabled");

    assert_eq!(config.auth_mode(), BrokerAuthMode::PublicControlPlane);
    assert!(config.url.as_str().contains("join_ticket=relay-ws-token"));
    let error = config
        .pairing_join_credential("pair-1", 123)
        .expect_err("public mode pairing credentials are not wired yet");
    assert!(error.contains("hosted pairing token issuance"));
}

#[test]
fn broker_config_public_mode_requires_relay_ws_token() {
    let error = BrokerConfig::from_parts(
        Some("wss://broker.example.com".to_string()),
        None,
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        Some("public".to_string()),
        None,
        None,
        None,
    )
    .expect_err("public mode should require a relay ws token");
    assert!(error.contains(RELAY_BROKER_RELAY_WS_TOKEN_ENV));
}

#[test]
fn broker_config_self_hosted_can_issue_expiring_device_join_credentials() {
    let config = BrokerConfig::from_parts(
        Some("ws://127.0.0.1:8788".to_string()),
        None,
        Some("demo-room".to_string()),
        Some("relay-1".to_string()),
        Some("self_hosted".to_string()),
        Some("test-broker-ticket-secret".to_string()),
        None,
        Some("3600".to_string()),
    )
    .expect("config should parse")
    .expect("config should be enabled");

    let credential = config
        .device_join_credential("device-1")
        .expect("device credential should mint");
    assert!(credential.expires_at.is_some());
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
