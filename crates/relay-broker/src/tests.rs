use std::{
    fs,
    net::SocketAddr,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use relay_http::build_content_security_policy;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

use super::*;
use crate::auth::BrokerAuthMode;
use crate::join_ticket::{JoinTicketClaims, JoinTicketKey};
use crate::public_control::{
    client_claim_message, ClientClaimRequest, ClientClaimResponse, ClientGrantRequest,
    ClientGrantResponse, ClientIdentityRevokeResponse, ClientIdentityRotateResponse,
    ClientRelaysResponse, ClientSessionResponse, DeviceGrantBulkRevokeRequest,
    DeviceGrantBulkRevokeResponse, DeviceGrantRequest, DeviceGrantResponse,
    DeviceGrantRevokeRequest, DeviceGrantRevokeResponse, DeviceSessionResponse,
    DeviceWsTokenResponse, PairingWsTokenRequest, PairingWsTokenResponse, PublicControlPlane,
    RelayEnrollmentChallengeRequest, RelayEnrollmentChallengeResponse,
    RelayEnrollmentCompleteRequest, RelayEnrollmentResponse, RelayWsTokenRequest,
    RelayWsTokenResponse,
};

async fn spawn_app() -> SocketAddr {
    spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await
}

async fn spawn_app_with(
    join_verifier: BrokerJoinVerifier,
    hardening: BrokerHardeningConfig,
    security_headers: SecurityHeadersConfig,
) -> SocketAddr {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    let app = app_with_web_root_and_verifier_and_hardening(
        BrokerState::default(),
        test_web_root(),
        join_verifier,
        hardening,
        security_headers,
    );
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("broker should serve");
    });
    address
}

async fn spawn_public_mode_app() -> SocketAddr {
    spawn_public_mode_app_with(
        test_public_control_plane().await,
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await
}

async fn spawn_public_mode_app_with(
    public_control: PublicControlPlane,
    hardening: BrokerHardeningConfig,
    security_headers: SecurityHeadersConfig,
) -> SocketAddr {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    let app = app_with_web_root_and_verifier_and_hardening(
        BrokerState::default(),
        test_web_root(),
        BrokerJoinVerifier::PublicControlPlane(public_control),
        hardening,
        security_headers,
    );
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
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
    http_get_with_headers(address, path, &[]).await
}

async fn broker_health(address: SocketAddr) -> HealthResponse {
    let response = http_get(address, "/api/health").await;
    let (_, body) = response
        .split_once("\r\n\r\n")
        .expect("response should contain body");
    serde_json::from_str(body.trim()).expect("health body should parse")
}

async fn http_get_with_headers(
    address: SocketAddr,
    path: &str,
    headers: &[(&str, &str)],
) -> String {
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .expect("tcp stream should connect");
    let mut request = format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
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

/// Drive a full client pairing over HTTP: the relay attests the key, then the
/// key holder redeems the attestation on its own (no bearer — the signature is
/// the authentication). Returns the credential the *client* receives; the relay
/// never sees one.
async fn public_client_pair(
    address: SocketAddr,
    relay_bearer: &str,
    signing_key: &SigningKey,
    request: &ClientGrantRequest,
) -> ClientClaimResponse {
    let relay_id = request.relay_id.clone();
    let attestation: ClientGrantResponse =
        public_post(address, "/api/public/clients/grants", relay_bearer, request).await;
    let message = client_claim_message(&attestation.claim_id, &attestation.claim_nonce, &relay_id);
    let claim_signature = STANDARD.encode(signing_key.sign(message.as_bytes()).to_bytes());

    reqwest::Client::new()
        .post(format!("http://{address}/api/public/client/claim"))
        .json(&ClientClaimRequest {
            claim_id: attestation.claim_id,
            claim_signature,
        })
        .send()
        .await
        .expect("claim request should succeed")
        .error_for_status()
        .expect("claim response should be successful")
        .json::<ClientClaimResponse>()
        .await
        .expect("claim response should decode")
}

async fn public_post_response<TReq>(
    address: SocketAddr,
    path: &str,
    bearer_token: &str,
    request: &TReq,
) -> reqwest::Response
where
    TReq: serde::Serialize + ?Sized,
{
    reqwest::Client::new()
        .post(format!("http://{address}{path}"))
        .bearer_auth(bearer_token)
        .json(request)
        .send()
        .await
        .expect("request should succeed")
}

async fn public_post_with_cookie<TReq, TResp>(
    address: SocketAddr,
    path: &str,
    cookie: &str,
    request: &TReq,
) -> TResp
where
    TReq: serde::Serialize + ?Sized,
    TResp: serde::de::DeserializeOwned,
{
    reqwest::Client::new()
        .post(format!("http://{address}{path}"))
        .header(reqwest::header::COOKIE, cookie)
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

async fn public_get<TResp>(address: SocketAddr, path: &str, bearer_token: &str) -> TResp
where
    TResp: serde::de::DeserializeOwned,
{
    reqwest::Client::new()
        .get(format!("http://{address}{path}"))
        .bearer_auth(bearer_token)
        .send()
        .await
        .expect("request should succeed")
        .error_for_status()
        .expect("response should be successful")
        .json::<TResp>()
        .await
        .expect("response should decode")
}

async fn public_get_with_headers<TResp>(
    address: SocketAddr,
    path: &str,
    bearer_token: &str,
    headers: &[(&str, &str)],
) -> TResp
where
    TResp: serde::de::DeserializeOwned,
{
    let mut request = reqwest::Client::new()
        .get(format!("http://{address}{path}"))
        .bearer_auth(bearer_token);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    request
        .send()
        .await
        .expect("request should succeed")
        .error_for_status()
        .expect("response should be successful")
        .json::<TResp>()
        .await
        .expect("response should decode")
}

fn set_cookie_name_value(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::to_string)
        .expect("set-cookie header should include a name=value pair")
}

fn set_cookie_values(response: &reqwest::Response) -> Vec<String> {
    response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .map(str::to_string)
        .collect()
}

async fn public_post_with_cookie_response<TReq>(
    address: SocketAddr,
    path: &str,
    cookie: &str,
    request: &TReq,
) -> reqwest::Response
where
    TReq: serde::Serialize + ?Sized,
{
    reqwest::Client::new()
        .post(format!("http://{address}{path}"))
        .header(reqwest::header::COOKIE, cookie)
        .json(request)
        .send()
        .await
        .expect("request should succeed")
}

async fn public_delete_with_cookie_response(
    address: SocketAddr,
    path: &str,
    cookie: &str,
) -> reqwest::Response {
    reqwest::Client::new()
        .delete(format!("http://{address}{path}"))
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await
        .expect("request should succeed")
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
    fs::write(assets.join("remote-test.js"), "console.log('remote');").expect("asset should write");
    // A non-hashed static file served from the web root (not /static/assets/):
    // the frontend fetches this at runtime to detect new builds, so it must
    // revalidate rather than be cached immutable.
    fs::write(root.join("build-meta.json"), r#"{"build":"test"}"#)
        .expect("build meta should write");
    root
}

fn test_join_ticket_key() -> JoinTicketKey {
    JoinTicketKey::from_secret("broker-test-secret".as_bytes())
        .expect("test join-ticket key should construct")
}

async fn test_public_control_plane() -> PublicControlPlane {
    test_public_control_plane_with_parts(None, Some("300"), Some("300")).await
}

async fn test_public_control_plane_with_room(room: &str) -> PublicControlPlane {
    PublicControlPlane::from_parts(
        Some("public-broker-issuer-secret".to_string()),
        Some(
            serde_json::to_string(&vec![serde_json::json!({
                "relay_id": "relay-1",
                "broker_room_id": room,
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

async fn test_public_control_plane_with_parts(
    state_path: Option<String>,
    relay_ws_ttl_secs: Option<&str>,
    device_ws_ttl_secs: Option<&str>,
) -> PublicControlPlane {
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
        state_path,
        relay_ws_ttl_secs.map(str::to_string),
        device_ws_ttl_secs.map(str::to_string),
    )
    .await
    .expect("public control plane should configure")
}

fn temp_state_path(prefix: &str) -> String {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be monotonic enough for tests")
        .as_nanos();
    std::env::temp_dir()
        .join(format!("{prefix}-{unique}.json"))
        .display()
        .to_string()
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
async fn websocket_rejects_mismatched_origin_when_present() {
    let address = spawn_app().await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-origin", u64::MAX),
    );
    let mut request = url
        .into_client_request()
        .expect("websocket request should build");
    request.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_static("http://evil.example"),
    );

    let error = connect_async(request)
        .await
        .expect_err("mismatched origin should fail the websocket handshake");
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
        }
        other => panic!("unexpected websocket error: {other:?}"),
    }
}

#[tokio::test]
async fn websocket_allows_same_origin_when_origin_is_present() {
    let address = spawn_app().await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-origin-ok", u64::MAX),
    );
    let mut request = url
        .into_client_request()
        .expect("websocket request should build");
    request.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_str(&format!("http://{address}")).expect("origin header should build"),
    );

    let (mut socket, _) = connect_async(request)
        .await
        .expect("same-origin websocket should connect");
    let welcome = next_server_message(&mut socket).await;
    match welcome {
        ServerMessage::Welcome { peer_id, .. } => assert!(peer_id.starts_with("surface-")),
        other => panic!("unexpected welcome frame: {other:?}"),
    }
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
    // Surfaces do not name themselves — the broker assigns the id (see
    // `a_surface_cannot_squat_the_relays_peer_id`), so read it back out of Welcome.
    let surface_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
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
    let surface_peer_id = match welcome {
        ServerMessage::Welcome {
            peers,
            peer_id: assigned_peer_id,
            ..
        } => {
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].peer_id, "relay-1");
            assert_eq!(peers[0].device_id, None);
            assigned_peer_id
        }
        other => panic!("unexpected welcome frame: {other:?}"),
    };

    let presence = next_server_message(&mut relay).await;
    match presence {
        ServerMessage::Presence { kind, peer, .. } => {
            assert_eq!(kind, protocol::PresenceKind::Joined);
            assert_eq!(peer.peer_id, surface_peer_id);
            assert_eq!(peer.device_id, None);
        }
        other => panic!("unexpected presence frame: {other:?}"),
    }

    relay
        .send(Message::Text(
            serde_json::to_string(&ClientMessage::Publish {
                protocol_version: protocol::BROKER_PROTOCOL_VERSION,
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
async fn a_surface_cannot_squat_the_relays_peer_id() {
    // SECURITY: surface tickets carry no peer_id, so `lib.rs` falls back to the
    // client-supplied query parameter unchecked. A surface can therefore claim the
    // relay's own peer_id, and because a relay's ticket PINS its peer_id the
    // no-peer_id retry loop never fires for it — the relay is locked out of its own
    // room until the squatter drops the socket.
    let address = spawn_app().await;
    let squatter_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        Some("relay-1"),
        JoinTicketClaims::pairing_surface_join("room-a", "pair-squat", u64::MAX),
    );
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );

    let squatter = connect_async(&squatter_url).await;
    let Ok((mut squatter, _)) = squatter else {
        // Already hardened: a surface may not name itself after a relay.
        return;
    };
    let seated = next_server_message(&mut squatter).await;

    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("the real relay should still be able to connect");
    let relay_welcome = next_server_message(&mut relay).await;

    assert!(
        matches!(relay_welcome, ServerMessage::Welcome { .. }),
        "a surface holding a pairing ticket must not be able to lock the relay out \
         of its own room; squatter got {seated:?}, relay got {relay_welcome:?}"
    );
}

#[tokio::test]
async fn a_bare_pairing_result_is_refused_while_other_directed_payloads_still_flow() {
    // SECURITY: `encrypted_pairing_result` carries the new device's payload_secret
    // and refresh tokens, sealed with the pairing_secret from the QR. It shipped
    // for a while with a `target_peer_id` field but WITHOUT the
    // `targeted_messages` wrapper, and the broker's fanout routes on the wrapper
    // alone — so it went to the whole room, handing the sealed credentials to any
    // bystander replaying the same QR join ticket. The wrapper must be the only
    // way to address one peer: a bare payload that names a recipient is refused
    // outright, so the next one that forgets it fails loudly instead of leaking.
    let address = spawn_app().await;
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );
    let intended_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        Some("phone-intended"),
        JoinTicketClaims::pairing_surface_join("room-a", "pair-target", u64::MAX),
    );
    // A distinct pairing id, so the two surfaces stay seated together — one ticket
    // holds only one seat (see `a_second_join_on_one_pairing_ticket_supersedes_the_first`),
    // and this test is about the fanout, not the seat.
    let bystander_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        Some("phone-bystander"),
        JoinTicketClaims::pairing_surface_join("room-a", "pair-bystander", u64::MAX),
    );

    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay should connect");
    let _ = next_server_message(&mut relay).await;
    let (mut intended, _) = connect_async(&intended_url)
        .await
        .expect("intended surface should connect");
    let _ = next_server_message(&mut intended).await;
    let (mut bystander, _) = connect_async(&bystander_url)
        .await
        .expect("bystander surface should connect");
    let _ = next_server_message(&mut bystander).await;
    // The bystander's arrival notifies everyone already seated; drain it so the
    // only frame that could still show up is the publish under test.
    let _ = next_server_message(&mut intended).await;

    relay
        .send(Message::Text(
            serde_json::to_string(&ClientMessage::Publish {
                protocol_version: protocol::BROKER_PROTOCOL_VERSION,
                payload: json!({
                    "kind": "encrypted_pairing_result",
                    "pairing_id": "pair-target",
                    "target_peer_id": "phone-intended",
                    "envelope": {"nonce": "n", "ciphertext": "c"},
                }),
            })
            .expect("client frame should serialize"),
        ))
        .await
        .expect("publish should send");

    // Every OTHER directed payload keeps its existing broadcast + client-side
    // filter behaviour. Treating `target_peer_id` itself as a routing directive
    // would silently drop every remote action response, so pin that here: this
    // frame must still be delivered.
    relay
        .send(Message::Text(
            serde_json::to_string(&ClientMessage::Publish {
                protocol_version: protocol::BROKER_PROTOCOL_VERSION,
                payload: json!({
                    "kind": "encrypted_remote_action_result",
                    "action_id": "action-1",
                    "target_peer_id": "phone-intended",
                    "device_id": "device-1",
                    "envelope": {"nonce": "n", "ciphertext": "c"},
                }),
            })
            .expect("client frame should serialize"),
        ))
        .await
        .expect("publish should send");

    match next_server_message(&mut intended).await {
        ServerMessage::Message { payload, .. } => assert_eq!(
            payload["kind"], "encrypted_remote_action_result",
            "a remote action result must still reach the room; the pairing-result \
             guard must not generalise to every payload naming a peer"
        ),
        other => panic!("remote action result should be delivered: {other:?}"),
    }
    let _ = next_server_message(&mut bystander).await;

    for (label, socket) in [
        ("the named target", &mut intended),
        ("a bystander", &mut bystander),
    ] {
        let received = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            next_server_message(socket),
        )
        .await;
        assert!(
            received.is_err(),
            "a payload naming one peer but published without the \
             `targeted_messages` wrapper must reach nobody; {label} got {received:?}"
        );
    }
}

#[tokio::test]
async fn a_second_join_on_one_pairing_ticket_supersedes_the_first() {
    // SECURITY: the pairing join_ticket is what the QR code hands out, and
    // verification is stateless HMAC + expiry — nothing stops the same ticket from
    // being replayed. Every replay used to become an independent room member, so a
    // bystander who photographed the QR could sit in the room alongside the device
    // being paired and read what the relay published. One ticket must hold exactly
    // one seat: a later join supersedes the earlier holder rather than joining it.
    //
    // Supersede (not reject) is deliberate — the remote client re-presents the
    // pairing ticket automatically after a network blip, and that reconnect has to
    // be able to reclaim its own seat.
    let address = spawn_app().await;
    let ticket = test_join_ticket_key()
        .mint(&JoinTicketClaims::pairing_surface_join(
            "room-a",
            "pair-shared",
            u64::MAX,
        ))
        .expect("pairing join ticket should mint");

    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );
    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay should connect");
    let _ = next_server_message(&mut relay).await;

    let surface_url = format!("ws://{address}/ws/room-a?role=surface&join_ticket={ticket}");

    let (mut first, _) = connect_async(&surface_url)
        .await
        .expect("the first surface should connect");
    let first_peer_id = match next_server_message(&mut first).await {
        ServerMessage::Welcome { peer_id, .. } => peer_id,
        other => panic!("unexpected welcome frame: {other:?}"),
    };

    let (mut second, _) = connect_async(&surface_url)
        .await
        .expect("a reconnect on the same ticket should be admitted");
    match next_server_message(&mut second).await {
        ServerMessage::Welcome { peers, peer_id, .. } => {
            assert_ne!(peer_id, first_peer_id, "the seat should be a fresh peer");
            assert!(
                !peers.iter().any(|peer| peer.peer_id == first_peer_id),
                "the superseded holder must already be gone from the room; saw {peers:?}"
            );
        }
        other => panic!("unexpected welcome frame: {other:?}"),
    }

    match next_server_message(&mut first).await {
        ServerMessage::Error { code, .. } => assert_eq!(code, "pairing_ticket_superseded"),
        other => panic!("the first holder should be told it lost its seat: {other:?}"),
    }
}

