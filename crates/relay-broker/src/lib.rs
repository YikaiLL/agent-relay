pub mod auth;
pub mod join_ticket;
pub mod protocol;
pub mod public_control;
mod state;

pub use state::BrokerState;

use std::path::PathBuf;
use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use auth::BrokerAuthMode;
use axum::{
    extract::{
        connect_info::ConnectInfo,
        ws::{Message, WebSocket},
        Path, Query, State, WebSocketUpgrade,
    },
    http::{header::HeaderName, HeaderMap, HeaderValue, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{sink::SinkExt, StreamExt};
use join_ticket::{JoinTicketClaims, JoinTicketKey, JoinTicketKind, JOIN_TICKET_SECRET_ENV};
use protocol::{ClientMessage, ConnectQuery, HealthResponse, ServerMessage};
use public_control::{
    DeviceGrantBulkRevokeRequest, DeviceGrantBulkRevokeResponse, DeviceGrantRequest,
    DeviceGrantResponse, DeviceGrantRevokeRequest, DeviceGrantRevokeResponse,
    DeviceWsTokenResponse, PairingWsTokenRequest, PairingWsTokenResponse, PublicControlPlane,
    RelayWsTokenRequest, RelayWsTokenResponse,
};
use rand::{distributions::Alphanumeric, Rng};
use tokio::{sync::Mutex, time::Instant};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::{debug, warn};

const RATE_LIMIT_WINDOW_SECS: u64 = 60;
const DEFAULT_PUBLIC_API_RATE_LIMIT_PER_MINUTE: usize = 120;
const DEFAULT_JOIN_RATE_LIMIT_PER_MINUTE: usize = 40;
const DEFAULT_PUBLISH_RATE_LIMIT_PER_MINUTE: usize = 240;
const DEFAULT_MAX_CONNECTIONS_PER_IP: usize = 24;
const DEFAULT_MAX_TEXT_FRAME_BYTES: usize = 64 * 1024;
const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 120;
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' http: https: ws: wss:; manifest-src 'self'; worker-src 'self' blob:";
const REFERRER_POLICY: &str = "no-referrer";
const X_CONTENT_TYPE_OPTIONS: &str = "nosniff";

const PUBLIC_API_RATE_LIMIT_ENV: &str = "RELAY_BROKER_PUBLIC_API_RATE_LIMIT_PER_MINUTE";
const JOIN_RATE_LIMIT_ENV: &str = "RELAY_BROKER_JOIN_RATE_LIMIT_PER_MINUTE";
const PUBLISH_RATE_LIMIT_ENV: &str = "RELAY_BROKER_PUBLISH_RATE_LIMIT_PER_MINUTE";
const MAX_CONNECTIONS_PER_IP_ENV: &str = "RELAY_BROKER_MAX_CONNECTIONS_PER_IP";
const MAX_TEXT_FRAME_BYTES_ENV: &str = "RELAY_BROKER_MAX_TEXT_FRAME_BYTES";
const IDLE_TIMEOUT_SECS_ENV: &str = "RELAY_BROKER_IDLE_TIMEOUT_SECS";

pub async fn app(state: BrokerState) -> Router {
    let join_verifier = BrokerJoinVerifier::from_env().await;
    let hardening = match BrokerHardeningConfig::from_env() {
        Ok(config) => config,
        Err(error) => {
            warn!(%error, "invalid broker hardening config; using safe defaults");
            BrokerHardeningConfig::default()
        }
    };
    app_with_web_root_and_verifier_and_hardening(
        state,
        default_web_root(),
        join_verifier,
        hardening,
    )
}

#[derive(Clone)]
struct BrokerAppState {
    broker: BrokerState,
    join_verifier: BrokerJoinVerifier,
    hardening: BrokerHardeningState,
}

#[derive(Clone)]
enum BrokerJoinVerifier {
    SelfHosted(JoinTicketKey),
    PublicControlPlane(PublicControlPlane),
    Misconfigured(String),
}

#[derive(Debug)]
struct VerifiedBrokerJoin {
    peer_id: Option<String>,
}

#[derive(Clone)]
struct BrokerHardeningState {
    config: BrokerHardeningConfig,
    rate_limiter: SlidingWindowRateLimiter,
    connection_tracker: ActiveConnectionTracker,
}

#[derive(Clone, Debug)]
struct BrokerHardeningConfig {
    public_api_rate_limit_per_minute: usize,
    join_rate_limit_per_minute: usize,
    publish_rate_limit_per_minute: usize,
    max_connections_per_ip: usize,
    max_text_frame_bytes: usize,
    idle_timeout: Duration,
}

#[derive(Clone, Default)]
struct SlidingWindowRateLimiter {
    buckets: Arc<Mutex<HashMap<String, VecDeque<Instant>>>>,
}

#[derive(Clone, Default)]
struct ActiveConnectionTracker {
    counts: Arc<StdMutex<HashMap<IpAddr, usize>>>,
}

struct ActiveConnectionPermit {
    tracker: ActiveConnectionTracker,
    remote_ip: IpAddr,
}

impl Default for BrokerHardeningConfig {
    fn default() -> Self {
        Self {
            public_api_rate_limit_per_minute: DEFAULT_PUBLIC_API_RATE_LIMIT_PER_MINUTE,
            join_rate_limit_per_minute: DEFAULT_JOIN_RATE_LIMIT_PER_MINUTE,
            publish_rate_limit_per_minute: DEFAULT_PUBLISH_RATE_LIMIT_PER_MINUTE,
            max_connections_per_ip: DEFAULT_MAX_CONNECTIONS_PER_IP,
            max_text_frame_bytes: DEFAULT_MAX_TEXT_FRAME_BYTES,
            idle_timeout: Duration::from_secs(DEFAULT_IDLE_TIMEOUT_SECS),
        }
    }
}

impl BrokerHardeningConfig {
    fn from_env() -> Result<Self, String> {
        Ok(Self {
            public_api_rate_limit_per_minute: parse_usize_env(
                PUBLIC_API_RATE_LIMIT_ENV,
                DEFAULT_PUBLIC_API_RATE_LIMIT_PER_MINUTE,
            )?,
            join_rate_limit_per_minute: parse_usize_env(
                JOIN_RATE_LIMIT_ENV,
                DEFAULT_JOIN_RATE_LIMIT_PER_MINUTE,
            )?,
            publish_rate_limit_per_minute: parse_usize_env(
                PUBLISH_RATE_LIMIT_ENV,
                DEFAULT_PUBLISH_RATE_LIMIT_PER_MINUTE,
            )?,
            max_connections_per_ip: parse_usize_env(
                MAX_CONNECTIONS_PER_IP_ENV,
                DEFAULT_MAX_CONNECTIONS_PER_IP,
            )?,
            max_text_frame_bytes: parse_usize_env(
                MAX_TEXT_FRAME_BYTES_ENV,
                DEFAULT_MAX_TEXT_FRAME_BYTES,
            )?,
            idle_timeout: Duration::from_secs(parse_u64_env(
                IDLE_TIMEOUT_SECS_ENV,
                DEFAULT_IDLE_TIMEOUT_SECS,
            )?),
        })
    }
}

impl SlidingWindowRateLimiter {
    async fn allow(&self, key: String, limit: usize) -> bool {
        let window = Duration::from_secs(RATE_LIMIT_WINDOW_SECS);
        let now = Instant::now();
        let cutoff = now.checked_sub(window).unwrap_or(now);
        let mut buckets = self.buckets.lock().await;
        let bucket = buckets.entry(key).or_default();
        while bucket.front().is_some_and(|timestamp| *timestamp <= cutoff) {
            bucket.pop_front();
        }
        if bucket.len() >= limit {
            return false;
        }
        bucket.push_back(now);
        true
    }
}

impl ActiveConnectionTracker {
    fn try_acquire(&self, remote_ip: IpAddr, limit: usize) -> Option<ActiveConnectionPermit> {
        let mut counts = self
            .counts
            .lock()
            .expect("active broker connection tracker should not be poisoned");
        let entry = counts.entry(remote_ip).or_insert(0);
        if *entry >= limit {
            return None;
        }
        *entry += 1;
        Some(ActiveConnectionPermit {
            tracker: self.clone(),
            remote_ip,
        })
    }

    fn release(&self, remote_ip: IpAddr) {
        let mut counts = self
            .counts
            .lock()
            .expect("active broker connection tracker should not be poisoned");
        let Some(entry) = counts.get_mut(&remote_ip) else {
            return;
        };
        if *entry <= 1 {
            counts.remove(&remote_ip);
        } else {
            *entry -= 1;
        }
    }
}

impl Drop for ActiveConnectionPermit {
    fn drop(&mut self) {
        self.tracker.release(self.remote_ip);
    }
}

impl BrokerJoinVerifier {
    async fn from_env() -> Self {
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
            Ok(BrokerAuthMode::PublicControlPlane) => match PublicControlPlane::from_env().await {
                Ok(control_plane) => Self::PublicControlPlane(control_plane),
                Err(error) => Self::Misconfigured(error),
            },
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
            Self::PublicControlPlane(control_plane) => verify_join_ticket_for_connection(
                control_plane.issuer_key(),
                join_ticket,
                broker_room_id,
                role,
            )
            .map(|claims| VerifiedBrokerJoin {
                peer_id: claims.peer_id,
            }),
            Self::Misconfigured(error) => Err(error.clone()),
        }
    }

    fn public_control_plane(&self) -> Option<PublicControlPlane> {
        match self {
            Self::PublicControlPlane(control_plane) => Some(control_plane.clone()),
            _ => None,
        }
    }

    fn client_join_error_message(&self) -> &'static str {
        match self {
            Self::SelfHosted(_) | Self::PublicControlPlane(_) | Self::Misconfigured(_) => {
                "broker join rejected"
            }
        }
    }

    fn health_response(&self) -> (StatusCode, HealthResponse) {
        match self {
            Self::SelfHosted(_) => (
                StatusCode::OK,
                HealthResponse {
                    status: "ok".to_string(),
                    service: "relay-broker".to_string(),
                    broker_auth_mode: BrokerAuthMode::SelfHostedSharedSecret.as_str().to_string(),
                    join_auth_ready: true,
                    message: None,
                },
            ),
            Self::PublicControlPlane(_) => (
                StatusCode::OK,
                HealthResponse {
                    status: "ok".to_string(),
                    service: "relay-broker".to_string(),
                    broker_auth_mode: BrokerAuthMode::PublicControlPlane.as_str().to_string(),
                    join_auth_ready: true,
                    message: self
                        .public_control_plane()
                        .and_then(|control_plane| control_plane.health_message()),
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

fn app_with_web_root_and_verifier_and_hardening(
    state: BrokerState,
    web_root: PathBuf,
    join_verifier: BrokerJoinVerifier,
    hardening_config: BrokerHardeningConfig,
) -> Router {
    if !web_root.join("remote.html").exists() {
        warn!(
            path = %web_root.join("remote.html").display(),
            "broker web assets are missing; run `npm run build` before serving the remote UI"
        );
    }
    match &join_verifier {
        BrokerJoinVerifier::SelfHosted(_) => {}
        BrokerJoinVerifier::PublicControlPlane(_) => {}
        BrokerJoinVerifier::Misconfigured(error) => {
            warn!(%error, "broker websocket joins will be rejected");
        }
    }
    Router::new()
        .route("/api/health", get(health))
        .route(
            "/api/public/relay/ws-token",
            post(public_issue_relay_ws_token),
        )
        .route(
            "/api/public/pairing/ws-token",
            post(public_issue_pairing_ws_token),
        )
        .route("/api/public/devices", post(public_issue_device_grant))
        .route(
            "/api/public/device/ws-token",
            post(public_issue_device_ws_token),
        )
        .route(
            "/api/public/devices/:device_id/revoke",
            post(public_revoke_device_grant),
        )
        .route(
            "/api/public/devices/revoke-others",
            post(public_revoke_other_device_grants),
        )
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
            hardening: BrokerHardeningState {
                config: hardening_config,
                rate_limiter: SlidingWindowRateLimiter::default(),
                connection_tracker: ActiveConnectionTracker::default(),
            },
        })
        .layer(middleware::map_response(with_security_headers))
        .layer(TraceLayer::new_for_http())
}

async fn health(State(state): State<BrokerAppState>) -> impl IntoResponse {
    let (status, payload) = state.join_verifier.health_response();
    (status, Json(payload))
}

#[derive(Debug, Clone, serde::Serialize)]
struct ApiErrorBody {
    error: &'static str,
    message: String,
}

async fn public_issue_relay_ws_token(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
    Json(input): Json<RelayWsTokenRequest>,
) -> Result<Json<RelayWsTokenResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "relay_ws_token").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = bearer_token(&headers)?;
    control_plane
        .issue_relay_ws_token(bearer, input)
        .await
        .map(Json)
        .map_err(public_api_error)
}

async fn public_issue_pairing_ws_token(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
    Json(input): Json<PairingWsTokenRequest>,
) -> Result<Json<PairingWsTokenResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "pairing_ws_token").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = bearer_token(&headers)?;
    control_plane
        .issue_pairing_ws_token(bearer, input)
        .await
        .map(Json)
        .map_err(public_api_error)
}

