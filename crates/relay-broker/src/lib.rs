pub mod auth;
pub mod join_ticket;
pub mod protocol;
mod state;

pub use state::BrokerState;

use std::path::PathBuf;

use auth::BrokerAuthMode;
use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, Query, State, WebSocketUpgrade,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use futures_util::{sink::SinkExt, StreamExt};
use join_ticket::{JoinTicketClaims, JoinTicketKey, JoinTicketKind, JOIN_TICKET_SECRET_ENV};
use protocol::{ClientMessage, ConnectQuery, HealthResponse, ServerMessage};
use rand::{distributions::Alphanumeric, Rng};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::{debug, warn};

pub fn app(state: BrokerState) -> Router {
    let join_verifier = BrokerJoinVerifier::from_env();
    app_with_web_root_and_verifier(state, default_web_root(), join_verifier)
}

#[derive(Clone)]
struct BrokerAppState {
    broker: BrokerState,
    join_verifier: BrokerJoinVerifier,
}

#[derive(Clone)]
enum BrokerJoinVerifier {
    SelfHosted(JoinTicketKey),
    PublicControlPlane,
    Misconfigured(String),
}

#[derive(Debug)]
struct VerifiedBrokerJoin {
    peer_id: Option<String>,
}

impl BrokerJoinVerifier {
    fn from_env() -> Self {
        match BrokerAuthMode::from_env() {
            Ok(BrokerAuthMode::SelfHostedSharedSecret) => {
                match JoinTicketKey::from_env_var(JOIN_TICKET_SECRET_ENV) {
                    Ok(Some(key)) => Self::SelfHosted(key),
                    Ok(None) => Self::Misconfigured(format!(
                        "{JOIN_TICKET_SECRET_ENV} is required in self-hosted broker auth mode"
                    )),
                    Err(error) => Self::Misconfigured(error),
                }
            }
            Ok(BrokerAuthMode::PublicControlPlane) => Self::PublicControlPlane,
            Err(error) => Self::Misconfigured(error),
        }
    }

    fn verify_connection(
        &self,
        join_ticket: Option<&str>,
        broker_room_id: &str,
        role: protocol::PeerRole,
    ) -> Result<VerifiedBrokerJoin, String> {
        match self {
            Self::SelfHosted(key) => verify_self_hosted_join_ticket_for_connection(
                key,
                join_ticket,
                broker_room_id,
                role,
            )
            .map(|claims| VerifiedBrokerJoin {
                peer_id: claims.peer_id,
            }),
            Self::PublicControlPlane => Err(
                "public broker auth mode is only a boundary scaffold right now; hosted control-plane token verification is not wired yet"
                    .to_string(),
            ),
            Self::Misconfigured(error) => Err(error.clone()),
        }
    }

    fn health_response(&self) -> (StatusCode, HealthResponse) {
        match self {
            Self::SelfHosted(_) => (
                StatusCode::OK,
                HealthResponse {
                    status: "ok".to_string(),
                    service: "relay-broker".to_string(),
                    broker_auth_mode: BrokerAuthMode::SelfHostedSharedSecret
                        .as_str()
                        .to_string(),
                    join_auth_ready: true,
                    message: None,
                },
            ),
            Self::PublicControlPlane => (
                StatusCode::SERVICE_UNAVAILABLE,
                HealthResponse {
                    status: "not_ready".to_string(),
                    service: "relay-broker".to_string(),
                    broker_auth_mode: BrokerAuthMode::PublicControlPlane.as_str().to_string(),
                    join_auth_ready: false,
                    message: Some(
                        "public auth plane boundary exists, but hosted token verification is not wired yet"
                            .to_string(),
                    ),
                },
            ),
            Self::Misconfigured(error) => (
                StatusCode::SERVICE_UNAVAILABLE,
                HealthResponse {
                    status: "misconfigured".to_string(),
                    service: "relay-broker".to_string(),
                    broker_auth_mode: "unknown".to_string(),
                    join_auth_ready: false,
                    message: Some(error.clone()),
                },
            ),
        }
    }
}