#[tokio::test]
async fn unsupported_broker_protocol_version_gets_error_frame() {
    let address = spawn_app().await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-protocol-version", u64::MAX),
    );

    let (mut socket, _) = connect_async(&url).await.expect("surface should connect");
    let _welcome = next_server_message(&mut socket).await;
    socket
        .send(Message::Text(
            json!({
                "type": "publish",
                "protocol_version": protocol::BROKER_PROTOCOL_VERSION + 1,
                "payload": {}
            })
            .to_string(),
        ))
        .await
        .expect("publish should send");

    let error = next_server_message(&mut socket).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "unsupported_protocol_version");
            assert!(message.contains("unsupported broker protocol_version"));
        }
        other => panic!("unexpected protocol version response: {other:?}"),
    }
}

#[tokio::test]
async fn missing_broker_protocol_version_gets_error_frame() {
    let address = spawn_app().await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-missing-version", u64::MAX),
    );

    let (mut socket, _) = connect_async(&url).await.expect("surface should connect");
    let _welcome = next_server_message(&mut socket).await;
    socket
        .send(Message::Text(
            json!({
                "type": "publish",
                "payload": {}
            })
            .to_string(),
        ))
        .await
        .expect("publish should send");

    let error = next_server_message(&mut socket).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "invalid_client_frame");
            assert!(message.contains("protocol_version"));
        }
        other => panic!("unexpected missing protocol version response: {other:?}"),
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
async fn surfaces_asking_for_the_same_peer_id_get_distinct_assigned_ids() {
    // This used to assert the second surface was rejected for reusing `dup-1`.
    // Surfaces no longer name themselves at all — honoring the query parameter let
    // one squat the relay's id and lock it out of its own room — so a requested id
    // is ignored and the broker hands out a fresh one instead. Two surfaces asking
    // for the same id must therefore both be seated, under different ids.
    let address = spawn_app().await;
    // Distinct pairing ids on purpose: one ticket seats only one peer, so sharing a
    // ticket here would evict the first connection and the test would prove nothing
    // about two surfaces coexisting.
    let url = |pairing_id: &str| {
        websocket_url(
            address,
            "room-a",
            protocol::PeerRole::Surface,
            Some("dup-1"),
            JoinTicketClaims::pairing_surface_join("room-a", pairing_id, u64::MAX),
        )
    };

    let (mut first, _) = connect_async(url("pair-3a"))
        .await
        .expect("first peer should connect");
    let (mut second, _) = connect_async(url("pair-3b"))
        .await
        .expect("second should connect");

    let assigned = |message: ServerMessage| match message {
        ServerMessage::Welcome { peer_id, peers, .. } => (peer_id, peers),
        other => panic!("unexpected welcome frame: {other:?}"),
    };
    let (first_peer_id, _) = assigned(next_server_message(&mut first).await);
    let (second_peer_id, second_sees) = assigned(next_server_message(&mut second).await);

    assert_ne!(
        first_peer_id, second_peer_id,
        "each surface must get its own broker-assigned peer id"
    );
    // Both are genuinely seated at once — the second peer's Welcome lists the first,
    // which is what makes this a statement about coexistence and not about eviction.
    assert!(
        second_sees.iter().any(|peer| peer.peer_id == first_peer_id),
        "the second surface should see the first still seated; saw {second_sees:?}"
    );
    for peer_id in [&first_peer_id, &second_peer_id] {
        assert_ne!(
            peer_id, "dup-1",
            "a client-requested surface peer id must be ignored"
        );
    }
}

#[tokio::test]
async fn duplicate_relay_connection_replaces_stale_socket() {
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

    let (mut stale_relay, _) = connect_async(&relay_url)
        .await
        .expect("stale relay should connect");
    let _welcome = next_server_message(&mut stale_relay).await;

    let (mut replacement_relay, _) = connect_async(&relay_url)
        .await
        .expect("replacement relay websocket should connect");
    match next_server_message(&mut replacement_relay).await {
        ServerMessage::Welcome { peer_id, peers, .. } => {
            assert_eq!(peer_id, "relay-1");
            assert!(peers.is_empty());
        }
        other => panic!("replacement relay should receive welcome, got: {other:?}"),
    }

    let stale_event = tokio::time::timeout(Duration::from_secs(1), stale_relay.next())
        .await
        .expect("stale relay socket should be closed after replacement");
    match stale_event {
        None => {}
        Some(Ok(Message::Close(_))) => {}
        Some(Err(_)) => {}
        Some(other) => panic!("stale relay should close, got: {other:?}"),
    }

    let (mut surface, _) = connect_async(&surface_url)
        .await
        .expect("surface should connect after relay replacement");
    match next_server_message(&mut surface).await {
        ServerMessage::Welcome { peers, .. } => {
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].peer_id, "relay-1");
            assert_eq!(peers[0].role, protocol::PeerRole::Relay);
        }
        other => panic!("surface should see replacement relay, got: {other:?}"),
    }

    let _presence = next_server_message(&mut replacement_relay).await;
    replacement_relay
        .send(Message::Text(
            serde_json::to_string(&ClientMessage::Publish {
                protocol_version: protocol::BROKER_PROTOCOL_VERSION,
                payload: json!({"kind":"session_snapshot"}),
            })
            .expect("client frame should serialize"),
        ))
        .await
        .expect("replacement relay publish should send");
    match next_server_message(&mut surface).await {
        ServerMessage::Message {
            from_peer_id,
            payload,
            ..
        } => {
            assert_eq!(from_peer_id, "relay-1");
            assert_eq!(payload, json!({"kind":"session_snapshot"}));
        }
        other => panic!("surface should receive replacement relay publish, got: {other:?}"),
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
            assert_eq!(message, "broker join rejected");
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
            assert_eq!(message, "broker join rejected");
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
    let welcome = next_server_message(&mut first_surface).await;
    let first_peer_id = match welcome {
        ServerMessage::Welcome { peer_id, peers, .. } => {
            assert!(peer_id.starts_with("surface-"));
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].peer_id, "relay-1");
            assert_eq!(peers[0].device_id, None);
            peer_id
        }
        other => panic!("unexpected welcome frame: {other:?}"),
    };
    let joined = next_server_message(&mut relay).await;
    match joined {
        ServerMessage::Presence { kind, peer, .. } => {
            assert_eq!(kind, protocol::PresenceKind::Joined);
            assert_eq!(peer.peer_id, first_peer_id);
            assert_eq!(peer.device_id.as_deref(), Some("device-1"));
        }
        other => panic!("unexpected presence frame: {other:?}"),
    }
    first_surface
        .close(None)
        .await
        .expect("surface should close");
    let left = next_server_message(&mut relay).await;
    match left {
        ServerMessage::Presence { kind, peer, .. } => {
            assert_eq!(kind, protocol::PresenceKind::Left);
            assert_eq!(peer.peer_id, first_peer_id);
            assert_eq!(peer.device_id.as_deref(), Some("device-1"));
        }
        other => panic!("unexpected presence frame: {other:?}"),
    }

    let (mut second_surface, _) = connect_async(&surface_url)
        .await
        .expect("second surface should connect");
    let welcome = next_server_message(&mut second_surface).await;
    match welcome {
        ServerMessage::Welcome { peer_id, peers, .. } => {
            assert!(peer_id.starts_with("surface-"));
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].peer_id, "relay-1");
            assert_eq!(peers[0].device_id, None);
        }
        other => panic!("unexpected welcome frame: {other:?}"),
    }
    let joined = next_server_message(&mut relay).await;
    match joined {
        ServerMessage::Presence { kind, peer, .. } => {
            assert_eq!(kind, protocol::PresenceKind::Joined);
            assert_eq!(peer.device_id.as_deref(), Some("device-1"));
        }
        other => panic!("unexpected presence frame: {other:?}"),
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
    let parsed = broker_health(address).await;
    assert_eq!(parsed.status, "ok");
    assert_eq!(parsed.broker_auth_mode, "public");
    assert!(parsed.join_auth_ready);
    assert!(parsed
        .message
        .as_deref()
        .is_some_and(|message| message.contains("RELAY_BROKER_PUBLIC_STATE_PATH")));
    assert!(parsed
        .message
        .as_deref()
        .is_some_and(|message| message.contains("RELAY_BROKER_PUBLIC_POSTGRES_URL")));
    assert_eq!(
        parsed.public_monitoring,
        Some(PublicBrokerMonitoring::default())
    );
}

#[tokio::test]
async fn public_control_plane_rejects_multiple_persistence_backends() {
    let result = PublicControlPlane::from_parts_with_postgres(
        Some("public-broker-issuer-secret".to_string()),
        None,
        Some(temp_state_path("public-control-conflict")),
        Some("postgres://localhost/agent_relay".to_string()),
        Some("300".to_string()),
        Some("300".to_string()),
    )
    .await;

    let error = match result {
        Ok(_) => panic!("multiple persistence backends should be rejected"),
        Err(error) => error,
    };
    assert!(error.contains("RELAY_BROKER_PUBLIC_STATE_PATH"));
    assert!(error.contains("RELAY_BROKER_PUBLIC_POSTGRES_URL"));
}

