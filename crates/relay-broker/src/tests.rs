use std::{
    fs,
    net::SocketAddr,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use super::*;
use crate::auth::BrokerAuthMode;
use crate::join_ticket::{JoinTicketClaims, JoinTicketKey};
use crate::public_control::{
    DeviceGrantBulkRevokeRequest, DeviceGrantBulkRevokeResponse, DeviceGrantRequest,
    DeviceGrantResponse, DeviceGrantRevokeRequest, DeviceGrantRevokeResponse,
    DeviceWsTokenResponse, PairingWsTokenRequest, PairingWsTokenResponse, PublicControlPlane,
    RelayWsTokenRequest, RelayWsTokenResponse,
};

async fn spawn_app() -> SocketAddr {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    let app = app_with_web_root_and_verifier(
        BrokerState::default(),
        test_web_root(),
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
    );
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("broker should serve");
    });
    address
}

async fn spawn_public_mode_app() -> SocketAddr {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    let public_control = test_public_control_plane().await;
    let app = app_with_web_root_and_verifier(
        BrokerState::default(),
        test_web_root(),
        BrokerJoinVerifier::PublicControlPlane(public_control),
    );
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("broker should serve");
    });
    address
}

async fn next_server_message(
    stream: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> ServerMessage {
    let frame = stream
        .next()
        .await
        .expect("socket should stay open")
        .expect("frame should decode");
    let text = frame.into_text().expect("frame should be text");
    serde_json::from_str(&text).expect("server message should parse")
}

async fn http_get(address: SocketAddr, path: &str) -> String {
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .expect("tcp stream should connect");
    let request = format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("request should write");

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .await
        .expect("response should read");
    response
}

async fn public_post<TReq, TResp>(
    address: SocketAddr,
    path: &str,
    bearer_token: &str,
    request: &TReq,
) -> TResp
where
    TReq: serde::Serialize + ?Sized,
    TResp: serde::de::DeserializeOwned,
{
    reqwest::Client::new()
        .post(format!("http://{address}{path}"))
        .bearer_auth(bearer_token)
        .json(request)
        .send()
        .await
        .expect("request should succeed")
        .error_for_status()
        .expect("response should be successful")
        .json::<TResp>()
        .await
        .expect("response should decode")
}

async fn public_post_expect_status<TReq>(
    address: SocketAddr,
    path: &str,
    bearer_token: &str,
    request: &TReq,
    expected_status: reqwest::StatusCode,
) -> String
where
    TReq: serde::Serialize + ?Sized,
{
    let response = reqwest::Client::new()
        .post(format!("http://{address}{path}"))
        .bearer_auth(bearer_token)
        .json(request)
        .send()
        .await
        .expect("request should complete");
    assert_eq!(response.status(), expected_status);
    response.text().await.expect("error body should read")
}

fn test_web_root() -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be monotonic enough for tests")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("agent-relay-broker-web-{unique}"));
    let assets = root.join("assets");
    fs::create_dir_all(&assets).expect("test asset directory should be created");
    fs::write(
        root.join("remote.html"),
        r#"<!doctype html><html><body>Remote Broker Surface<script type="module" src="/static/assets/remote-test.js"></script></body></html>"#,
    )
    .expect("remote html should write");
    fs::write(
        root.join("remote-manifest.webmanifest"),
        r#"{"display":"standalone","src":"/icon.svg"}"#,
    )
    .expect("manifest should write");
    fs::write(
        root.join("remote-sw.js"),
        r#"self.addEventListener("install", () => {}); const CACHE = "agent-relay-remote-v1";"#,
    )
    .expect("service worker should write");
    fs::write(
        root.join("icon.svg"),
        r#"<svg xmlns="http://www.w3.org/2000/svg"></svg>"#,
    )
    .expect("icon should write");
    fs::write(assets.join("remote-test.js"), "console.log('remote');").expect("asset should write");
    root
}

fn test_join_ticket_key() -> JoinTicketKey {
    JoinTicketKey::from_secret("broker-test-secret".as_bytes())
        .expect("test join-ticket key should construct")
}

async fn test_public_control_plane() -> PublicControlPlane {
    PublicControlPlane::from_parts(
        Some("public-broker-issuer-secret".to_string()),
        Some(
            serde_json::to_string(&vec![serde_json::json!({
                "relay_id": "relay-1",
                "broker_room_id": "room-a",
                "refresh_token": "relay-refresh-1"
            })])
            .expect("relay registrations should encode"),
        ),
        None,
        Some("300".to_string()),
        Some("300".to_string()),
    )
    .await
    .expect("public control plane should configure")
}

