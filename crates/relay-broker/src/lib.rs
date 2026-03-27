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
use rand::{distributions::Alphanumeric, Rng};
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
        .route_service(
            "/manifest.webmanifest",
            ServeFile::new(web_root.join("remote-manifest.webmanifest")),
        )
        .route_service("/sw.js", ServeFile::new(web_root.join("remote-sw.js")))
        .route_service("/icon.svg", ServeFile::new(web_root.join("icon.svg")))
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
    if channel_id.trim().is_empty() {
        reject_socket(socket, "invalid_connection", "channel_id is required").await;
        return;
    }

    let mut peer_id = trimmed(query.peer_id);
    let join = loop {
        let candidate = peer_id
            .clone()
            .unwrap_or_else(|| generated_peer_id(query.role));
        match state.join(&channel_id, &candidate, query.role).await {
            Ok(join) => {
                peer_id = Some(candidate);
                break join;
            }
            Err(message) => {
                if peer_id.is_none() && message.contains("is already connected") {
                    continue;
                }
                reject_socket(socket, "join_rejected", &message).await;
                return;
            }
        }
    };
    let peer_id = peer_id.expect("broker should assign a peer id");

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

fn trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn generated_peer_id(role: protocol::PeerRole) -> String {
    let prefix = match role {
        protocol::PeerRole::Relay => "relay",
        protocol::PeerRole::Surface => "surface",
    };
    let suffix = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(12)
        .map(char::from)
        .collect::<String>()
        .to_ascii_lowercase();
    format!("{prefix}-{suffix}")
}

#[cfg(test)]
mod tests;