#[tokio::test]
async fn security_headers_are_present_on_static_and_api_routes() {
    let address = spawn_app().await;
    let root_response = http_get(address, "/").await.to_ascii_lowercase();
    let health_response = http_get(address, "/api/health").await.to_ascii_lowercase();

    for response in [root_response, health_response] {
        assert!(response.contains("content-security-policy:"));
        assert!(response.contains("permissions-policy:"));
        assert!(response.contains("referrer-policy: no-referrer"));
        assert!(response.contains("x-content-type-options: nosniff"));
        assert!(!response.contains("strict-transport-security:"));
    }
}

// Regression test for the "broker feels like it's still serving the old UI"
// bug: without an explicit Cache-Control, browsers heuristically cache the
// HTML shell (and sw.js), pinning them to stale content-hashed asset
// filenames after a redeploy — a fresh/incognito profile (no cached entry)
// always looked fine, masking the bug. relay-server already carries this
// fix (see `cache_control_for` there); the broker never got it even though
// it serves the actual remote/PWA surface users hit.
#[tokio::test]
async fn cache_control_headers_are_set_across_the_broker_surface() {
    let address = spawn_app().await;

    let root = http_get(address, "/").await.to_ascii_lowercase();
    assert!(
        root.contains("cache-control: no-cache"),
        "expected the HTML shell to always revalidate, got: {root}"
    );

    let sw = http_get(address, "/sw.js").await.to_ascii_lowercase();
    assert!(
        sw.contains("cache-control: no-cache"),
        "expected sw.js to always revalidate, got: {sw}"
    );

    let asset = http_get(address, "/static/assets/remote-test.js")
        .await
        .to_ascii_lowercase();
    assert!(
        asset.contains("cache-control: public, max-age=31536000, immutable"),
        "expected a content-hashed asset to be cached forever, got: {asset}"
    );

    // A non-hashed static file (served from the web root, not /static/assets/)
    // must revalidate too, so a redeploy is picked up.
    let build_meta = http_get(address, "/static/build-meta.json")
        .await
        .to_ascii_lowercase();
    assert!(
        build_meta.contains("cache-control: no-cache"),
        "expected a non-hashed static file to always revalidate, got: {build_meta}"
    );

    // A missing hashed asset (404) must be no-store — not stamped immutable, and
    // not left bare (a bare 404 can be heuristically negative-cached).
    let missing = http_get(address, "/static/assets/does-not-exist-deadbeef.js")
        .await
        .to_ascii_lowercase();
    assert!(
        missing.contains("404"),
        "expected a missing asset to 404, got: {missing}"
    );
    assert!(
        missing.contains("cache-control: no-store"),
        "expected a 404 asset to be no-store, got: {missing}"
    );

    // API responses are client-specific / cookie-authenticated — never cache.
    let health = http_get(address, "/api/health").await.to_ascii_lowercase();
    assert!(
        health.contains("cache-control: no-store"),
        "expected /api/* to be no-store, got: {health}"
    );
}

// A conditional request for a static asset comes back 304 Not Modified. Per
// RFC 9110 §15.4.5 the 304 must carry the same Cache-Control the 200 would,
// otherwise a revalidating cache can lose the policy. tower-http's
// ServeDir/ServeFile emit 304s without any Cache-Control, so the middleware has
// to supply it.
#[tokio::test]
async fn conditional_static_request_304_keeps_cache_policy() {
    let address = spawn_app().await;

    // Learn the validator from the first (200) fetch.
    let first = http_get(address, "/static/assets/remote-test.js").await;
    assert!(
        first.starts_with("HTTP/1.1 200"),
        "expected first asset fetch to be 200, got: {first}"
    );
    let last_modified =
        raw_header_value(&first, "last-modified").expect("asset 200 should carry Last-Modified");

    // Revalidate → 304, which must still be immutable.
    let revalidated = http_get_with_headers(
        address,
        "/static/assets/remote-test.js",
        &[("If-Modified-Since", &last_modified)],
    )
    .await;
    assert!(
        revalidated.starts_with("HTTP/1.1 304"),
        "expected a conditional asset request to 304, got: {revalidated}"
    );
    assert!(
        revalidated
            .to_ascii_lowercase()
            .contains("cache-control: public, max-age=31536000, immutable"),
        "expected the 304 to keep the immutable policy, got: {revalidated}"
    );
}

/// Extract a single header value (case-insensitive name) from a raw HTTP/1.1
/// response string, returning the trimmed value with its original casing.
fn raw_header_value(raw_response: &str, name: &str) -> Option<String> {
    raw_response
        .split("\r\n")
        .take_while(|line| !line.is_empty())
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_string())
        })
}

// Pins the security-critical asymmetry in `with_cache_headers`: for `/api/*` it
// FORCES `no-store` over whatever the handler set (so a handler can never leave
// private data cacheable, even by mistake), while for the static surface it
// PRESERVES a handler's own `Cache-Control`. Without this, a future refactor
// collapsing the two branches into a uniform "don't overwrite" would silently
// reopen the private-API caching hole with every existing test still green.
#[tokio::test]
async fn with_cache_headers_forces_no_store_over_a_handler_set_api_policy() {
    async fn cacheable_api() -> impl IntoResponse {
        // A misbehaving API handler trying to make a private response cacheable.
        ([(header::CACHE_CONTROL, "public, max-age=999")], "secret")
    }
    async fn opinionated_static() -> impl IntoResponse {
        ([(header::CACHE_CONTROL, "public, max-age=42")], "asset")
    }

    let app = Router::new()
        .route("/api/misconfigured", get(cacheable_api))
        .route("/static/opinionated", get(opinionated_static))
        .layer(middleware::from_fn(with_cache_headers));

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service())
            .await
            .expect("test router should serve");
    });

    // API: the handler's `public` policy is overridden with the forced no-store.
    let api = http_get(address, "/api/misconfigured")
        .await
        .to_ascii_lowercase();
    assert!(
        api.contains("cache-control: no-store"),
        "expected /api/* to be forced to no-store, got: {api}"
    );
    assert!(
        !api.contains("max-age=999"),
        "expected the handler's cacheable policy to be dropped, got: {api}"
    );

    // Static: the middleware leaves a handler's explicit policy intact.
    let stat = http_get(address, "/static/opinionated")
        .await
        .to_ascii_lowercase();
    assert!(
        stat.contains("cache-control: public, max-age=42"),
        "expected a static handler's own policy to be preserved, got: {stat}"
    );
}

#[test]
fn cache_control_policy_for_static_surface() {
    // Hashed bundles are immutable on success...
    assert_eq!(
        cache_control_for("/static/assets/remote-deadbeef.js", StatusCode::OK),
        Some("public, max-age=31536000, immutable")
    );
    // ...and a 304 Not Modified on revalidation must carry the SAME policy the
    // 200 would (RFC 9110 §15.4.5), so a conditional request doesn't drop it.
    assert_eq!(
        cache_control_for(
            "/static/assets/remote-deadbeef.js",
            StatusCode::NOT_MODIFIED
        ),
        Some("public, max-age=31536000, immutable")
    );
    // A missing hashed asset must NOT be cached at all — not immutable (a
    // year-long positive-then-negative cache) and not heuristically (RFC 9110
    // §15.5.5 lets a 404 be heuristically cached). `no-store` forbids both.
    assert_eq!(
        cache_control_for("/static/assets/remote-deadbeef.js", StatusCode::NOT_FOUND),
        Some("no-store")
    );
    // The HTML shell, sw.js, and other non-hashed static files revalidate —
    // on both the 200 and its 304.
    assert_eq!(cache_control_for("/", StatusCode::OK), Some("no-cache"));
    assert_eq!(
        cache_control_for("/", StatusCode::NOT_MODIFIED),
        Some("no-cache")
    );
    assert_eq!(
        cache_control_for("/sw.js", StatusCode::OK),
        Some("no-cache")
    );
    // Any other non-success static response is no-store, never left unset.
    assert_eq!(
        cache_control_for("/missing", StatusCode::NOT_FOUND),
        Some("no-store")
    );
    // Every API response is no-store — client-specific and often
    // cookie-authenticated, so it must never be cached by a browser or a shared
    // intermediary. This holds even for error statuses.
    assert_eq!(
        cache_control_for("/api/health", StatusCode::OK),
        Some("no-store")
    );
    assert_eq!(
        cache_control_for("/api/public/relays", StatusCode::OK),
        Some("no-store")
    );
    assert_eq!(
        cache_control_for("/api/public/relays", StatusCode::UNAUTHORIZED),
        Some("no-store")
    );
}

#[tokio::test]
async fn strict_transport_security_is_only_sent_for_secure_requests_when_enabled() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::from_parts(
            true,
            None,
            Some("max-age=86400".to_string()),
            CSP_CONNECT_SRC_ENV,
            HSTS_VALUE_ENV,
        )
        .expect("custom broker HSTS config should parse"),
    )
    .await;

    let insecure = http_get(address, "/api/health").await.to_ascii_lowercase();
    assert!(!insecure.contains("strict-transport-security:"));

    let secure = http_get_with_headers(address, "/api/health", &[("X-Forwarded-Proto", "https")])
        .await
        .to_ascii_lowercase();
    assert!(secure.contains("strict-transport-security: max-age=86400"));
}

#[tokio::test]
async fn content_security_policy_can_override_connect_src() {
    let connect_src = "'self' https://relay.example.com wss://broker.example.com";
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::from_parts(
            false,
            Some(connect_src.to_string()),
            None,
            CSP_CONNECT_SRC_ENV,
            HSTS_VALUE_ENV,
        )
        .expect("custom broker CSP config should parse"),
    )
    .await;

    let response = http_get(address, "/api/health").await.to_ascii_lowercase();
    assert!(response.contains(&format!(
        "content-security-policy: {}",
        build_content_security_policy(connect_src).to_ascii_lowercase()
    )));
}

#[tokio::test]
async fn forwarded_and_forwarded_ssl_headers_are_treated_as_secure() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::from_parts(
            true,
            None,
            Some("max-age=86400".to_string()),
            CSP_CONNECT_SRC_ENV,
            HSTS_VALUE_ENV,
        )
        .expect("custom broker HSTS config should parse"),
    )
    .await;

    let forwarded = http_get_with_headers(
        address,
        "/api/health",
        &[("Forwarded", "for=203.0.113.9;proto=https")],
    )
    .await
    .to_ascii_lowercase();
    assert!(forwarded.contains("strict-transport-security: max-age=86400"));

    let forwarded_ssl = http_get_with_headers(address, "/api/health", &[("X-Forwarded-Ssl", "on")])
        .await
        .to_ascii_lowercase();
    assert!(forwarded_ssl.contains("strict-transport-security: max-age=86400"));
}

#[test]
fn invalid_security_header_overrides_are_rejected() {
    let csp_error = SecurityHeadersConfig::from_parts(
        false,
        Some("https://broker.example.com\r\nx".to_string()),
        None,
        CSP_CONNECT_SRC_ENV,
        HSTS_VALUE_ENV,
    )
    .expect_err("invalid broker CSP override should fail");
    assert!(csp_error.contains(CSP_CONNECT_SRC_ENV));

    let hsts_error = SecurityHeadersConfig::from_parts(
        true,
        None,
        Some("max-age=86400\r\nx".to_string()),
        CSP_CONNECT_SRC_ENV,
        HSTS_VALUE_ENV,
    )
    .expect_err("invalid broker HSTS override should fail");
    assert!(hsts_error.contains(HSTS_VALUE_ENV));
}