fn websocket_url(
    address: SocketAddr,
    channel_id: &str,
    role: protocol::PeerRole,
    peer_id: Option<&str>,
    claims: JoinTicketClaims,
) -> String {
    let role = match role {
        protocol::PeerRole::Relay => "relay",
        protocol::PeerRole::Surface => "surface",
    };
    let join_ticket = test_join_ticket_key()
        .mint(&claims)
        .expect("join ticket should mint");
    let mut url = format!("ws://{address}/ws/{channel_id}?role={role}&join_ticket={join_ticket}");
    if let Some(peer_id) = peer_id {
        url.push_str("&peer_id=");
        url.push_str(peer_id);
    }
    url
}

#[tokio::test]
async fn root_serves_remote_surface_html() {
    let address = spawn_app().await;
    let response = http_get(address, "/").await;

    assert!(response.contains("200 OK"));
    assert!(response.contains("Remote Broker Surface"));
    assert!(response.contains("/static/assets/remote-"));
}

#[tokio::test]
async fn manifest_route_serves_remote_pwa_manifest() {
    let address = spawn_app().await;
    let response = http_get(address, "/manifest.webmanifest").await;

    assert!(response.contains("200 OK"));
    assert!(response.contains("\"display\":\"standalone\""));
    assert!(response.contains("\"src\":\"/icon.svg\""));
}

#[tokio::test]
async fn service_worker_route_serves_remote_cache_script() {
    let address = spawn_app().await;
    let response = http_get(address, "/sw.js").await;

    assert!(response.contains("200 OK"));
    assert!(response.contains("agent-relay-remote-v1"));
    assert!(response.contains("self.addEventListener(\"install\""));
}

#[tokio::test]
async fn websocket_relays_messages_between_peers() {
    let address = spawn_app().await;
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );
    let surface_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        Some("phone-1"),
        JoinTicketClaims::pairing_surface_join("room-a", "pair-1", u64::MAX),
    );

    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay should connect");
    let welcome = next_server_message(&mut relay).await;
    match welcome {
        ServerMessage::Welcome { peers, .. } => assert!(peers.is_empty()),
        other => panic!("unexpected welcome frame: {other:?}"),
    }

    let (mut surface, _) = connect_async(&surface_url)
        .await
        .expect("surface should connect");
    let welcome = next_server_message(&mut surface).await;
    match welcome {
        ServerMessage::Welcome { peers, .. } => {
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].peer_id, "relay-1");
        }
        other => panic!("unexpected welcome frame: {other:?}"),
    }

    let presence = next_server_message(&mut relay).await;
    match presence {
        ServerMessage::Presence { kind, peer, .. } => {
            assert_eq!(kind, protocol::PresenceKind::Joined);
            assert_eq!(peer.peer_id, "phone-1");
        }
        other => panic!("unexpected presence frame: {other:?}"),
    }

    relay
        .send(Message::Text(
            serde_json::to_string(&ClientMessage::Publish {
                payload: json!({"ciphertext":"abc"}),
            })
            .expect("client frame should serialize"),
        ))
        .await
        .expect("publish should send");

    let relayed = next_server_message(&mut surface).await;
    match relayed {
        ServerMessage::Message {
            from_peer_id,
            from_role,
            payload,
            ..
        } => {
            assert_eq!(from_peer_id, "relay-1");
            assert_eq!(from_role, protocol::PeerRole::Relay);
            assert_eq!(payload, json!({"ciphertext":"abc"}));
        }
        other => panic!("unexpected relayed frame: {other:?}"),
    }
}

#[tokio::test]
async fn surface_connections_can_use_broker_assigned_peer_ids() {
    let address = spawn_app().await;
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );
    let surface_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-2", u64::MAX),
    );

    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay should connect");
    let _welcome = next_server_message(&mut relay).await;

    let (mut surface, _) = connect_async(&surface_url)
        .await
        .expect("surface should connect");
    let welcome = next_server_message(&mut surface).await;
    let assigned_peer_id = match welcome {
        ServerMessage::Welcome { peer_id, peers, .. } => {
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].peer_id, "relay-1");
            assert!(peer_id.starts_with("surface-"));
            peer_id
        }
        other => panic!("unexpected welcome frame: {other:?}"),
    };

    let presence = next_server_message(&mut relay).await;
    match presence {
        ServerMessage::Presence { kind, peer, .. } => {
            assert_eq!(kind, protocol::PresenceKind::Joined);
            assert_eq!(peer.peer_id, assigned_peer_id);
        }
        other => panic!("unexpected presence frame: {other:?}"),
    }
}