fn app_with_web_root_and_verifier(
    state: BrokerState,
    web_root: PathBuf,
    join_verifier: BrokerJoinVerifier,
) -> Router {
    if !web_root.join("remote.html").exists() {
        warn!(
            path = %web_root.join("remote.html").display(),
            "broker web assets are missing; run `npm run build` before serving the remote UI"
        );
    }
    match &join_verifier {
        BrokerJoinVerifier::SelfHosted(_) => {}
        BrokerJoinVerifier::PublicControlPlane => {
            warn!(
                mode = BrokerAuthMode::PublicControlPlane.as_str(),
                "public broker auth mode is boundary-only right now; hosted verifier integration is not wired yet"
            );
        }
        BrokerJoinVerifier::Misconfigured(error) => {
            warn!(%error, "broker websocket joins will be rejected");
        }
    }
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
        .with_state(BrokerAppState {
            broker: state,
            join_verifier,
        })
        .layer(TraceLayer::new_for_http())
}

async fn health(State(state): State<BrokerAppState>) -> impl IntoResponse {
    let (status, payload) = state.join_verifier.health_response();
    (status, Json(payload))
}

async fn websocket(
    ws: WebSocketUpgrade,
    Path(channel_id): Path<String>,
    Query(query): Query<ConnectQuery>,
    State(state): State<BrokerAppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(state, socket, channel_id, query))
}

async fn handle_socket(
    state: BrokerAppState,
    socket: WebSocket,
    channel_id: String,
    query: ConnectQuery,
) {
    if channel_id.trim().is_empty() {
        reject_socket(socket, "invalid_connection", "channel_id is required").await;
        return;
    }

    let verified_join = match state.join_verifier.verify_connection(
        query.join_ticket.as_deref(),
        &channel_id,
        query.role,
    ) {
        Ok(verified_join) => verified_join,
        Err(message) => {
            reject_socket(socket, "join_rejected", &message).await;
            return;
        }
    };

    let mut peer_id = trimmed(query.peer_id).or_else(|| verified_join.peer_id.clone());
    let join = loop {
        let candidate = peer_id
            .clone()
            .unwrap_or_else(|| generated_peer_id(query.role));
        if let Some(expected_peer_id) = verified_join.peer_id.as_deref() {
            if candidate != expected_peer_id {
                reject_socket(
                    socket,
                    "join_rejected",
                    "join_ticket peer_id does not match the requested peer",
                )
                .await;
                return;
            }
        }
        match state.broker.join(&channel_id, &candidate, query.role).await {
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
        state.broker.leave(&channel_id, &peer_id).await;
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
                        if let Err(error) =
                            state.broker.publish(&channel_id, &peer_id, payload).await
                        {
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
    state.broker.leave(&channel_id, &peer_id).await;
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

fn default_web_root() -> PathBuf {
    workspace_root().join("web")
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

fn verify_self_hosted_join_ticket_for_connection(
    key: &JoinTicketKey,
    join_ticket: Option<&str>,
    broker_room_id: &str,
    role: protocol::PeerRole,
) -> Result<JoinTicketClaims, String> {
    let join_ticket = join_ticket
        .map(str::trim)
        .filter(|ticket| !ticket.is_empty())
        .ok_or_else(|| "join_ticket is required".to_string())?;
    let claims = key.verify(join_ticket)?;
    if claims.channel_id != broker_room_id {
        return Err("join_ticket channel does not match this broker room".to_string());
    }
    if claims.role != role {
        return Err("join_ticket role does not match this connection".to_string());
    }
    match (role, claims.kind) {
        (protocol::PeerRole::Relay, JoinTicketKind::RelayJoin) => Ok(claims),
        (
            protocol::PeerRole::Surface,
            JoinTicketKind::PairingSurfaceJoin | JoinTicketKind::DeviceSurfaceJoin,
        ) => Ok(claims),
        (protocol::PeerRole::Relay, _) => Err("join_ticket kind is invalid for relay".to_string()),
        (protocol::PeerRole::Surface, _) => {
            Err("join_ticket kind is invalid for surface".to_string())
        }
    }
}

#[cfg(test)]
mod tests;