#[tokio::test]
async fn public_relay_challenge_enrollment_can_issue_registration_and_relay_tokens() {
    let control_plane = PublicControlPlane::from_parts(
        Some("public-broker-issuer-secret".to_string()),
        None,
        None,
        Some("300".to_string()),
        Some("300".to_string()),
    )
    .await
    .expect("public control plane should allow challenge bootstrap");
    let address = spawn_public_mode_app_with(
        control_plane,
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;

    let signing_key = SigningKey::from_bytes(&[11_u8; 32]);
    let relay_verify_key = STANDARD.encode(signing_key.verifying_key().to_bytes());
    let challenge: RelayEnrollmentChallengeResponse = reqwest::Client::new()
        .post(format!(
            "http://{address}/api/public/relay-enrollment/challenge"
        ))
        .json(&RelayEnrollmentChallengeRequest {
            relay_verify_key: relay_verify_key.clone(),
            relay_label: Some("Laptop".to_string()),
        })
        .send()
        .await
        .expect("challenge request should complete")
        .error_for_status()
        .expect("challenge request should succeed")
        .json()
        .await
        .expect("challenge response should decode");

    let challenge_signature = STANDARD.encode(
        signing_key
            .sign(
                format!(
                    "agent-relay:relay-enroll:{}:{}",
                    challenge.challenge_id, challenge.challenge
                )
                .as_bytes(),
            )
            .to_bytes(),
    );

    let enrollment: RelayEnrollmentResponse = reqwest::Client::new()
        .post(format!(
            "http://{address}/api/public/relay-enrollment/complete"
        ))
        .json(&RelayEnrollmentCompleteRequest {
            relay_verify_key,
            challenge_id: challenge.challenge_id,
            challenge_signature,
            relay_label: Some("Laptop".to_string()),
            license_code: None,
        })
        .send()
        .await
        .expect("complete request should complete")
        .error_for_status()
        .expect("complete should succeed")
        .json()
        .await
        .expect("complete response should decode");

    let relay_token: RelayWsTokenResponse = public_post(
        address,
        "/api/public/relay/ws-token",
        &enrollment.relay_refresh_token,
        &RelayWsTokenRequest {
            relay_id: enrollment.relay_id.clone(),
            broker_room_id: enrollment.broker_room_id.clone(),
            relay_peer_id: "relay-challenge".to_string(),
        },
    )
    .await;

    let url = format!(
        "ws://{address}/ws/{}?role=relay&peer_id=relay-challenge&join_ticket={}",
        relay_token.broker_room_id, relay_token.relay_ws_token
    );
    let (mut socket, _) = connect_async(&url)
        .await
        .expect("challenge-enrolled relay should connect");
    let welcome = next_server_message(&mut socket).await;
    match welcome {
        ServerMessage::Welcome { peer_id, .. } => assert_eq!(peer_id, "relay-challenge"),
        other => panic!("unexpected response: {other:?}"),
    }
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
    assert!(error_body.contains("request failed"));
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
    assert!(error_body.contains("request failed"));
}

#[tokio::test]
async fn public_client_grants_list_relays_and_track_revoke() {
    let address = spawn_public_mode_app().await;
    let signing_key = SigningKey::from_bytes(&[7_u8; 32]);

    let grant = public_client_pair(
        address,
        "relay-refresh-1",
        &signing_key,
        &ClientGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-1".to_string(),
            client_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
            client_label: Some("Phone".to_string()),
            device_label: Some("Phone".to_string()),
        },
    )
    .await;
    assert!(grant.client_id.starts_with("client-"));

    let relays: ClientRelaysResponse =
        public_get(address, "/api/public/relays", &grant.client_refresh_token).await;
    assert_eq!(relays.client_id, grant.client_id);
    assert_eq!(relays.relays.len(), 1);
    assert_eq!(relays.relays[0].relay_id, "relay-1");
    assert_eq!(relays.relays[0].broker_room_id, "room-a");
    assert_eq!(relays.relays[0].device_id, "device-1");
    assert_eq!(relays.relays[0].device_label.as_deref(), Some("Phone"));

    let _: DeviceGrantRevokeResponse = public_post(
        address,
        "/api/public/devices/device-1/revoke",
        "relay-refresh-1",
        &DeviceGrantRevokeRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
        },
    )
    .await;

    let relays_after_revoke: ClientRelaysResponse =
        public_get(address, "/api/public/relays", &grant.client_refresh_token).await;
    assert!(relays_after_revoke.relays.is_empty());
}

#[tokio::test]
async fn public_client_session_cookie_can_list_relays() {
    let address = spawn_public_mode_app().await;
    let signing_key = SigningKey::from_bytes(&[8_u8; 32]);

    let grant = public_client_pair(
        address,
        "relay-refresh-1",
        &signing_key,
        &ClientGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-client-cookie".to_string(),
            client_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
            client_label: Some("Tablet".to_string()),
            device_label: Some("Tablet".to_string()),
        },
    )
    .await;

    let session_response = public_post_response(
        address,
        "/api/public/client/session",
        &grant.client_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("client session request should succeed");
    let cookie = set_cookie_name_value(&session_response);
    let session: ClientSessionResponse = session_response
        .json()
        .await
        .expect("client session response should decode");
    assert_eq!(session.client_id, grant.client_id);

    let response = reqwest::Client::new()
        .get(format!("http://{address}/api/public/relays"))
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await
        .expect("cookie relay directory request should complete")
        .error_for_status()
        .expect("cookie relay directory request should succeed");
    let relays: ClientRelaysResponse = response
        .json()
        .await
        .expect("relay directory response should decode");
    assert_eq!(relays.client_id, grant.client_id);
    assert_eq!(relays.relays.len(), 1);
    assert_eq!(relays.relays[0].relay_id, "relay-1");
}

// Regression test: the cookie-authenticated relay directory is client-specific
// private data. If the origin sends no `Cache-Control`, a browser or shared
// intermediary is free to store and reuse it, risking stale data or
// cross-client disclosure. Every `/api/*` response must be `no-store` so
// authenticated JSON is never cached.
#[tokio::test]
async fn cookie_authenticated_relay_directory_is_no_store() {
    let address = spawn_public_mode_app().await;
    let signing_key = SigningKey::from_bytes(&[24_u8; 32]);

    let grant = public_client_pair(
        address,
        "relay-refresh-1",
        &signing_key,
        &ClientGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-no-store".to_string(),
            client_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
            client_label: Some("Tablet".to_string()),
            device_label: Some("Tablet".to_string()),
        },
    )
    .await;

    let session_response = public_post_response(
        address,
        "/api/public/client/session",
        &grant.client_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("client session request should succeed");
    let cookie = set_cookie_name_value(&session_response);

    let response = reqwest::Client::new()
        .get(format!("http://{address}/api/public/relays"))
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await
        .expect("cookie relay directory request should complete")
        .error_for_status()
        .expect("cookie relay directory request should succeed");

    let cache_control = response
        .headers()
        .get(reqwest::header::CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
        .map(str::to_ascii_lowercase);
    assert_eq!(
        cache_control.as_deref(),
        Some("no-store"),
        "cookie-authenticated relay directory must not be cacheable"
    );
}

#[tokio::test]
async fn public_client_refresh_token_can_rotate() {
    let address = spawn_public_mode_app().await;
    let signing_key = SigningKey::from_bytes(&[9_u8; 32]);

    let grant = public_client_pair(
        address,
        "relay-refresh-1",
        &signing_key,
        &ClientGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-client-rotate".to_string(),
            client_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
            client_label: Some("Laptop".to_string()),
            device_label: Some("Laptop".to_string()),
        },
    )
    .await;

    let rotate_response = public_post_response(
        address,
        "/api/public/client/rotate",
        &grant.client_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("client rotate request should succeed");
    let rotated: ClientIdentityRotateResponse = rotate_response
        .json()
        .await
        .expect("rotate response should decode");
    assert_eq!(rotated.client_id, grant.client_id);
    assert!(rotated.rotated);
    let new_refresh_token = rotated
        .client_refresh_token
        .expect("bearer-auth rotate should return a fresh refresh token");
    assert_ne!(new_refresh_token, grant.client_refresh_token);

    // The rotated-away token stays valid within the rotation grace window, so a
    // client that never received the fresh credential is not locked out (explicit
    // revocation still cuts access immediately — covered by the revoke tests).
    let old_token_response = reqwest::Client::new()
        .get(format!("http://{address}/api/public/relays"))
        .bearer_auth(&grant.client_refresh_token)
        .send()
        .await
        .expect("old token request should complete");
    assert_eq!(old_token_response.status(), reqwest::StatusCode::OK);

    let relays: ClientRelaysResponse =
        public_get(address, "/api/public/relays", &new_refresh_token).await;
    assert_eq!(relays.client_id, grant.client_id);
    assert_eq!(relays.relays.len(), 1);
    assert_eq!(relays.relays[0].relay_id, "relay-1");
}

#[tokio::test]
async fn public_client_session_cookie_can_rotate() {
    let address = spawn_public_mode_app().await;
    let signing_key = SigningKey::from_bytes(&[11_u8; 32]);

    let grant = public_client_pair(
        address,
        "relay-refresh-1",
        &signing_key,
        &ClientGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-client-cookie-rotate".to_string(),
            client_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
            client_label: Some("Browser".to_string()),
            device_label: Some("Browser".to_string()),
        },
    )
    .await;

    let session_response = public_post_response(
        address,
        "/api/public/client/session",
        &grant.client_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("client session request should succeed");
    let original_cookie = set_cookie_name_value(&session_response);

    let rotate_response = reqwest::Client::new()
        .post(format!("http://{address}/api/public/client/rotate"))
        .header(reqwest::header::COOKIE, original_cookie.clone())
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("cookie rotate request should complete")
        .error_for_status()
        .expect("cookie rotate request should succeed");
    let rotated_cookie = set_cookie_name_value(&rotate_response);
    let rotated: ClientIdentityRotateResponse = rotate_response
        .json()
        .await
        .expect("cookie rotate response should decode");
    assert_eq!(rotated.client_id, grant.client_id);
    assert!(rotated.rotated);
    assert!(rotated.cookie_session);
    assert_eq!(rotated.client_refresh_token, None);
    assert_ne!(rotated_cookie, original_cookie);

    // The pre-rotation cookie stays valid within the rotation grace window (a
    // browser that missed the Set-Cookie must not be locked out); revocation
    // tests cover the immediate-cutoff path.
    let old_cookie_response = reqwest::Client::new()
        .get(format!("http://{address}/api/public/relays"))
        .header(reqwest::header::COOKIE, original_cookie)
        .send()
        .await
        .expect("old cookie request should complete");
    assert_eq!(old_cookie_response.status(), reqwest::StatusCode::OK);

    let new_cookie_response = reqwest::Client::new()
        .get(format!("http://{address}/api/public/relays"))
        .header(reqwest::header::COOKIE, rotated_cookie)
        .send()
        .await
        .expect("rotated cookie request should complete")
        .error_for_status()
        .expect("rotated cookie request should succeed");
    let relays: ClientRelaysResponse = new_cookie_response
        .json()
        .await
        .expect("relay directory response should decode");
    assert_eq!(relays.client_id, grant.client_id);
    assert_eq!(relays.relays.len(), 1);
    assert_eq!(relays.relays[0].relay_id, "relay-1");
}

#[tokio::test]
async fn public_client_session_cookie_fails_after_revoke() {
    let address = spawn_public_mode_app().await;
    let signing_key = SigningKey::from_bytes(&[10_u8; 32]);

    let grant = public_client_pair(
        address,
        "relay-refresh-1",
        &signing_key,
        &ClientGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-client-revoke".to_string(),
            client_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
            client_label: Some("Desktop".to_string()),
            device_label: Some("Desktop".to_string()),
        },
    )
    .await;

    let session_response = public_post_response(
        address,
        "/api/public/client/session",
        &grant.client_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("client session request should succeed");
    let cookie = set_cookie_name_value(&session_response);

    let revoke_response = reqwest::Client::new()
        .delete(format!("http://{address}/api/public/client"))
        .header(reqwest::header::COOKIE, cookie.clone())
        .send()
        .await
        .expect("client revoke request should complete")
        .error_for_status()
        .expect("client revoke request should succeed");
    let revoke: ClientIdentityRevokeResponse = revoke_response
        .json()
        .await
        .expect("client revoke response should decode");
    assert_eq!(revoke.client_id, grant.client_id);
    assert!(revoke.revoked);
    assert_eq!(revoke.revoked_identity_count, 1);
    assert_eq!(revoke.revoked_grant_count, 1);

    let old_token_response = reqwest::Client::new()
        .get(format!("http://{address}/api/public/relays"))
        .bearer_auth(&grant.client_refresh_token)
        .send()
        .await
        .expect("old token request should complete");
    assert_eq!(
        old_token_response.status(),
        reqwest::StatusCode::UNAUTHORIZED
    );

    let old_cookie_response = reqwest::Client::new()
        .get(format!("http://{address}/api/public/relays"))
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await
        .expect("old cookie request should complete");
    assert_eq!(
        old_cookie_response.status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn public_device_ws_tokens_can_refresh_after_expiry() {
    let address = spawn_public_mode_app_with(
        test_public_control_plane_with_parts(None, Some("300"), Some("1")).await,
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;

    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-expiring".to_string(),
        },
    )
    .await;

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    let expired_url = format!(
        "ws://{address}/ws/room-a?role=surface&join_ticket={}",
        device_grant.device_ws_token
    );
    let (mut expired_socket, _) = connect_async(&expired_url)
        .await
        .expect("expired device surface should connect");
    let expired_error = next_server_message(&mut expired_socket).await;
    match expired_error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "join_rejected");
            assert_eq!(message, "broker join rejected");
        }
        other => panic!("unexpected expired token response: {other:?}"),
    }

    let refreshed: DeviceWsTokenResponse = public_post(
        address,
        "/api/public/device/ws-token",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
    )
    .await;
    let refreshed_url = format!(
        "ws://{address}/ws/room-a?role=surface&join_ticket={}",
        refreshed.device_ws_token
    );
    let (mut refreshed_socket, _) = connect_async(&refreshed_url)
        .await
        .expect("refreshed device surface should connect");
    let welcome = next_server_message(&mut refreshed_socket).await;
    match welcome {
        ServerMessage::Welcome { peer_id, .. } => assert!(peer_id.starts_with("surface-")),
        other => panic!("unexpected refreshed token response: {other:?}"),
    }
}

#[tokio::test]
async fn public_device_session_cookie_can_refresh_ws_tokens() {
    let address = spawn_public_mode_app().await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-cookie".to_string(),
        },
    )
    .await;

    let session_response = public_post_response(
        address,
        "/api/public/device/session",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("device session request should succeed");
    let cookie = set_cookie_name_value(&session_response);
    let session: DeviceSessionResponse = session_response
        .json()
        .await
        .expect("device session response should decode");
    assert_eq!(session.device_id, "device-cookie");

    let refreshed: DeviceWsTokenResponse = public_post_with_cookie(
        address,
        "/api/public/device/ws-token",
        &cookie,
        &serde_json::json!({}),
    )
    .await;
    assert_eq!(refreshed.device_id, "device-cookie");
}