#[tokio::test]
async fn duplicate_peers_get_error_frame() {
    let address = spawn_app().await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        Some("dup-1"),
        JoinTicketClaims::pairing_surface_join("room-a", "pair-3", u64::MAX),
    );

    let (_first, _) = connect_async(&url)
        .await
        .expect("first peer should connect");
    let (mut duplicate, _) = connect_async(&url).await.expect("duplicate should connect");

    let error = next_server_message(&mut duplicate).await;
    match error {
        ServerMessage::Error { code, .. } => assert_eq!(code, "join_rejected"),
        other => panic!("unexpected error frame: {other:?}"),
    }
}

#[tokio::test]
async fn missing_join_ticket_gets_error_frame() {
    let address = spawn_app().await;
    let url = format!("ws://{address}/ws/room-a?role=surface");

    let (mut socket, _) = connect_async(&url).await.expect("socket should connect");
    let error = next_server_message(&mut socket).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "join_rejected");
            assert!(message.contains("join_ticket"));
        }
        other => panic!("unexpected response: {other:?}"),
    }
}

#[tokio::test]
async fn expired_join_ticket_gets_error_frame() {
    let address = spawn_app().await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-expired", 1),
    );

    let (mut socket, _) = connect_async(&url).await.expect("socket should connect");
    let error = next_server_message(&mut socket).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "join_rejected");
            assert!(message.contains("expired"));
        }
        other => panic!("unexpected response: {other:?}"),
    }
}

#[tokio::test]
async fn device_join_ticket_can_reconnect() {
    let address = spawn_app().await;
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );
    let surface_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::device_surface_join("room-a", "device-1", None),
    );

    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay should connect");
    let _welcome = next_server_message(&mut relay).await;

    let (mut first_surface, _) = connect_async(&surface_url)
        .await
        .expect("first surface should connect");
    let _welcome = next_server_message(&mut first_surface).await;
    first_surface
        .close(None)
        .await
        .expect("surface should close");
    let _left = next_server_message(&mut relay).await;

    let (mut second_surface, _) = connect_async(&surface_url)
        .await
        .expect("second surface should connect");
    let welcome = next_server_message(&mut second_surface).await;
    match welcome {
        ServerMessage::Welcome { peer_id, peers, .. } => {
            assert!(peer_id.starts_with("surface-"));
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].peer_id, "relay-1");
        }
        other => panic!("unexpected welcome frame: {other:?}"),
    }
}

#[tokio::test]
async fn health_route_reports_ok() {
    let address = spawn_app().await;
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .expect("tcp stream should connect");
    stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .expect("request should send");

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .expect("response should read");
    let response = String::from_utf8(response).expect("response should be utf8");
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .expect("response should contain body");
    assert!(headers.starts_with("HTTP/1.1 200"));
    let parsed: HealthResponse =
        serde_json::from_str(body.trim()).expect("health body should parse");
    assert_eq!(parsed.status, "ok");
    assert_eq!(parsed.service, "relay-broker");
    assert_eq!(parsed.broker_auth_mode, "self_hosted");
    assert!(parsed.join_auth_ready);
    assert!(parsed.message.is_none());
}

#[tokio::test]
async fn public_auth_plane_health_reports_ready() {
    assert_eq!(BrokerAuthMode::PublicControlPlane.as_str(), "public");

    let address = spawn_public_mode_app().await;
    let response = http_get(address, "/api/health").await;

    assert!(response.contains("200 OK"));
    let (_, body) = response
        .split_once("\r\n\r\n")
        .expect("response should contain body");
    let parsed: HealthResponse =
        serde_json::from_str(body.trim()).expect("health body should parse");
    assert_eq!(parsed.status, "ok");
    assert_eq!(parsed.broker_auth_mode, "public");
    assert!(parsed.join_auth_ready);
    assert!(parsed.message.is_none());
}

#[tokio::test]
async fn public_relay_ws_token_can_join_broker() {
    let address = spawn_public_mode_app().await;
    let relay_token: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        "relay-refresh-1",
        &RelayWsTokenRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            relay_peer_id: "relay-1".to_string(),
        },
    )
    .await;

    assert_eq!(relay_token.relay_id, "relay-1");
    assert_eq!(relay_token.broker_room_id, "room-a");

    let url = format!(
        "ws://{address}/ws/room-a?role=relay&peer_id=relay-1&join_ticket={}",
        relay_token.relay_ws_token
    );
    let (mut socket, _) = connect_async(&url).await.expect("relay should connect");
    let welcome = next_server_message(&mut socket).await;
    match welcome {
        ServerMessage::Welcome { peer_id, .. } => assert_eq!(peer_id, "relay-1"),
        other => panic!("unexpected response: {other:?}"),
    }
}