async fn public_issue_device_grant(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
    Json(input): Json<DeviceGrantRequest>,
) -> Result<Json<DeviceGrantResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "device_grant").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = bearer_token(&headers)?;
    control_plane
        .issue_device_grant(bearer, input)
        .await
        .map(Json)
        .map_err(public_api_error)
}

async fn public_issue_device_ws_token(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
) -> Result<Json<DeviceWsTokenResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "device_ws_token").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = bearer_token(&headers)?;
    control_plane
        .issue_device_ws_token(bearer)
        .await
        .map(Json)
        .map_err(public_api_error)
}

async fn public_revoke_device_grant(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    Path(device_id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<DeviceGrantRevokeRequest>,
) -> Result<Json<DeviceGrantRevokeResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "revoke_device_grant").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = bearer_token(&headers)?;
    control_plane
        .revoke_device_grant(bearer, &device_id, input)
        .await
        .map(Json)
        .map_err(public_api_error)
}

async fn public_revoke_other_device_grants(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<BrokerAppState>,
    headers: HeaderMap,
    Json(input): Json<DeviceGrantBulkRevokeRequest>,
) -> Result<Json<DeviceGrantBulkRevokeResponse>, (StatusCode, Json<ApiErrorBody>)> {
    enforce_public_api_rate_limit(&state, remote_addr, "revoke_other_device_grants").await?;
    let control_plane = require_public_control_plane(&state)?;
    let bearer = bearer_token(&headers)?;
    control_plane
        .revoke_other_device_grants(bearer, input)
        .await
        .map(Json)
        .map_err(public_api_error)
}