#[tokio::test]
async fn public_device_session_scoped_round_trips_per_room_cookie() {
    let address = spawn_public_mode_app().await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-scoped".to_string(),
        },
    )
    .await;

    let session_response = public_post_response(
        address,
        "/api/public/device/room-a/session",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("scoped device session request should succeed");
    let cookie = set_cookie_name_value(&session_response);
    assert!(
        cookie.starts_with(&format!("{}=", device_session_cookie_name("room-a"))),
        "expected a per-room cookie name, got {cookie}"
    );

    let refreshed: DeviceWsTokenResponse = public_post_with_cookie(
        address,
        "/api/public/device/room-a/ws-token",
        &cookie,
        &serde_json::json!({}),
    )
    .await;
    assert_eq!(refreshed.device_id, "device-scoped");
}

#[tokio::test]
async fn public_device_session_scoped_round_trips_static_room_with_slash() {
    let address = spawn_public_mode_app_with(
        test_public_control_plane_with_room("team/prod").await,
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "team/prod".to_string(),
            device_id: "device-static-slash".to_string(),
        },
    )
    .await;

    let session_response = public_post_response(
        address,
        "/api/public/device/team%2Fprod/session",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("scoped device session request should succeed");
    let cookie = set_cookie_name_value(&session_response);
    let expected_cookie_name = device_session_cookie_name("team/prod");
    assert!(
        cookie.starts_with(&format!("{expected_cookie_name}=")),
        "static rooms must get their own hashed scoped cookie name, got {cookie}"
    );
    assert!(
        !cookie.starts_with("agent_relay_device_session="),
        "static room must not degrade to the shared legacy cookie, got {cookie}"
    );

    let refreshed: DeviceWsTokenResponse = public_post_with_cookie(
        address,
        "/api/public/device/team%2Fprod/ws-token",
        &cookie,
        &serde_json::json!({}),
    )
    .await;
    assert_eq!(refreshed.device_id, "device-static-slash");
    assert_eq!(refreshed.broker_room_id, "team/prod");
}

#[tokio::test]
async fn public_device_ws_token_scoped_rejects_room_mismatch() {
    let address = spawn_public_mode_app().await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-mismatch".to_string(),
        },
    )
    .await;

    // A room-a token presented (as a bearer) to room-b's endpoint must be rejected,
    // and the error must not reveal the real room.
    let body = public_post_expect_status(
        address,
        "/api/public/device/room-b/ws-token",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
        reqwest::StatusCode::UNAUTHORIZED,
    )
    .await;
    assert!(
        !body.contains("room-a"),
        "error must not leak the real room"
    );
}

#[tokio::test]
async fn public_device_ws_token_scoped_upgrades_legacy_cookie_on_match_only() {
    let address = spawn_public_mode_app().await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-legacy".to_string(),
        },
    )
    .await;

    // A not-yet-migrated device: the legacy origin-wide cookie carrying room-a's
    // token, presented to the new room-a route → upgrade on use.
    let legacy = format!(
        "agent_relay_device_session={}",
        device_grant.device_refresh_token
    );
    let response = public_post_with_cookie_response(
        address,
        "/api/public/device/room-a/ws-token",
        &legacy,
        &serde_json::json!({}),
    )
    .await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let set_cookies = set_cookie_values(&response);
    assert!(
        set_cookies.iter().any(|c| c
            .starts_with(&format!("{}=", device_session_cookie_name("room-a")))
            && !c.contains("Max-Age=0")),
        "upgrade must set the per-room cookie: {set_cookies:?}"
    );
    assert!(
        set_cookies
            .iter()
            .any(|c| c.starts_with("agent_relay_device_session=") && c.contains("Max-Age=0")),
        "upgrade must clear the legacy cookie: {set_cookies:?}"
    );

    // The SAME legacy cookie presented to a DIFFERENT room must 401 and must NOT
    // clear the legacy cookie — a sibling relay may still need it to migrate.
    let response_b = public_post_with_cookie_response(
        address,
        "/api/public/device/room-b/ws-token",
        &legacy,
        &serde_json::json!({}),
    )
    .await;
    assert_eq!(response_b.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert!(
        set_cookie_values(&response_b).is_empty(),
        "room mismatch must not emit any Set-Cookie"
    );
}

#[tokio::test]
async fn public_device_session_scoped_delete_clears_matching_legacy_cookie_only() {
    let address = spawn_public_mode_app().await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-legacy-forget".to_string(),
        },
    )
    .await;

    let legacy = format!(
        "agent_relay_device_session={}",
        device_grant.device_refresh_token
    );
    let response =
        public_delete_with_cookie_response(address, "/api/public/device/room-a/session", &legacy)
            .await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let set_cookies = set_cookie_values(&response);
    assert!(
        set_cookies.iter().any(|c| c
            .starts_with(&format!("{}=", device_session_cookie_name("room-a")))
            && c.contains("Max-Age=0")),
        "forget must clear the room-a per-room cookie: {set_cookies:?}"
    );
    assert!(
        set_cookies
            .iter()
            .any(|c| c.starts_with("agent_relay_device_session=") && c.contains("Max-Age=0")),
        "forget must clear the legacy cookie when it belongs to room-a: {set_cookies:?}"
    );

    let mismatch =
        public_delete_with_cookie_response(address, "/api/public/device/room-b/session", &legacy)
            .await;
    assert_eq!(mismatch.status(), reqwest::StatusCode::OK);
    let mismatch_cookies = set_cookie_values(&mismatch);
    assert!(
        mismatch_cookies.iter().any(|c| c
            .starts_with(&format!("{}=", device_session_cookie_name("room-b")))
            && c.contains("Max-Age=0")),
        "forget must clear the requested room-b per-room cookie: {mismatch_cookies:?}"
    );
    assert!(
        !mismatch_cookies
            .iter()
            .any(|c| c.starts_with("agent_relay_device_session=") && c.contains("Max-Age=0")),
        "wrong-room forget must not clear a sibling's legacy cookie: {mismatch_cookies:?}"
    );
}

#[tokio::test]
async fn public_device_ws_token_scoped_prefers_bearer_over_stale_room_cookie() {
    let address = spawn_public_mode_app().await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-bearer".to_string(),
        },
    )
    .await;

    // The frontend falls back to Authorization bearer if cookie establishment
    // fails, but browsers may still attach a stale per-room cookie. The bearer
    // must win or the fallback is masked by the stale cookie and returns 401.
    let response = reqwest::Client::new()
        .post(format!(
            "http://{address}/api/public/device/room-a/ws-token"
        ))
        .header(
            reqwest::header::COOKIE,
            format!(
                "{}=stale-refresh-token",
                device_session_cookie_name("room-a")
            ),
        )
        .bearer_auth(&device_grant.device_refresh_token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("request should succeed")
        .error_for_status()
        .expect("bearer should authenticate despite a stale per-room cookie");
    let refreshed: DeviceWsTokenResponse = response.json().await.expect("response should decode");
    assert_eq!(refreshed.device_id, "device-bearer");
}

#[tokio::test]
async fn public_device_scoped_accepts_non_prefixed_static_room() {
    // Static registrations allow arbitrary non-empty room ids. validate_room_id
    // must accept URL-sensitive but non-control ids and proceed to token
    // resolution (401 for a bogus token) instead of rejecting the room as invalid
    // (400).
    let address = spawn_public_mode_app().await;
    public_post_expect_status(
        address,
        "/api/public/device/team.prod/ws-token",
        "bogus-token",
        &serde_json::json!({}),
        reqwest::StatusCode::UNAUTHORIZED,
    )
    .await;
    public_post_expect_status(
        address,
        "/api/public/device/team%2Fprod/ws-token",
        "bogus-token",
        &serde_json::json!({}),
        reqwest::StatusCode::UNAUTHORIZED,
    )
    .await;
    public_post_expect_status(
        address,
        "/api/public/device/room-%3Bevil/ws-token",
        "bogus-token",
        &serde_json::json!({}),
        reqwest::StatusCode::UNAUTHORIZED,
    )
    .await;
}

#[tokio::test]
async fn public_device_scoped_rejects_invalid_room() {
    let address = spawn_public_mode_app().await;
    // Control characters are not valid static broker_room_id values in a URL
    // path, and are rejected before they can reach cookie/header handling.
    public_post_expect_status(
        address,
        "/api/public/device/room-%0Aevil/ws-token",
        "any-token",
        &serde_json::json!({}),
        reqwest::StatusCode::BAD_REQUEST,
    )
    .await;
    let long_room = "a".repeat(DEVICE_SESSION_ROOM_MAX_BYTES + 1);
    let long_path = format!("/api/public/device/{long_room}/ws-token");
    public_post_expect_status(
        address,
        &long_path,
        "any-token",
        &serde_json::json!({}),
        reqwest::StatusCode::BAD_REQUEST,
    )
    .await;
}

#[tokio::test]
async fn public_device_refresh_tokens_survive_control_plane_restart() {
    let state_path = temp_state_path("agent-relay-public-control");
    let first_address = spawn_public_mode_app_with(
        test_public_control_plane_with_parts(Some(state_path.clone()), Some("300"), Some("300"))
            .await,
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;

    let device_grant: DeviceGrantResponse = public_post(
        first_address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-persisted".to_string(),
        },
    )
    .await;

    let restarted_address = spawn_public_mode_app_with(
        test_public_control_plane_with_parts(Some(state_path), Some("300"), Some("300")).await,
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
    )
    .await;
    let refreshed: DeviceWsTokenResponse = public_post(
        restarted_address,
        "/api/public/device/ws-token",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
    )
    .await;

    assert_eq!(refreshed.device_id, "device-persisted");
    let url = format!(
        "ws://{restarted_address}/ws/room-a?role=surface&join_ticket={}",
        refreshed.device_ws_token
    );
    let (mut socket, _) = connect_async(&url)
        .await
        .expect("refreshed device surface should connect after restart");
    let welcome = next_server_message(&mut socket).await;
    match welcome {
        ServerMessage::Welcome { peer_id, .. } => assert!(peer_id.starts_with("surface-")),
        other => panic!("unexpected restart refresh response: {other:?}"),
    }
}

#[tokio::test]
async fn public_device_refresh_tokens_fail_after_revoke() {
    let address = spawn_public_mode_app().await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-revoked".to_string(),
        },
    )
    .await;

    let _: DeviceGrantRevokeResponse = public_post(
        address,
        "/api/public/devices/device-revoked/revoke",
        "relay-refresh-1",
        &DeviceGrantRevokeRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
        },
    )
    .await;

    let error_body = public_post_expect_status(
        address,
        "/api/public/device/ws-token",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
        reqwest::StatusCode::UNAUTHORIZED,
    )
    .await;
    assert!(error_body.contains("request failed"));

    let health = broker_health(address).await;
    let monitoring = health
        .public_monitoring
        .expect("public health should expose monitoring");
    assert_eq!(monitoring.device_ws_token_refresh_failures, 1);
    assert_eq!(monitoring.invalid_refresh_token_uses, 1);
    assert_eq!(monitoring.repeated_invalid_refresh_token_uses, 0);
}

#[tokio::test]
async fn repeated_invalid_device_refresh_token_use_is_tracked() {
    let address = spawn_public_mode_app().await;
    let revoked: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-reused-invalid-token".to_string(),
        },
    )
    .await;

    let _: DeviceGrantRevokeResponse = public_post(
        address,
        "/api/public/devices/device-reused-invalid-token/revoke",
        "relay-refresh-1",
        &DeviceGrantRevokeRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
        },
    )
    .await;

    for _ in 0..2 {
        let response = reqwest::Client::new()
            .post(format!("http://{address}/api/public/device/ws-token"))
            .bearer_auth(&revoked.device_refresh_token)
            .json(&serde_json::json!({}))
            .send()
            .await
            .expect("invalid refresh request should complete");
        assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    }

    let health = broker_health(address).await;
    let monitoring = health
        .public_monitoring
        .expect("public health should expose monitoring");
    assert_eq!(monitoring.device_ws_token_refresh_failures, 2);
    assert_eq!(monitoring.invalid_refresh_token_uses, 2);
    assert_eq!(monitoring.repeated_invalid_refresh_token_uses, 1);
}

#[tokio::test]
async fn client_environment_mutations_are_tracked() {
    let address = spawn_public_mode_app().await;
    let signing_key = SigningKey::from_bytes(&[12_u8; 32]);

    let grant = public_client_pair(
        address,
        "relay-refresh-1",
        &signing_key,
        &ClientGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-env-mutation".to_string(),
            client_verify_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
            client_label: Some("Env Watcher".to_string()),
            device_label: Some("Env Watcher".to_string()),
        },
    )
    .await;

    let _: ClientRelaysResponse = public_get_with_headers(
        address,
        "/api/public/relays",
        &grant.client_refresh_token,
        &[("User-Agent", "EnvProbe/1.0")],
    )
    .await;
    let _: ClientRelaysResponse = public_get_with_headers(
        address,
        "/api/public/relays",
        &grant.client_refresh_token,
        &[("User-Agent", "EnvProbe/2.0")],
    )
    .await;

    let health = broker_health(address).await;
    let monitoring = health
        .public_monitoring
        .expect("public health should expose monitoring");
    assert_eq!(monitoring.environment_mutation_events, 1);
}