#[tokio::test]
async fn public_pairing_and_device_tokens_work_end_to_end() {
    let address = spawn_public_mode_app().await;

    let relay_token: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        "relay-refresh-1",
        &RelayWsTokenRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            relay_peer_id: "relay-1".to_string(),
        },
    )
    .await;
    let relay_url = format!(
        "ws://{address}/ws/room-a?role=relay&peer_id=relay-1&join_ticket={}",
        relay_token.relay_ws_token
    );
    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay should connect");
    let _welcome = next_server_message(&mut relay).await;

    let pairing_token: PairingWsTokenResponse = public_post(
        address,
        "/api/public/pairing/ws-token",
        "relay-refresh-1",
        &PairingWsTokenRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            pairing_id: "pair-1".to_string(),
            expires_at: u64::MAX - 1,
        },
    )
    .await;
    let pairing_url = format!(
        "ws://{address}/ws/room-a?role=surface&join_ticket={}",
        pairing_token.pairing_join_ticket
    );
    let (mut pairing_surface, _) = connect_async(&pairing_url)
        .await
        .expect("pairing surface should connect");
    let _welcome = next_server_message(&mut pairing_surface).await;
    pairing_surface
        .close(None)
        .await
        .expect("pairing surface should close");
    let _left = next_server_message(&mut relay).await;

    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-1".to_string(),
        },
    )
    .await;
    assert_eq!(device_grant.device_id, "device-1");

    let first_device_url = format!(
        "ws://{address}/ws/room-a?role=surface&join_ticket={}",
        device_grant.device_ws_token
    );
    let (mut device_surface, _) = connect_async(&first_device_url)
        .await
        .expect("device surface should connect");
    let _welcome = next_server_message(&mut device_surface).await;
    device_surface
        .close(None)
        .await
        .expect("device surface should close");
    let _left = next_server_message(&mut relay).await;

    let refreshed: DeviceWsTokenResponse = reqwest::Client::new()
        .post(format!("http://{address}/api/public/device/ws-token"))
        .bearer_auth(&device_grant.device_refresh_token)
        .send()
        .await
        .expect("refresh request should send")
        .error_for_status()
        .expect("refresh should succeed")
        .json()
        .await
        .expect("refresh response should parse");
    assert_eq!(refreshed.device_id, "device-1");

    let second_device_url = format!(
        "ws://{address}/ws/room-a?role=surface&join_ticket={}",
        refreshed.device_ws_token
    );
    let (mut second_surface, _) = connect_async(&second_device_url)
        .await
        .expect("refreshed surface should connect");
    let _welcome = next_server_message(&mut second_surface).await;
    second_surface
        .close(None)
        .await
        .expect("refreshed surface should close");
    let _left = next_server_message(&mut relay).await;

    let revoke: DeviceGrantRevokeResponse = public_post(
        address,
        "/api/public/devices/device-1/revoke",
        "relay-refresh-1",
        &DeviceGrantRevokeRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
        },
    )
    .await;
    assert!(revoke.revoked);

    let error_body = public_post_expect_status(
        address,
        "/api/public/device/ws-token",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
        reqwest::StatusCode::UNAUTHORIZED,
    )
    .await;
    assert!(error_body.contains("invalid"));
}

#[tokio::test]
async fn public_bulk_revoke_keeps_selected_device() {
    let address = spawn_public_mode_app().await;

    let _keep: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "keep-me".to_string(),
        },
    )
    .await;
    let revoked: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "revoke-me".to_string(),
        },
    )
    .await;

    let response: DeviceGrantBulkRevokeResponse = public_post(
        address,
        "/api/public/devices/revoke-others",
        "relay-refresh-1",
        &DeviceGrantBulkRevokeRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            keep_device_id: "keep-me".to_string(),
        },
    )
    .await;
    assert_eq!(response.kept_device_id, "keep-me");
    assert_eq!(response.revoked_device_ids, vec!["revoke-me".to_string()]);

    let error_body = public_post_expect_status(
        address,
        "/api/public/device/ws-token",
        &revoked.device_refresh_token,
        &serde_json::json!({}),
        reqwest::StatusCode::UNAUTHORIZED,
    )
    .await;
    assert!(error_body.contains("invalid"));
}
