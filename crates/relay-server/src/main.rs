mod auth;
mod broker;
mod codex;
mod protocol;
mod state;

use std::{convert::Infallible, time::Duration};
use std::{net::SocketAddr, path::PathBuf};

use auth::AuthConfig;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    http::{HeaderMap, Uri},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::stream::{self, StreamExt};
use protocol::{
    ApiEnvelope, ApiError, ApprovalDecisionInput, ApprovalReceipt, HealthResponse, HeartbeatInput,
    ResumeSessionInput, SendMessageInput, SessionSnapshot, StartSessionInput, TakeOverInput,
    ThreadsQuery, ThreadsResponse,
};
use state::{AppState, ApprovalError};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::info;

#[derive(Clone)]
struct AppContext {
    app: AppState,
    auth: AuthConfig,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "relay_server=debug,tower_http=info".into()),
        )
        .init();

    let state = AppState::new()
        .await
        .expect("failed to initialize Codex app-server bridge");
    let auth = AuthConfig::from_env();
    if auth.enabled() {
        info!("relay-server API token auth is enabled for protected /api routes");
    }
    let web_root = workspace_root().join("web");
    let context = AppContext { app: state, auth };

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/session", get(session_snapshot))
        .route("/api/stream", get(session_stream))
        .route("/api/threads", get(list_threads))
        .route("/api/session/start", post(start_session))
        .route("/api/session/resume", post(resume_session))
        .route("/api/session/heartbeat", post(session_heartbeat))
        .route("/api/session/take-over", post(take_over_session))
        .route("/api/session/message", post(send_message))
        .route("/api/approvals/:request_id", post(decide_approval))
        .route_service("/", ServeFile::new(web_root.join("index.html")))
        .nest_service("/static", ServeDir::new(web_root))
        .with_state(context)
        .layer(TraceLayer::new_for_http());

    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8787);
    let address = SocketAddr::from(([127, 0, 0, 1], port));

    info!(
        "relay-server listening on http://localhost:{} (bound to {})",
        port, address
    );

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("failed to bind tcp listener");

    axum::serve(listener, app)
        .await
        .expect("server exited unexpectedly");
}

async fn health() -> Json<ApiEnvelope<HealthResponse>> {
    Json(ApiEnvelope::ok(HealthResponse {
        status: "ok",
        service: "relay-server",
        provider: "codex",
    }))
}

async fn session_snapshot(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    Ok(Json(ApiEnvelope::ok(context.app.snapshot().await)))
}

async fn session_stream(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<
    Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>,
    (StatusCode, Json<ApiError>),
> {
    authorize_api(&context, &headers, &uri)?;
    let initial_state = context.app.clone();
    let updates_state = context.app.clone();
    let receiver = context.app.subscribe();

    let initial = stream::once(async move {
        Ok::<Event, Infallible>(snapshot_event(initial_state.snapshot().await))
    });

    let updates = stream::unfold(
        (updates_state, receiver),
        |(state, mut receiver)| async move {
            if receiver.changed().await.is_err() {
                return None;
            }

            Some((
                Ok::<Event, Infallible>(snapshot_event(state.snapshot().await)),
                (state, receiver),
            ))
        },
    );

    Ok(Sse::new(initial.chain(updates)).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

async fn list_threads(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<ThreadsQuery>,
) -> Result<Json<ApiEnvelope<ThreadsResponse>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    let limit = query.limit.unwrap_or(100).clamp(1, 200);
    context
        .app
        .list_threads(limit, query.cwd)
        .await
        .map(|threads| Json(ApiEnvelope::ok(threads)))
        .map_err(bad_gateway)
}

async fn start_session(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<StartSessionInput>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .start_session(input)
        .await
        .map(|snapshot| Json(ApiEnvelope::ok(snapshot)))
        .map_err(bad_gateway)
}

async fn resume_session(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<ResumeSessionInput>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .resume_session(input)
        .await
        .map(|snapshot| Json(ApiEnvelope::ok(snapshot)))
        .map_err(bad_gateway)
}

async fn send_message(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<SendMessageInput>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .send_message(input)
        .await
        .map(|snapshot| Json(ApiEnvelope::ok(snapshot)))
        .map_err(bad_request)
}

async fn session_heartbeat(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<HeartbeatInput>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .heartbeat_session(input)
        .await
        .map(|snapshot| Json(ApiEnvelope::ok(snapshot)))
        .map_err(bad_request)
}

async fn take_over_session(
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<TakeOverInput>,
) -> Result<Json<ApiEnvelope<SessionSnapshot>>, (StatusCode, Json<ApiError>)> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .take_over_control(input)
        .await
        .map(|snapshot| Json(ApiEnvelope::ok(snapshot)))
        .map_err(bad_request)
}

async fn decide_approval(
    Path(request_id): Path<String>,
    State(context): State<AppContext>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<ApprovalDecisionInput>,
) -> Result<Json<ApiEnvelope<ApprovalReceipt>>, impl IntoResponse> {
    authorize_api(&context, &headers, &uri)?;
    context
        .app
        .decide_approval(&request_id, input)
        .await
        .map(|receipt| Json(ApiEnvelope::ok(receipt)))
        .map_err(|error| match error {
            ApprovalError::NoPendingRequest => (
                StatusCode::NOT_FOUND,
                Json(ApiError::new(
                    "no_pending_request",
                    "There is no approval request waiting for a remote decision.",
                )),
            ),
            ApprovalError::Bridge(message) => (
                StatusCode::BAD_GATEWAY,
                Json(ApiError::new("approval_failed", message)),
            ),
        })
}

fn authorize_api(
    context: &AppContext,
    headers: &HeaderMap,
    uri: &Uri,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    context.auth.authorize(headers, uri)
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("workspace root should resolve")
}

fn bad_request(message: String) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ApiError::new("bad_request", message)),
    )
}

fn bad_gateway(message: String) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::BAD_GATEWAY,
        Json(ApiError::new("codex_bridge_error", message)),
    )
}

fn snapshot_event(snapshot: SessionSnapshot) -> Event {
    match Event::default().event("session").json_data(snapshot) {
        Ok(event) => event,
        Err(error) => Event::default().event("session").data(format!(
            "{{\"ok\":false,\"error\":\"failed_to_encode_snapshot:{error}\"}}"
        )),
    }
}