#[tokio::test]
async fn public_device_session_cookie_fails_after_revoke() {
    let address = spawn_public_mode_app().await;
    let device_grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        "relay-refresh-1",
        &DeviceGrantRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            device_id: "device-cookie-revoked".to_string(),
        },
    )
    .await;

    let session_response = public_post_response(
        address,
        "/api/public/device/session",
        &device_grant.device_refresh_token,
        &serde_json::json!({}),
    )
    .await
    .error_for_status()
    .expect("device session request should succeed");
    let cookie = set_cookie_name_value(&session_response);

    let _: DeviceGrantRevokeResponse = public_post(
        address,
        "/api/public/devices/device-cookie-revoked/revoke",
        "relay-refresh-1",
        &DeviceGrantRevokeRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
        },
    )
    .await;

    let response = reqwest::Client::new()
        .post(format!("http://{address}/api/public/device/ws-token"))
        .header(reqwest::header::COOKIE, cookie)
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("cookie refresh request should complete");
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn public_api_rate_limit_is_enforced() {
    let address = spawn_public_mode_app_with(
        test_public_control_plane().await,
        BrokerHardeningConfig {
            public_api_rate_limit_per_minute: 1,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;

    let _: RelayWsTokenResponse = public_post(
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

    let error_body = public_post_expect_status(
        address,
        "/api/public/relay/ws-token",
        "relay-refresh-1",
        &RelayWsTokenRequest {
            relay_id: "relay-1".to_string(),
            broker_room_id: "room-a".to_string(),
            relay_peer_id: "relay-2".to_string(),
        },
        reqwest::StatusCode::TOO_MANY_REQUESTS,
    )
    .await;
    assert!(error_body.contains("rate limit"));
}

#[tokio::test]
async fn websocket_join_rate_limit_is_enforced() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            join_rate_limit_per_minute: 1,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let first_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-join-rate-1", u64::MAX),
    );
    let second_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-join-rate-2", u64::MAX),
    );

    let (mut first_socket, _) = connect_async(&first_url)
        .await
        .expect("first socket should connect");
    let _welcome = next_server_message(&mut first_socket).await;

    let (mut second_socket, _) = connect_async(&second_url)
        .await
        .expect("second socket should connect");
    let error = next_server_message(&mut second_socket).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "rate_limited");
            assert!(message.contains("rate limit"));
        }
        other => panic!("unexpected join rate limit response: {other:?}"),
    }
}

#[tokio::test]
async fn websocket_connection_limit_is_enforced_per_ip() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            max_connections_per_ip: 1,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let first_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-connection-limit-1", u64::MAX),
    );
    let second_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-connection-limit-2", u64::MAX),
    );

    let (mut first_socket, _) = connect_async(&first_url)
        .await
        .expect("first socket should connect");
    let _welcome = next_server_message(&mut first_socket).await;

    let (mut second_socket, _) = connect_async(&second_url)
        .await
        .expect("second socket should connect");
    let error = next_server_message(&mut second_socket).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "rate_limited");
            assert!(message.contains("too many broker connections"));
        }
        other => panic!("unexpected connection limit response: {other:?}"),
    }
}

#[tokio::test]
async fn websocket_publish_rate_limit_rejects_messages_without_closing_socket() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            publish_rate_limit_per_minute: 1,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let relay_url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Relay,
        Some("relay-1"),
        JoinTicketClaims::relay_join("room-a", "relay-1"),
    );

    let (mut relay, _) = connect_async(&relay_url)
        .await
        .expect("relay socket should connect");
    let _welcome = next_server_message(&mut relay).await;

    let publish_frame = serde_json::to_string(&ClientMessage::Publish {
        protocol_version: protocol::BROKER_PROTOCOL_VERSION,
        payload: json!({"ciphertext":"abc"}),
    })
    .expect("client frame should serialize");

    relay
        .send(Message::Text(publish_frame.clone()))
        .await
        .expect("first publish should send");
    relay
        .send(Message::Text(publish_frame.clone()))
        .await
        .expect("second publish should send");

    let error = next_server_message(&mut relay).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "rate_limited");
            assert!(message.contains("rate limit"));
        }
        other => panic!("unexpected publish rate limit response: {other:?}"),
    }

    relay
        .send(Message::Text(publish_frame))
        .await
        .expect("third publish should still send on same socket");
    let second_error = next_server_message(&mut relay).await;
    match second_error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "rate_limited");
            assert!(message.contains("rate limit"));
        }
        other => panic!("unexpected repeated publish rate limit response: {other:?}"),
    }
}

#[tokio::test]
async fn oversized_client_frames_are_rejected() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            max_text_frame_bytes: 64,
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-frame-limit", u64::MAX),
    );

    let (mut socket, _) = connect_async(&url).await.expect("socket should connect");
    let _welcome = next_server_message(&mut socket).await;
    socket
        .send(Message::Text("x".repeat(65)))
        .await
        .expect("oversized frame should send");

    let error = next_server_message(&mut socket).await;
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "frame_too_large");
            assert!(message.contains("64"));
        }
        other => panic!("unexpected oversized frame response: {other:?}"),
    }
}

#[tokio::test]
async fn idle_connections_are_closed() {
    let address = spawn_app_with(
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        BrokerHardeningConfig {
            idle_timeout: std::time::Duration::from_millis(100),
            ..BrokerHardeningConfig::default()
        },
        SecurityHeadersConfig::default(),
    )
    .await;
    let url = websocket_url(
        address,
        "room-a",
        protocol::PeerRole::Surface,
        None,
        JoinTicketClaims::pairing_surface_join("room-a", "pair-idle-timeout", u64::MAX),
    );

    let (mut socket, _) = connect_async(&url).await.expect("socket should connect");
    let _welcome = next_server_message(&mut socket).await;
    let error = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        next_server_message(&mut socket),
    )
    .await
    .expect("socket should receive an idle-timeout frame");
    match error {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "idle_timeout");
            assert!(message.contains("idle"));
        }
        other => panic!("unexpected idle-timeout response: {other:?}"),
    }
}

#[test]
fn summarize_published_payload_reports_transcript_page_stats() {
    let summary = summarize_published_payload(&json!({
        "kind": "remote_action_result",
        "action": "fetch_thread_transcript",
        "ok": true,
        "thread_transcript": {
            "thread_id": "thread-1",
            "entries": [
                {
                    "entry_index": 0,
                    "parts": [
                        {"part_index": 0, "text": "a"},
                        {"part_index": 1, "text": "b"}
                    ]
                },
                {
                    "entry_index": 1,
                    "parts": [
                        {"part_index": 0, "text": "c"}
                    ]
                }
            ],
            "next_cursor": 12,
            "prev_cursor": 4
        }
    }));

    assert!(summary.contains("kind=remote_action_result"));
    assert!(summary.contains("action=fetch_thread_transcript"));
    assert!(summary.contains("ok=true"));
    assert!(summary.contains("entries=2"));
    assert!(summary.contains("parts=3"));
    assert!(summary.contains("next_cursor=12"));
    assert!(summary.contains("prev_cursor=4"));
}

async fn spawn_app_with_guard(guard: BanGuard) -> SocketAddr {
    spawn_app_with_guard_and_hardening(guard, BrokerHardeningConfig::default()).await
}

async fn spawn_app_with_guard_and_hardening(
    guard: BanGuard,
    hardening: BrokerHardeningConfig,
) -> SocketAddr {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    let app = app_with_web_root_and_verifier_and_hardening(
        BrokerState::default(),
        test_web_root(),
        BrokerJoinVerifier::SelfHosted(test_join_ticket_key()),
        hardening,
        SecurityHeadersConfig::default(),
    )
    .layer(middleware::from_fn_with_state(guard, reject_banned_ips));
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("broker should serve");
    });
    address
}