async fn websocket(
    ws: WebSocketUpgrade,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    Path(channel_id): Path<String>,
    Query(query): Query<ConnectQuery>,
    State(state): State<BrokerAppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(state, socket, remote_addr, channel_id, query))
}

async fn handle_socket(
    state: BrokerAppState,
    socket: WebSocket,
    remote_addr: SocketAddr,
    channel_id: String,
    query: ConnectQuery,
) {
    if channel_id.trim().is_empty() {
        reject_socket(socket, "invalid_connection", "channel_id is required").await;
        return;
    }
    let Some(_connection_permit) = state.hardening.connection_tracker.try_acquire(
        remote_addr.ip(),
        state.hardening.config.max_connections_per_ip,
    ) else {
        reject_socket(
            socket,
            "rate_limited",
            "too many broker connections from this client",
        )
        .await;
        return;
    };
    if !state
        .hardening
        .rate_limiter
        .allow(
            format!("join:{}:{}", remote_addr.ip(), channel_id),
            state.hardening.config.join_rate_limit_per_minute,
        )
        .await
    {
        reject_socket(
            socket,
            "rate_limited",
            "broker join rate limit exceeded for this client",
        )
        .await;
        return;
    }

    let verified_join = match state.join_verifier.verify_connection(
        query.join_ticket.as_deref(),
        &channel_id,
        query.role,
    ) {
        Ok(verified_join) => verified_join,
        Err(message) => {
            debug!(
                remote_ip = %remote_addr.ip(),
                broker_room_id = %channel_id,
                role = ?query.role,
                reason = %scrub_sensitive_message(&message),
                "broker join rejected"
            );
            reject_socket(
                socket,
                "join_rejected",
                state.join_verifier.client_join_error_message(),
            )
            .await;
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
                debug!(
                    remote_ip = %remote_addr.ip(),
                    broker_room_id = %channel_id,
                    role = ?query.role,
                    "broker join rejected because the requested peer_id did not match the verified ticket"
                );
                reject_socket(
                    socket,
                    "join_rejected",
                    state.join_verifier.client_join_error_message(),
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
                debug!(
                    remote_ip = %remote_addr.ip(),
                    broker_room_id = %channel_id,
                    role = ?query.role,
                    reason = %scrub_sensitive_message(&message),
                    "broker join failed"
                );
                reject_socket(
                    socket,
                    "join_rejected",
                    state.join_verifier.client_join_error_message(),
                )
                .await;
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
    let idle_timeout = state.hardening.config.idle_timeout;
    let idle_deadline = Instant::now() + idle_timeout;
    let idle_sleep = tokio::time::sleep_until(idle_deadline);
    tokio::pin!(idle_sleep);

    loop {
        tokio::select! {
            outbound_message = outbound.recv() => {
                let Some(message) = outbound_message else {
                    break;
                };
                if send_message(&mut sender, &message).await.is_err() {
                    break;
                }
                idle_sleep.as_mut().reset(Instant::now() + idle_timeout);
            }
            _ = &mut idle_sleep => {
                let _ = send_message(
                    &mut sender,
                    &ServerMessage::Error {
                        code: "idle_timeout".to_string(),
                        message: "broker socket closed after being idle for too long".to_string(),
                    },
                )
                .await;
                break;
            }
            frame = receiver.next() => {
                let Some(frame) = frame else {
                    break;
                };
                idle_sleep.as_mut().reset(Instant::now() + idle_timeout);
                match frame {
                    Ok(Message::Text(text)) => {
                        if text.len() > state.hardening.config.max_text_frame_bytes {
                            let _ = send_message(
                                &mut sender,
                                &ServerMessage::Error {
                                    code: "frame_too_large".to_string(),
                                    message: format!(
                                        "client text frames must be {} bytes or smaller",
                                        state.hardening.config.max_text_frame_bytes
                                    ),
                                },
                            )
                            .await;
                            break;
                        }

                        let parsed = serde_json::from_str::<ClientMessage>(&text);
                        match parsed {
                            Ok(ClientMessage::Publish { payload }) => {
                                if !state
                                    .hardening
                                    .rate_limiter
                                    .allow(
                                        format!("publish:{channel_id}:{peer_id}"),
                                        state.hardening.config.publish_rate_limit_per_minute,
                                    )
                                    .await
                                {
                                    let _ = send_message(
                                        &mut sender,
                                        &ServerMessage::Error {
                                            code: "rate_limited".to_string(),
                                            message: "broker publish rate limit exceeded for this peer".to_string(),
                                        },
                                    )
                                    .await;
                                    break;
                                }
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
                    Ok(Message::Ping(payload)) => {
                        if sender.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Ok(Message::Pong(_)) => {}
                    Ok(Message::Binary(bytes)) => {
                        if bytes.len() > state.hardening.config.max_text_frame_bytes {
                            let _ = send_message(
                                &mut sender,
                                &ServerMessage::Error {
                                    code: "frame_too_large".to_string(),
                                    message: format!(
                                        "client binary frames must be {} bytes or smaller",
                                        state.hardening.config.max_text_frame_bytes
                                    ),
                                },
                            )
                            .await;
                            break;
                        }
                        debug!(channel_id, peer_id, "ignoring unexpected binary frame");
                    }
                    Err(error) => {
                        debug!(channel_id, peer_id, %error, "socket receive loop ended");
                        break;
                    }
                }
            }
        }
    }
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
    verify_join_ticket_for_connection(key, join_ticket, broker_room_id, role)
}

fn verify_join_ticket_for_connection(
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

fn require_public_control_plane(
    state: &BrokerAppState,
) -> Result<PublicControlPlane, (StatusCode, Json<ApiErrorBody>)> {
    state.join_verifier.public_control_plane().ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(ApiErrorBody {
                error: "not_found",
                message: "public control-plane endpoints are unavailable in this auth mode"
                    .to_string(),
            }),
        )
    })
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, (StatusCode, Json<ApiErrorBody>)> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(ApiErrorBody {
                    error: "unauthorized",
                    message: "missing bearer token".to_string(),
                }),
            )
        })?;
    Ok(value)
}

fn public_api_error(message: String) -> (StatusCode, Json<ApiErrorBody>) {
    let status = if public_api_auth_failure(&message) {
        StatusCode::UNAUTHORIZED
    } else {
        StatusCode::BAD_REQUEST
    };
    let message = if status == StatusCode::UNAUTHORIZED {
        "request failed".to_string()
    } else {
        scrub_sensitive_message(&message)
    };
    (
        status,
        Json(ApiErrorBody {
            error: if status == StatusCode::UNAUTHORIZED {
                "unauthorized"
            } else {
                "bad_request"
            },
            message,
        }),
    )
}

fn public_api_auth_failure(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("invalid")
        || lower.contains("does not match")
        || lower.contains("missing bearer token")
}

async fn enforce_public_api_rate_limit(
    state: &BrokerAppState,
    remote_addr: SocketAddr,
    route_name: &str,
) -> Result<(), (StatusCode, Json<ApiErrorBody>)> {
    if state
        .hardening
        .rate_limiter
        .allow(
            format!("public-api:{}:{route_name}", remote_addr.ip()),
            state.hardening.config.public_api_rate_limit_per_minute,
        )
        .await
    {
        return Ok(());
    }

    Err((
        StatusCode::TOO_MANY_REQUESTS,
        Json(ApiErrorBody {
            error: "rate_limited",
            message: "public broker control-plane rate limit exceeded".to_string(),
        }),
    ))
}

fn scrub_sensitive_message(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if [
        "pairing_secret",
        "refresh_token",
        "join_ticket",
        "ws_token",
        "authorization",
        "bearer ",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return "request failed".to_string();
    }
    message.to_string()
}

fn parse_u64_env(name: &str, default: u64) -> Result<u64, String> {
    match std::env::var(name) {
        Ok(value) => value
            .trim()
            .parse::<u64>()
            .map_err(|error| format!("{name} must be a positive integer: {error}")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid utf-8")),
    }
}

fn parse_usize_env(name: &str, default: usize) -> Result<usize, String> {
    match std::env::var(name) {
        Ok(value) => value
            .trim()
            .parse::<usize>()
            .map_err(|error| format!("{name} must be a positive integer: {error}")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid utf-8")),
    }
}

async fn with_security_headers<B>(mut response: Response<B>) -> Response<B> {
    apply_security_headers(response.headers_mut());
    response
}

fn apply_security_headers(headers: &mut HeaderMap) {
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static(REFERRER_POLICY),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static(X_CONTENT_TYPE_OPTIONS),
    );
}

#[cfg(test)]
mod tests;
