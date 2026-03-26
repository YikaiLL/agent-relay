pub mod protocol;
mod state;

pub use state::BrokerState;

use std::path::PathBuf;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, Query, State, WebSocketUpgrade,
    },
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use futures_util::{sink::SinkExt, StreamExt};
use protocol::{ClientMessage, ConnectQuery, HealthResponse, ServerMessage};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::{debug, warn};

pub fn app(state: BrokerState) -> Router {
    let web_root = workspace_root().join("web");
    Router::new()
        .route("/api/health", get(health))
        .route("/ws/:channel_id", get(websocket))
        .route_service("/", ServeFile::new(web_root.join("remote.html")))
        .nest_service("/static", ServeDir::new(web_root))
        .with_state(state)
        .layer(TraceLayer::new_for_http())
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        service: "relay-broker".to_string(),
    })
}

async fn websocket(
    ws: WebSocketUpgrade,
    Path(channel_id): Path<String>,
    Query(query): Query<ConnectQuery>,
    State(state): State<BrokerState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(state, socket, channel_id, query))
}

async fn handle_socket(
    state: BrokerState,
    socket: WebSocket,
    channel_id: String,
    query: ConnectQuery,
) {
    let peer_id = query.peer_id.trim().to_string();
    if channel_id.trim().is_empty() || peer_id.is_empty() {
        reject_socket(
            socket,
            "invalid_connection",
            "channel_id and peer_id are required",
        )
        .await;
        return;
    }

    let join = match state.join(&channel_id, &peer_id, query.role).await {
        Ok(join) => join,
        Err(message) => {
            reject_socket(socket, "join_rejected", &message).await;
            return;
        }
    };

    let (mut sender, mut receiver) = socket.split();
    let welcome = ServerMessage::Welcome {
        channel_id: channel_id.clone(),
        peer_id: peer_id.clone(),
        peers: join.existing_peers,
    };

    if send_message(&mut sender, &welcome).await.is_err() {
        state.leave(&channel_id, &peer_id).await;
        return;
    }

    let mut outbound = join.receiver;
    let send_task = tokio::spawn(async move {
        while let Some(message) = outbound.recv().await {
            if send_message(&mut sender, &message).await.is_err() {
                break;
            }
        }
    });

    while let Some(frame) = receiver.next().await {
        match frame {
            Ok(Message::Text(text)) => {
                let parsed = serde_json::from_str::<ClientMessage>(&text);
                match parsed {
                    Ok(ClientMessage::Publish { payload }) => {
                        if let Err(error) = state.publish(&channel_id, &peer_id, payload).await {
                            warn!(channel_id, peer_id, %error, "failed to publish message");
                        }
                    }
                    Err(error) => {
                        debug!(channel_id, peer_id, %error, "dropping invalid client frame");
                    }
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
            Ok(Message::Binary(_)) => {
                debug!(channel_id, peer_id, "ignoring unexpected binary frame");
            }
            Err(error) => {
                debug!(channel_id, peer_id, %error, "socket receive loop ended");
                break;
            }
        }
    }

    send_task.abort();
    state.leave(&channel_id, &peer_id).await;
}

async fn send_message(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: &ServerMessage,
) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(message).expect("server messages should serialize");
    sender.send(Message::Text(payload)).await
}

async fn reject_socket(socket: WebSocket, code: &str, message: &str) {
    let (mut sender, _) = socket.split();
    let payload = serde_json::to_string(&ServerMessage::Error {
        code: code.to_string(),
        message: message.to_string(),
    })
    .expect("error message should serialize");
    let _ = sender.send(Message::Text(payload)).await;
    let _ = sender.close().await;
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("workspace root should resolve")
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use futures_util::{SinkExt, StreamExt};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{connect_async, tungstenite::Message};

    use super::*;

    async fn spawn_app() -> SocketAddr {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("listener should bind");
        let address = listener.local_addr().expect("listener should have address");
        let app = app(BrokerState::default());
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
        let request =
            format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n");
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

    #[tokio::test]
    async fn root_serves_remote_surface_html() {
        let address = spawn_app().await;
        let response = http_get(address, "/").await;

        assert!(response.contains("200 OK"));
        assert!(response.contains("Remote Broker Surface"));
        assert!(response.contains("/static/remote.js"));
    }

    #[tokio::test]
    async fn websocket_relays_messages_between_peers() {
        let address = spawn_app().await;
        let relay_url = format!("ws://{address}/ws/room-a?peer_id=relay-1&role=relay");
        let surface_url = format!("ws://{address}/ws/room-a?peer_id=phone-1&role=surface");

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
    async fn duplicate_peers_get_error_frame() {
        let address = spawn_app().await;
        let url = format!("ws://{address}/ws/room-a?peer_id=dup-1&role=surface");

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
    }
}