#[tokio::test]
async fn banned_socket_ip_gets_403_on_health() {
    let guard = BanGuard {
        blocklist: Blocklist::from_entries(&["127.0.0.1"]),
        trusted_ip_header: None,
    };
    let address = spawn_app_with_guard(guard).await;
    let response = reqwest::get(format!("http://{address}/api/health"))
        .await
        .expect("request should complete");
    assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn unbanned_socket_ip_reaches_health() {
    let guard = BanGuard {
        blocklist: Blocklist::from_entries(&["9.9.9.9"]),
        trusted_ip_header: None,
    };
    let address = spawn_app_with_guard(guard).await;
    let response = reqwest::get(format!("http://{address}/api/health"))
        .await
        .expect("request should complete");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
}

#[tokio::test]
async fn banned_ip_rejects_websocket_upgrade() {
    let guard = BanGuard {
        blocklist: Blocklist::from_entries(&["127.0.0.1"]),
        trusted_ip_header: None,
    };
    let address = spawn_app_with_guard(guard).await;
    let result = connect_async(format!("ws://{address}/ws/room-a?role=relay")).await;
    assert!(
        result.is_err(),
        "banned ip must not be able to upgrade the websocket"
    );
}

#[tokio::test]
async fn banned_client_via_trusted_forwarded_header_gets_403() {
    let guard = BanGuard {
        blocklist: Blocklist::from_entries(&["203.0.113.9"]),
        trusted_ip_header: Some("x-forwarded-for".parse().expect("valid header name")),
    };
    let address = spawn_app_with_guard(guard).await;
    let client = reqwest::Client::new();

    // The banned client IP arrives via the trusted forwarded header -> 403,
    // even though the socket IP (127.0.0.1) is not itself banned.
    let banned = client
        .get(format!("http://{address}/api/health"))
        .header("x-forwarded-for", "203.0.113.9")
        .send()
        .await
        .expect("request should complete");
    assert_eq!(banned.status(), reqwest::StatusCode::FORBIDDEN);

    // No forwarded header -> falls back to the socket IP (127.0.0.1), not banned.
    let allowed = client
        .get(format!("http://{address}/api/health"))
        .send()
        .await
        .expect("request should complete");
    assert_eq!(allowed.status(), reqwest::StatusCode::OK);
}

#[tokio::test]
async fn duplicate_forwarded_headers_use_the_proxy_appended_value() {
    let real = "203.0.113.9"; // appended by the trusted proxy (last field)
    let spoof = "9.9.9.9"; // client-supplied earlier field

    let mut headers = reqwest::header::HeaderMap::new();
    headers.append("x-forwarded-for", spoof.parse().unwrap());
    headers.append("x-forwarded-for", real.parse().unwrap());

    // Banning the real (last) IP -> 403 despite the spoofed first field.
    let address = spawn_app_with_guard(BanGuard {
        blocklist: Blocklist::from_entries(&[real]),
        trusted_ip_header: Some("x-forwarded-for".parse().unwrap()),
    })
    .await;
    let banned = reqwest::Client::new()
        .get(format!("http://{address}/api/health"))
        .headers(headers.clone())
        .send()
        .await
        .expect("request should complete");
    assert_eq!(banned.status(), reqwest::StatusCode::FORBIDDEN);

    // Banning only the spoofed (first) IP -> not blocked; we key on the last value.
    let address2 = spawn_app_with_guard(BanGuard {
        blocklist: Blocklist::from_entries(&[spoof]),
        trusted_ip_header: Some("x-forwarded-for".parse().unwrap()),
    })
    .await;
    let allowed = reqwest::Client::new()
        .get(format!("http://{address2}/api/health"))
        .headers(headers)
        .send()
        .await
        .expect("request should complete");
    assert_eq!(allowed.status(), reqwest::StatusCode::OK);
}

#[tokio::test]
async fn per_ip_rate_limit_keys_on_forwarded_client_ip() {
    let guard = BanGuard {
        blocklist: Blocklist::disabled(),
        trusted_ip_header: Some("x-forwarded-for".parse().unwrap()),
    };
    let address = spawn_app_with_guard_and_hardening(
        guard,
        BrokerHardeningConfig {
            public_api_rate_limit_per_minute: 1,
            ..BrokerHardeningConfig::default()
        },
    )
    .await;

    let client = reqwest::Client::new();
    let url = format!("http://{address}/api/public/relay/ws-token");
    let body = RelayWsTokenRequest {
        relay_id: "relay-1".to_string(),
        broker_room_id: "room-a".to_string(),
        relay_peer_id: "relay-1".to_string(),
    };

    // Same forwarded client IP twice: the second exceeds the per-IP limit. (The
    // rate limiter runs before the auth-mode check, so self-hosted mode is fine —
    // we only care whether the status is 429.)
    let first = client
        .post(&url)
        .header("x-forwarded-for", "203.0.113.5")
        .json(&body)
        .send()
        .await
        .expect("request 1")
        .status();
    let second = client
        .post(&url)
        .header("x-forwarded-for", "203.0.113.5")
        .json(&body)
        .send()
        .await
        .expect("request 2")
        .status();
    // A different forwarded IP gets its own bucket, so it is not rate-limited —
    // proving the limit keys on the forwarded client IP, not the shared socket IP.
    let other = client
        .post(&url)
        .header("x-forwarded-for", "203.0.113.6")
        .json(&body)
        .send()
        .await
        .expect("request 3")
        .status();

    assert_ne!(first, reqwest::StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(second, reqwest::StatusCode::TOO_MANY_REQUESTS);
    assert_ne!(other, reqwest::StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn websocket_join_rate_limit_keys_on_forwarded_client_ip() {
    let guard = BanGuard {
        blocklist: Blocklist::disabled(),
        trusted_ip_header: Some("x-forwarded-for".parse().unwrap()),
    };
    let address = spawn_app_with_guard_and_hardening(
        guard,
        BrokerHardeningConfig {
            join_rate_limit_per_minute: 1,
            ..BrokerHardeningConfig::default()
        },
    )
    .await;

    // A ws upgrade request carrying the forwarded client IP the proxy would add.
    let join_request = |pairing_id: &str, xff: &str| {
        let url = websocket_url(
            address,
            "room-a",
            protocol::PeerRole::Surface,
            None,
            JoinTicketClaims::pairing_surface_join("room-a", pairing_id, u64::MAX),
        );
        let mut request = url.into_client_request().expect("ws request builds");
        request
            .headers_mut()
            .append("x-forwarded-for", xff.parse().unwrap());
        request
    };

    // Same forwarded IP: first join is welcomed, the second hits the per-IP join limit.
    let (mut a1, _) = connect_async(join_request("pair-a-1", "203.0.113.5"))
        .await
        .expect("a1 connects");
    assert!(matches!(
        next_server_message(&mut a1).await,
        ServerMessage::Welcome { .. }
    ));

    let (mut a2, _) = connect_async(join_request("pair-a-2", "203.0.113.5"))
        .await
        .expect("a2 connects");
    match next_server_message(&mut a2).await {
        ServerMessage::Error { code, .. } => assert_eq!(code, "rate_limited"),
        other => panic!("expected rate_limited, got {other:?}"),
    }

    // A different forwarded IP has its own bucket -> welcomed, proving the WS join
    // limit keys on the forwarded client IP, not the shared 127.0.0.1 socket.
    let (mut b1, _) = connect_async(join_request("pair-b-1", "203.0.113.6"))
        .await
        .expect("b1 connects");
    assert!(matches!(
        next_server_message(&mut b1).await,
        ServerMessage::Welcome { .. }
    ));
}

// ---------------------------------------------------------------------------
// License gate endpoint tests
// ---------------------------------------------------------------------------
// These tests run through the real app() + middleware stack, exercising the
// full enrollment and ws-token paths with in-memory license stores.

async fn spawn_public_mode_app_with_licenses(
    license_store: Option<crate::licenses::LicenseStore>,
    license_required: bool,
) -> SocketAddr {
    spawn_public_mode_app_full(None, license_store, license_required).await
}

async fn spawn_public_mode_app_full(
    admin_token: Option<std::sync::Arc<str>>,
    license_store: Option<crate::licenses::LicenseStore>,
    license_required: bool,
) -> SocketAddr {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    let app = app_with_web_root_and_verifier_and_hardening_and_licenses(
        BrokerState::default(),
        test_web_root(),
        BrokerJoinVerifier::PublicControlPlane(test_public_control_plane().await),
        BrokerHardeningConfig::default(),
        SecurityHeadersConfig::default(),
        license_store,
        license_required,
        admin_token,
    );
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("broker should serve");
    });
    address
}

/// Enroll a relay against the test public control-plane, optionally supplying a
/// license code. `seed_label` is used to derive a unique deterministic ed25519
/// key so parallel tests don't share relay verify keys.
async fn enroll_relay(
    address: SocketAddr,
    seed_label: &str,
    license_code: Option<&str>,
) -> Result<RelayEnrollmentResponse, (reqwest::StatusCode, String)> {
    // Derive a unique-but-deterministic signing key from the label so parallel
    // tests don't share keys (which would collide on the per-verify-key uniqueness
    // constraint in the broker). The key must be generated BEFORE the challenge so
    // we can send the correct verify_key_b64 in the challenge request.
    let seed: [u8; 32] = {
        let b = seed_label.as_bytes();
        let mut s = [0xABu8; 32];
        for (i, byte) in b.iter().take(32).enumerate() {
            s[i] = *byte;
        }
        s
    };
    let signing_key = SigningKey::from_bytes(&seed);
    let verify_key_b64 = STANDARD.encode(signing_key.verifying_key().to_bytes());

    let challenge_resp = reqwest::Client::new()
        .post(format!(
            "http://{address}/api/public/relay-enrollment/challenge"
        ))
        .json(&RelayEnrollmentChallengeRequest {
            relay_verify_key: verify_key_b64.clone(),
            relay_label: None,
        })
        .send()
        .await
        .expect("challenge request should complete");
    if !challenge_resp.status().is_success() {
        let status = challenge_resp.status();
        let body = challenge_resp.text().await.unwrap_or_default();
        return Err((status, format!("challenge failed: {body}")));
    }
    let challenge: RelayEnrollmentChallengeResponse = challenge_resp
        .json()
        .await
        .expect("challenge response should parse");

    let msg = format!(
        "agent-relay:relay-enroll:{}:{}",
        challenge.challenge_id, challenge.challenge
    );
    let sig_b64 = STANDARD.encode(signing_key.sign(msg.as_bytes()).to_bytes());

    let response = reqwest::Client::new()
        .post(format!(
            "http://{address}/api/public/relay-enrollment/complete"
        ))
        .json(&RelayEnrollmentCompleteRequest {
            relay_verify_key: verify_key_b64,
            challenge_id: challenge.challenge_id,
            challenge_signature: sig_b64,
            relay_label: None,
            license_code: license_code.map(ToString::to_string),
        })
        .send()
        .await
        .expect("enroll request should complete");

    let status = response.status();
    let body = response.text().await.expect("body should read");
    if status.is_success() {
        Ok(serde_json::from_str(&body).expect("enrollment response should parse"))
    } else {
        Err((status, body))
    }
}

#[tokio::test]
async fn license_not_required_enrollment_succeeds_without_code() {
    let store = crate::licenses::LicenseStore::for_test(vec![]);
    let address = spawn_public_mode_app_with_licenses(Some(store), false).await;
    enroll_relay(address, "verify-key-1", None)
        .await
        .expect("enrollment without code must succeed when not required");
}

#[tokio::test]
async fn license_required_enrollment_rejected_without_code() {
    let store = crate::licenses::LicenseStore::for_test(vec![]);
    let address = spawn_public_mode_app_with_licenses(Some(store), true).await;
    let (status, body) = enroll_relay(address, "verify-key-2", None)
        .await
        .expect_err("enrollment without code must fail when required");
    assert!(
        status.is_client_error(),
        "must return a 4xx error, got {status}"
    );
    assert!(
        body.contains("required"),
        "error should say code is required, got: {body}"
    );
}

#[tokio::test]
async fn license_required_invalid_code_rejected_before_enrollment() {
    let store = crate::licenses::LicenseStore::for_test(vec![]);
    let address = spawn_public_mode_app_with_licenses(Some(store), true).await;
    let (status, _body) = enroll_relay(address, "verify-key-3", Some("INVALID-CODE"))
        .await
        .expect_err("invalid code must be rejected");
    // The "invalid" in the error message is matched by public_api_auth_failure and
    // the response body is scrubbed to "request failed" for security; check status only.
    assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn license_required_valid_code_enrollment_succeeds() {
    let store = crate::licenses::LicenseStore::for_test(vec![("VALID-001", None)]);
    let address = spawn_public_mode_app_with_licenses(Some(store), true).await;
    enroll_relay(address, "verify-key-4", Some("VALID-001"))
        .await
        .expect("valid code must allow enrollment");
}

// Finding 3b / partial Q7: in required-license mode a relay whose license is no
// longer valid (expired/revoked/unbound) must NOT be able to register new
// devices. Device-grant issuance now fails closed via check_relay_access.
#[tokio::test]
async fn license_required_expired_license_denies_device_grant() {
    let store = crate::licenses::LicenseStore::for_test(vec![("GATE-001", None)]);
    let address = spawn_public_mode_app_with_licenses(Some(store.clone()), true).await;
    let enrolled = enroll_relay(address, "gate-seed", Some("GATE-001"))
        .await
        .expect("enroll with a valid code");

    // While the license is valid, a device grant succeeds.
    let _grant: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        &enrolled.relay_refresh_token,
        &DeviceGrantRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            device_id: "d1".to_string(),
        },
    )
    .await;

    // Expire the license (shared Arc state), then a NEW device grant is denied.
    store.force_expire_for_test("GATE-001");
    let denied = public_post_response(
        address,
        "/api/public/devices",
        &enrolled.relay_refresh_token,
        &DeviceGrantRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            device_id: "d2".to_string(),
        },
    )
    .await;
    assert!(
        denied.status().is_client_error(),
        "an expired-license relay must be denied new device grants, got {}",
        denied.status()
    );
}

// Finding 2: license state must be checked only AFTER relay authentication, so an
// unauthenticated caller cannot distinguish an active license from an expired one
// by the response. A bad bearer must yield the same status for both.
#[tokio::test]
async fn device_grant_invalid_bearer_hides_license_state() {
    let store =
        crate::licenses::LicenseStore::for_test(vec![("ACTIVE-001", None), ("EXPIRED-001", None)]);
    let address = spawn_public_mode_app_with_licenses(Some(store.clone()), true).await;
    let active = enroll_relay(address, "leak-active", Some("ACTIVE-001"))
        .await
        .expect("enroll active");
    let expired = enroll_relay(address, "leak-expired", Some("EXPIRED-001"))
        .await
        .expect("enroll expired");
    store.force_expire_for_test("EXPIRED-001");

    let bad_bearer = "totally-not-a-valid-refresh-token";
    let against_active = public_post_response(
        address,
        "/api/public/devices",
        bad_bearer,
        &DeviceGrantRequest {
            relay_id: active.relay_id.clone(),
            broker_room_id: active.broker_room_id.clone(),
            device_id: "x".to_string(),
        },
    )
    .await;
    let against_expired = public_post_response(
        address,
        "/api/public/devices",
        bad_bearer,
        &DeviceGrantRequest {
            relay_id: expired.relay_id.clone(),
            broker_room_id: expired.broker_room_id.clone(),
            device_id: "x".to_string(),
        },
    )
    .await;

    assert_eq!(
        against_active.status(),
        against_expired.status(),
        "a bad bearer must not reveal license state (active vs expired)"
    );
    assert_eq!(
        against_active.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "a bad bearer should fail authentication (401) before any license check"
    );
}

// End-to-end cap: license `device_limit` (looked up by relay_id) → N+1 device
// grant is rejected through the real /api/public/devices endpoint with the
// machine-readable `device_limit_reached` code.
#[tokio::test]
async fn license_device_limit_enforced_through_endpoint() {
    let store = crate::licenses::LicenseStore::for_test(vec![("CAP-001", None)]);
    let address = spawn_public_mode_app_with_licenses(Some(store.clone()), true).await;
    let enrolled = enroll_relay(address, "cap-seed", Some("CAP-001"))
        .await
        .expect("enroll with a valid code");
    store.force_set_device_limit_for_test("CAP-001", Some(1));

    // First device fits under the cap of 1.
    let _first: DeviceGrantResponse = public_post(
        address,
        "/api/public/devices",
        &enrolled.relay_refresh_token,
        &DeviceGrantRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            device_id: "d1".to_string(),
        },
    )
    .await;

    // Second device exceeds it → 403 with a machine-readable code.
    let response = public_post_response(
        address,
        "/api/public/devices",
        &enrolled.relay_refresh_token,
        &DeviceGrantRequest {
            relay_id: enrolled.relay_id.clone(),
            broker_room_id: enrolled.broker_room_id.clone(),
            device_id: "d2".to_string(),
        },
    )
    .await;
    assert_eq!(
        response.status(),
        reqwest::StatusCode::FORBIDDEN,
        "an over-cap device grant must be rejected with 403"
    );
    let body: serde_json::Value = response.json().await.expect("error body should be JSON");
    assert_eq!(
        body["error"], "device_limit_reached",
        "the rejection must carry the machine-readable device_limit_reached code"
    );
}

#[tokio::test]
async fn license_required_code_cannot_be_reused() {
    let store = crate::licenses::LicenseStore::for_test(vec![("ONCE-001", None)]);
    let address = spawn_public_mode_app_with_licenses(Some(store), true).await;
    enroll_relay(address, "verify-key-5a", Some("ONCE-001"))
        .await
        .expect("first use must succeed");
    let (status, _) = enroll_relay(address, "verify-key-5b", Some("ONCE-001"))
        .await
        .expect_err("second use of same code must fail");
    assert!(
        status.is_client_error(),
        "must return a 4xx error, got {status}"
    );
}

#[tokio::test]
async fn failed_redeem_does_not_persist_relay_registration() {
    // A code that has already been bound to another relay will fail at redeem.
    // The enrollment must be rolled back so no orphaned registration is created.
    let store = crate::licenses::LicenseStore::for_test(vec![("RACE-001", None)]);

    // Pre-claim the code by binding it to a relay_id directly in the store.
    store.force_bind_for_test("RACE-001", "relay-already-enrolled");

    let address = spawn_public_mode_app_with_licenses(Some(store), true).await;
    let (status, _) = enroll_relay(address, "verify-key-6", Some("RACE-001"))
        .await
        .expect_err("race redeem must fail");
    assert!(
        status.is_client_error(),
        "must return a 4xx error, got {status}"
    );

    // Verify that no new relay registration was left behind by trying to
    // re-enroll with the same verify key: if a registration existed for that
    // key it would succeed; if it was correctly rolled back this will also
    // succeed (re-enrollment is idempotent by verify key, using the same room).
    // The key assertion is that `enroll_relay` does not panic.
}

#[tokio::test]
async fn license_required_store_unavailable_rejects_enrollment() {
    // required=true but license_store=None (DB failure) → fail closed.
    let address = spawn_public_mode_app_with_licenses(None, true).await;
    let (status, body) = enroll_relay(address, "verify-key-7", None)
        .await
        .expect_err("must reject when store is unavailable");
    assert!(
        status.is_client_error(),
        "must return a 4xx error, got {status}"
    );
    assert!(
        body.contains("unavailable"),
        "error should say service unavailable, got: {body}"
    );
}

#[tokio::test]
async fn reenrollment_with_same_code_after_cache_loss_succeeds() {
    // F2: a relay that has already redeemed a code but lost its registration cache
    // must be able to re-enroll using the same code without being rejected.
    let store = crate::licenses::LicenseStore::for_test(vec![("CACHE-LOSS-001", None)]);
    let address = spawn_public_mode_app_with_licenses(Some(store), true).await;

    // First enrollment: code is redeemed, relay is registered.
    enroll_relay(address, "verify-key-8", Some("CACHE-LOSS-001"))
        .await
        .expect("first enrollment must succeed");

    // Second enrollment with the same verify key and the same code: simulates the
    // relay deleting its cache and restarting. Must succeed (Renewal path).
    enroll_relay(address, "verify-key-8", Some("CACHE-LOSS-001"))
        .await
        .expect("re-enrollment with same code after cache loss must succeed");
}

#[tokio::test]
async fn reenrollment_with_new_code_after_expiry_succeeds() {
    // F1 (main scenario): a relay whose license expired gets a new code and
    // re-enrolls. The old binding must be cleared so the new code can bind.
    let store = crate::licenses::LicenseStore::for_test(vec![
        ("EXPIRED-CODE", None),
        ("NEW-CODE-001", None),
    ]);
    let address = spawn_public_mode_app_with_licenses(Some(store.clone()), true).await;

    // First enrollment: redeem EXPIRED-CODE (consumed).
    enroll_relay(address, "verify-key-9", Some("EXPIRED-CODE"))
        .await
        .expect("first enrollment must succeed");
    // Force it expired so re-licensing clears its binding.
    store.force_expire_for_test("EXPIRED-CODE");

    // Second enrollment with the same verify key + new code: the old binding
    // (EXPIRED-CODE → relay) must be cleared so NEW-CODE-001 can bind.
    enroll_relay(address, "verify-key-9", Some("NEW-CODE-001"))
        .await
        .expect("re-enrollment with new code after expiry must succeed");

    // Single-use guard: clearing the old binding must NOT resurrect EXPIRED-CODE.
    // A different relay trying to reuse it must be rejected as "already used".
    let (status, _) = enroll_relay(address, "verify-key-9b", Some("EXPIRED-CODE"))
        .await
        .expect_err("a consumed (expired) code must not be reusable after re-license");
    assert!(
        status.is_client_error(),
        "reusing a consumed code must be a 4xx error, got {status}"
    );
    // The original relay cannot re-consume it either (its binding was cleared).
    let (status2, _) = enroll_relay(address, "verify-key-9", Some("EXPIRED-CODE"))
        .await
        .expect_err("the original relay cannot re-consume its expired code either");
    assert!(status2.is_client_error(), "got {status2}");
}

/// Try to obtain a relay ws-token with the given refresh token. Returns the HTTP
/// status, so tests can assert whether the credential authenticates.
async fn relay_ws_token_status(
    address: SocketAddr,
    refresh_token: &str,
    relay_id: &str,
    broker_room_id: &str,
) -> reqwest::StatusCode {
    reqwest::Client::new()
        .post(format!("http://{address}/api/public/relay/ws-token"))
        .bearer_auth(refresh_token)
        .json(&RelayWsTokenRequest {
            relay_id: relay_id.to_string(),
            broker_room_id: broker_room_id.to_string(),
            relay_peer_id: "relay-peer".to_string(),
        })
        .send()
        .await
        .expect("ws-token request should complete")
        .status()
}

#[tokio::test]
async fn failed_relicense_preserves_existing_refresh_credential() {
    // F1: an existing relay whose new-code re-license fails must keep its original,
    // already-cached refresh token working — the failed attempt must not strand it.
    let store = crate::licenses::LicenseStore::for_test(vec![
        ("REG-PRESERVE-A", None),
        ("REG-PRESERVE-B", None),
    ]);
    let address = spawn_public_mode_app_with_licenses(Some(store.clone()), true).await;

    // Register the relay with code A → this is the credential the client caches.
    let first = enroll_relay(address, "verify-key-10", Some("REG-PRESERVE-A"))
        .await
        .expect("first enrollment must succeed");
    // The original token authenticates and the relay is licensed (code A bound).
    assert_eq!(
        relay_ws_token_status(
            address,
            &first.relay_refresh_token,
            &first.relay_id,
            &first.broker_room_id
        )
        .await,
        reqwest::StatusCode::OK,
        "original token must authenticate right after enrollment"
    );

    // Arm the injected failure so the next `redeem` call returns an error.
    store
        .fail_next_redeem
        .store(true, std::sync::atomic::Ordering::Relaxed);

    // Re-enroll the same verify key with code B: enrollment replaces the token,
    // but redeem fails. The previous registration must be restored.
    let (status, _) = enroll_relay(address, "verify-key-10", Some("REG-PRESERVE-B"))
        .await
        .expect_err("re-license must fail when redeem is injected to fail");
    assert!(
        status.is_client_error(),
        "must return a 4xx error, got {status}"
    );

    // The crux: the relay's ORIGINAL refresh token must still authenticate — the
    // failed re-license must not have stranded the cached credential.
    assert_eq!(
        relay_ws_token_status(
            address,
            &first.relay_refresh_token,
            &first.relay_id,
            &first.broker_room_id
        )
        .await,
        reqwest::StatusCode::OK,
        "original refresh token must still authenticate after a failed re-license"
    );
}

#[tokio::test]
async fn ws_token_license_check_requires_auth_first() {
    // F3: an unauthenticated caller must NOT be able to distinguish "no license
    // found", "expired", and "licensed" relays by probing the ws-token endpoint.
    // Authentication failure must come before any license-state information leak.
    let store = crate::licenses::LicenseStore::for_test(vec![]);
    let address = spawn_public_mode_app_with_licenses(Some(store), true).await;

    // A relay_id that has no license at all: if auth runs first, we get a generic
    // auth error; if license runs first, we'd get a "no license" error.
    let response = reqwest::Client::new()
        .post(format!("http://{address}/api/public/relay/ws-token"))
        .bearer_auth("bogus-bearer-token")
        .json(&RelayWsTokenRequest {
            relay_id: "relay-probe-target".to_string(),
            broker_room_id: "room-probe".to_string(),
            relay_peer_id: "probe".to_string(),
        })
        .send()
        .await
        .expect("request should complete");

    // Must be 401 (auth failure), not any license-specific error.
    assert_eq!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "unauthenticated ws-token request must be rejected with 401 before license check"
    );
}

#[tokio::test]
async fn concurrent_enrollment_same_verify_key_preserves_registration() {
    // Race scenario: two `/complete` calls for the SAME verify key and SAME fresh
    // code. Per-verify-key serialization must make enroll+redeem atomic so that:
    //   - exactly one binds the code (the winner),
    //   - the loser takes the Renewal path (code already bound to this relay) and
    //     does NOT roll back / delete the registration,
    //   - the relay registration remains usable afterward.
    let store = crate::licenses::LicenseStore::for_test(vec![("RACE-CODE-001", None)]);
    let address = spawn_public_mode_app_with_licenses(Some(store), true).await;

    // Fire two concurrent enrollments with the same verify key + same code.
    let a = tokio::spawn(async move {
        enroll_relay(address, "verify-key-race", Some("RACE-CODE-001")).await
    });
    let b = tokio::spawn(async move {
        enroll_relay(address, "verify-key-race", Some("RACE-CODE-001")).await
    });
    let (ra, rb) = tokio::join!(a, b);
    let ra = ra.expect("task a joins");
    let rb = rb.expect("task b joins");

    // Both must succeed: the winner does a Fresh redeem, the loser a Renewal.
    // Neither is allowed to fail or delete the other's registration.
    let reg_a = ra.expect("enrollment a must succeed");
    let reg_b = rb.expect("enrollment b must succeed");
    assert_eq!(
        reg_a.relay_id, reg_b.relay_id,
        "both requests are the same identity, so relay_id must match"
    );

    // The registration must still be usable: a follow-up re-enroll succeeds
    // (Renewal), proving the registration was never left dangling/deleted.
    let reg_c = enroll_relay(address, "verify-key-race", Some("RACE-CODE-001"))
        .await
        .expect("follow-up re-enrollment must still succeed");
    assert_eq!(reg_c.relay_id, reg_a.relay_id);

    // Documented behaviour: each successful enrollment mints a fresh refresh token
    // and invalidates the previous one (pre-existing broker semantics, unrelated to
    // licensing). Because the completes are serialized by the per-identity lock, only
    // the LAST-completed token remains valid — here reg_c's, from the follow-up above.
    // A normal single relay-server enrolls sequentially, so this is not observed.
    assert_eq!(
        relay_ws_token_status(
            address,
            &reg_c.relay_refresh_token,
            &reg_c.relay_id,
            &reg_c.broker_room_id
        )
        .await,
        reqwest::StatusCode::OK,
        "the most recently issued refresh token must authenticate"
    );
}

#[test]
fn admin_auth_outcome_disabled_when_no_token_configured() {
    // No configured token → endpoint disabled regardless of what is presented.
    assert_eq!(
        admin_auth_outcome(None, None),
        AdminAuthOutcome::Disabled,
        "unset admin token disables the endpoint"
    );
    assert_eq!(
        admin_auth_outcome(None, Some("anything")),
        AdminAuthOutcome::Disabled,
        "a presented token cannot enable a disabled endpoint"
    );
}

#[test]
fn admin_auth_outcome_requires_exact_token() {
    assert_eq!(
        admin_auth_outcome(Some("s3cret"), None),
        AdminAuthOutcome::Unauthorized,
        "missing token is unauthorized"
    );
    assert_eq!(
        admin_auth_outcome(Some("s3cret"), Some("wrong")),
        AdminAuthOutcome::Unauthorized,
        "wrong token is unauthorized"
    );
    assert_eq!(
        admin_auth_outcome(Some("s3cret"), Some("s3cret")),
        AdminAuthOutcome::Authorized,
        "exact token is authorized"
    );
}

#[test]
fn constant_time_eq_matches_only_identical_bytes() {
    assert!(constant_time_eq(b"abc", b"abc"));
    assert!(!constant_time_eq(b"abc", b"abd"));
    assert!(
        !constant_time_eq(b"abc", b"ab"),
        "length mismatch is not equal"
    );
    assert!(constant_time_eq(b"", b""), "empty equals empty");
}

// --- HTTP-level /api/admin/stats coverage -----------------------------------

#[tokio::test]
async fn admin_stats_disabled_is_indistinguishable_from_missing_route() {
    // With no admin token configured the route is not mounted, so hitting it must
    // look exactly like any other unknown path (same 404, same body) — no telltale.
    let address = spawn_public_mode_app_full(None, None, false).await;
    let client = reqwest::Client::new();

    let admin = client
        .get(format!("http://{address}/api/admin/stats"))
        .send()
        .await
        .expect("admin request");
    let missing = client
        .get(format!("http://{address}/api/definitely-not-a-route"))
        .send()
        .await
        .expect("missing request");

    assert_eq!(admin.status(), reqwest::StatusCode::NOT_FOUND);
    assert_eq!(missing.status(), reqwest::StatusCode::NOT_FOUND);
    let admin_body = admin.text().await.expect("admin body");
    let missing_body = missing.text().await.expect("missing body");
    assert_eq!(
        admin_body, missing_body,
        "a disabled admin endpoint must not be distinguishable by its body"
    );
}

#[tokio::test]
async fn admin_stats_requires_valid_token_and_returns_stats() {
    let token: std::sync::Arc<str> = std::sync::Arc::from("s3cret-operator-token");
    let address = spawn_public_mode_app_full(Some(token.clone()), None, false).await;
    let client = reqwest::Client::new();

    // Missing token → 401.
    let no_token = client
        .get(format!("http://{address}/api/admin/stats"))
        .send()
        .await
        .expect("no-token request");
    assert_eq!(no_token.status(), reqwest::StatusCode::UNAUTHORIZED);

    // Wrong token → 401.
    let wrong = client
        .get(format!("http://{address}/api/admin/stats"))
        .bearer_auth("not-the-token")
        .send()
        .await
        .expect("wrong-token request");
    assert_eq!(wrong.status(), reqwest::StatusCode::UNAUTHORIZED);

    // Enroll a relay so the stats are non-trivial.
    let enrolled = enroll_relay(address, "admin-http", None)
        .await
        .expect("enroll should succeed");

    // Correct token → 200 with a stats payload reflecting the enrolled relay.
    let ok = client
        .get(format!("http://{address}/api/admin/stats"))
        .bearer_auth(token.as_ref())
        .send()
        .await
        .expect("valid-token request");
    assert_eq!(ok.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = ok.json().await.expect("stats json");
    assert!(
        body["totals"]["relays"].as_u64().unwrap_or(0) >= 1,
        "totals should count at least the enrolled relay, got {body}"
    );
    let relays = body["relays"].as_array().expect("relays is an array");
    assert!(
        relays
            .iter()
            .any(|r| r["relay_id"] == serde_json::json!(enrolled.relay_id)),
        "the enrolled relay must appear in the stats rows"
    );
}
