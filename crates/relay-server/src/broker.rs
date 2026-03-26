mod crypto;

use std::time::Duration;

use futures_util::{sink::SinkExt, stream::StreamExt};
use relay_broker::protocol::{ClientMessage, PeerRole, PresenceKind, ServerMessage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::watch;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use tracing::{debug, info, warn};
use url::Url;

use crate::{
    protocol::{
        ApprovalDecisionInput, ApprovalReceipt, HeartbeatInput, PairedDeviceView,
        ResumeSessionInput, SendMessageInput, SessionSnapshot, StartSessionInput, TakeOverInput,
        ThreadsQuery, ThreadsResponse,
    },
    state::{AppState, ApprovalError},
};

use self::crypto::{decrypt_json, encrypt_json, EncryptedEnvelope};

const RECONNECT_DELAY_SECS: u64 = 2;
type BrokerSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Clone, Debug)]
pub struct BrokerConfig {
    base_url: String,
    url: Url,
    pub channel_id: String,
    pub peer_id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RemoteDeviceAuth {
    device_id: String,
    device_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PairingRequestPlaintext {
    device_id: Option<String>,
    device_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RemoteActionRequest {
    StartSession {
        input: StartSessionInput,
    },
    ResumeSession {
        input: ResumeSessionInput,
    },
    SendMessage {
        input: SendMessageInput,
    },
    TakeOver {
        input: TakeOverInput,
    },
    Heartbeat {
        input: HeartbeatInput,
    },
    ListThreads {
        query: ThreadsQuery,
    },
    DecideApproval {
        request_id: String,
        input: ApprovalDecisionInput,
    },
}

impl RemoteActionRequest {
    fn kind(&self) -> RemoteActionKind {
        match self {
            Self::StartSession { .. } => RemoteActionKind::StartSession,
            Self::ResumeSession { .. } => RemoteActionKind::ResumeSession,
            Self::SendMessage { .. } => RemoteActionKind::SendMessage,
            Self::TakeOver { .. } => RemoteActionKind::TakeOver,
            Self::Heartbeat { .. } => RemoteActionKind::Heartbeat,
            Self::ListThreads { .. } => RemoteActionKind::ListThreads,
            Self::DecideApproval { .. } => RemoteActionKind::DecideApproval,
        }
    }

    fn bind_device(self, device_id: String) -> Self {
        match self {
            Self::StartSession { mut input } => {
                input.device_id = Some(device_id);
                Self::StartSession { input }
            }
            Self::ResumeSession { mut input } => {
                input.device_id = Some(device_id);
                Self::ResumeSession { input }
            }
            Self::SendMessage { mut input } => {
                input.device_id = Some(device_id);
                Self::SendMessage { input }
            }
            Self::TakeOver { mut input } => {
                input.device_id = Some(device_id);
                Self::TakeOver { input }
            }
            Self::Heartbeat { mut input } => {
                input.device_id = Some(device_id);
                Self::Heartbeat { input }
            }
            Self::ListThreads { query } => Self::ListThreads { query },
            Self::DecideApproval {
                request_id,
                mut input,
            } => {
                input.device_id = Some(device_id);
                Self::DecideApproval { request_id, input }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RemoteActionKind {
    StartSession,
    ResumeSession,
    SendMessage,
    TakeOver,
    Heartbeat,
    ListThreads,
    DecideApproval,
}

impl RemoteActionKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::StartSession => "start_session",
            Self::ResumeSession => "resume_session",
            Self::SendMessage => "send_message",
            Self::TakeOver => "take_over",
            Self::Heartbeat => "heartbeat",
            Self::ListThreads => "list_threads",
            Self::DecideApproval => "decide_approval",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum InboundBrokerPayload {
    PairingRequest {
        pairing_id: String,
        envelope: EncryptedEnvelope,
    },
    RemoteAction {
        action_id: String,
        auth: RemoteDeviceAuth,
        request: RemoteActionRequest,
    },
    EncryptedRemoteAction {
        action_id: String,
        device_id: String,
        envelope: EncryptedEnvelope,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum OutboundBrokerPayload {
    SessionSnapshot {
        snapshot: SessionSnapshot,
    },
    RemoteActionResult {
        action_id: String,
        target_peer_id: String,
        action: RemoteActionKind,
        ok: bool,
        snapshot: SessionSnapshot,
        receipt: Option<ApprovalReceipt>,
        threads: Option<ThreadsResponse>,
        error: Option<String>,
    },
    EncryptedSessionSnapshot {
        target_peer_id: String,
        device_id: String,
        envelope: EncryptedEnvelope,
    },
    EncryptedRemoteActionResult {
        action_id: String,
        target_peer_id: String,
        device_id: String,
        envelope: EncryptedEnvelope,
    },
    EncryptedPairingResult {
        pairing_id: String,
        target_peer_id: String,
        envelope: EncryptedEnvelope,
    },
}

#[derive(Debug, Clone, Serialize)]
struct PairingResultPlaintext {
    ok: bool,
    device: Option<PairedDeviceView>,
    device_token: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct RemoteActionResultPlaintext {
    action: RemoteActionKind,
    ok: bool,
    snapshot: SessionSnapshot,
    receipt: Option<ApprovalReceipt>,
    threads: Option<ThreadsResponse>,
    error: Option<String>,
}

#[derive(Debug, Default)]
struct RemoteActionOutcome {
    receipt: Option<ApprovalReceipt>,
    threads: Option<ThreadsResponse>,
}

impl BrokerConfig {
    pub fn from_env() -> Result<Option<Self>, String> {
        Self::from_parts(
            std::env::var("RELAY_BROKER_URL").ok(),
            std::env::var("RELAY_BROKER_CHANNEL_ID").ok(),
            std::env::var("RELAY_BROKER_PEER_ID").ok(),
        )
    }

    fn from_parts(
        url: Option<String>,
        channel_id: Option<String>,
        peer_id: Option<String>,
    ) -> Result<Option<Self>, String> {
        let Some(url) = url.and_then(trimmed_string) else {
            return Ok(None);
        };
        let channel_id = trimmed(channel_id).ok_or_else(|| {
            "RELAY_BROKER_CHANNEL_ID is required when RELAY_BROKER_URL is set".to_string()
        })?;
        let peer_id = trimmed(peer_id).unwrap_or_else(|| "local-relay".to_string());

        let mut url = Url::parse(&url)
            .map_err(|error| format!("invalid RELAY_BROKER_URL `{url}`: {error}"))?;
        let scheme = url.scheme().to_ascii_lowercase();
        if scheme != "ws" && scheme != "wss" {
            return Err("RELAY_BROKER_URL must use ws:// or wss://".to_string());
        }
        let mut base_url = url.clone();
        base_url.set_path("");
        base_url.set_query(None);
        let base_url = base_url.as_str().trim_end_matches('/').to_string();

        {
            let mut segments = url.path_segments_mut().map_err(|_| {
                "RELAY_BROKER_URL cannot be a base URL without path support".to_string()
            })?;
            segments.clear();
            segments.push("ws");
            segments.push(&channel_id);
        }
        url.query_pairs_mut()
            .clear()
            .append_pair("peer_id", &peer_id)
            .append_pair("role", "relay");

        Ok(Some(Self {
            base_url,
            url,
            channel_id,
            peer_id,
        }))
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }
}

pub fn spawn_broker_task(state: AppState) -> Result<(), String> {
    let Some(config) = BrokerConfig::from_env()? else {
        return Ok(());
    };

    info!(
        channel_id = config.channel_id,
        peer_id = config.peer_id,
        broker_url = %config.url,
        "relay-server broker publishing is enabled"
    );

    let change_rx = state.subscribe();
    let broker_state = state.clone();
    tokio::spawn(async move {
        broker_state
            .set_broker_channel(
                Some(config.channel_id.clone()),
                Some(config.peer_id.clone()),
            )
            .await;
        broker_state
            .push_runtime_log(
                "info",
                format!(
                    "Broker publishing enabled for channel {} as {}.",
                    config.channel_id, config.peer_id
                ),
            )
            .await;
        run_broker_loop(broker_state, change_rx, config).await;
    });

    Ok(())
}

async fn run_broker_loop(
    state: AppState,
    mut change_rx: watch::Receiver<u64>,
    config: BrokerConfig,
) {
    loop {
        match run_broker_session(&state, &mut change_rx, &config).await {
            Ok(()) => {
                debug!("broker session ended cleanly");
            }
            Err(error) => {
                warn!(
                    channel_id = config.channel_id,
                    peer_id = config.peer_id,
                    %error,
                    "broker session ended"
                );
                state
                    .push_runtime_log("warn", format!("Broker disconnected: {error}"))
                    .await;
            }
        }

        state.set_broker_connection(false).await;
        tokio::time::sleep(Duration::from_secs(RECONNECT_DELAY_SECS)).await;
    }
}

async fn run_broker_session(
    state: &AppState,
    change_rx: &mut watch::Receiver<u64>,
    config: &BrokerConfig,
) -> Result<(), String> {
    let (socket, _) = connect_async(config.url.as_str())
        .await
        .map_err(|error| format!("failed to connect to broker: {error}"))?;
    let (mut sender, mut receiver) = socket.split();

    let welcome = receiver
        .next()
        .await
        .ok_or_else(|| "broker closed before welcome".to_string())?
        .map_err(|error| format!("broker welcome read failed: {error}"))?;
    match decode_server_frame(welcome)? {
        Some(ServerMessage::Welcome { .. }) => {}
        Some(ServerMessage::Error { message, .. }) => return Err(message),
        Some(other) => {
            return Err(format!(
                "expected broker welcome frame, got {}",
                server_message_name(&other)
            ))
        }
        None => return Err("broker did not send a welcome frame".to_string()),
    }

    state.set_broker_connection(true).await;
    state
        .push_runtime_log(
            "info",
            format!("Connected to broker channel {}.", config.channel_id),
        )
        .await;
    publish_snapshot(&mut sender, state)
        .await
        .map_err(|error| format!("initial broker publish failed: {error}"))?;

    loop {
        tokio::select! {
            changed = change_rx.changed() => {
                changed.map_err(|_| "relay change channel closed".to_string())?;
                publish_snapshot(&mut sender, state)
                    .await
                    .map_err(|error| format!("broker publish failed: {error}"))?;
            }
            incoming = receiver.next() => {
                let Some(frame) = incoming else {
                    return Err("broker socket closed".to_string());
                };
                let frame = frame.map_err(|error| format!("broker receive failed: {error}"))?;
                if let Some(message) = decode_server_frame(frame)? {
                    handle_server_message(state, &mut sender, message).await?;
                }
            }
        }
    }
}

fn decode_server_frame(frame: Message) -> Result<Option<ServerMessage>, String> {
    match frame {
        Message::Text(text) => serde_json::from_str::<ServerMessage>(&text)
            .map(Some)
            .map_err(|error| format!("invalid broker frame: {error}")),
        Message::Ping(_) | Message::Pong(_) => Ok(None),
        Message::Close(_) => Err("broker closed the socket".to_string()),
        Message::Binary(_) => Ok(None),
        _ => Ok(None),
    }
}

async fn handle_server_message(
    state: &AppState,
    sender: &mut futures_util::stream::SplitSink<BrokerSocket, Message>,
    message: ServerMessage,
) -> Result<(), String> {
    match message {
        ServerMessage::Welcome { .. } => Ok(()),
        ServerMessage::Presence {
            channel_id,
            kind,
            peer,
        } => {
            if peer.role == PeerRole::Surface {
                let status = match kind {
                    PresenceKind::Joined => "joined",
                    PresenceKind::Left => "left",
                };
                state
                    .push_runtime_log(
                        "info",
                        format!(
                            "Broker surface {} {status} channel {channel_id}.",
                            peer.peer_id
                        ),
                    )
                    .await;
            }
            Ok(())
        }
        ServerMessage::Message {
            from_peer_id,
            from_role,
            payload,
            ..
        } => {
            if from_role != PeerRole::Surface {
                debug!(
                    from_peer_id,
                    ?from_role,
                    "ignoring broker message from non-surface peer"
                );
                return Ok(());
            }

            match parse_inbound_payload(payload)? {
                Some(InboundBrokerPayload::PairingRequest {
                    pairing_id,
                    envelope,
                }) => {
                    handle_pairing_request(state, sender, from_peer_id, pairing_id, envelope).await
                }
                Some(InboundBrokerPayload::RemoteAction {
                    action_id,
                    auth,
                    request,
                }) => {
                    handle_remote_action(state, sender, from_peer_id, action_id, auth, request)
                        .await
                }
                Some(InboundBrokerPayload::EncryptedRemoteAction {
                    action_id,
                    device_id,
                    envelope,
                }) => {
                    handle_encrypted_remote_action(
                        state,
                        sender,
                        from_peer_id,
                        action_id,
                        device_id,
                        envelope,
                    )
                    .await
                }
                None => Ok(()),
            }
        }
        ServerMessage::Error { message, .. } => Err(message),
    }
}

async fn handle_pairing_request(
    state: &AppState,
    sender: &mut futures_util::stream::SplitSink<BrokerSocket, Message>,
    from_peer_id: String,
    pairing_id: String,
    envelope: EncryptedEnvelope,
) -> Result<(), String> {
    let pairing_secret = state.pending_pairing_secret(&pairing_id).await?;
    let pairing_request: PairingRequestPlaintext = decrypt_json(&pairing_secret, &envelope)?;
    let result = state
        .complete_pairing(
            &pairing_id,
            &pairing_secret,
            pairing_request.device_id,
            pairing_request.device_label,
            &from_peer_id,
        )
        .await;

    let payload = match result {
        Ok((device, token)) => PairingResultPlaintext {
            ok: true,
            device: Some(device),
            device_token: Some(token),
            error: None,
        },
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!("Broker pairing from {} failed: {error}", from_peer_id),
                )
                .await;
            PairingResultPlaintext {
                ok: false,
                device: None,
                device_token: None,
                error: Some(error),
            }
        }
    };
    let encrypted = encrypt_json(&pairing_secret, &payload)?;

    publish_payload(
        sender,
        OutboundBrokerPayload::EncryptedPairingResult {
            pairing_id,
            target_peer_id: from_peer_id,
            envelope: encrypted,
        },
    )
    .await
    .map_err(|error| format!("broker pairing result publish failed: {error}"))
}

async fn handle_remote_action(
    state: &AppState,
    sender: &mut futures_util::stream::SplitSink<BrokerSocket, Message>,
    from_peer_id: String,
    action_id: String,
    auth: RemoteDeviceAuth,
    request: RemoteActionRequest,
) -> Result<(), String> {
    if !state.broker_can_read_content().await {
        return Err("plaintext remote actions are disabled in private mode".to_string());
    }
    let action_kind = request.kind();
    state
        .push_runtime_log(
            "info",
            format!(
                "Broker action `{}` received from {}.",
                action_kind.as_str(),
                from_peer_id
            ),
        )
        .await;

    let result = match state
        .authenticate_remote_device(&auth.device_id, &auth.device_token, &from_peer_id)
        .await
    {
        Ok(device_id) => execute_remote_action(state, request.bind_device(device_id)).await,
        Err(error) => Err(error),
    };
    let snapshot = state.snapshot().await;

    let (ok, receipt, threads, error) = match result {
        Ok(outcome) => (true, outcome.receipt, outcome.threads, None),
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Broker action `{}` from {} failed: {error}",
                        action_kind.as_str(),
                        from_peer_id
                    ),
                )
                .await;
            (false, None, None, Some(error))
        }
    };

    if state.broker_can_read_content().await {
        publish_payload(
            sender,
            OutboundBrokerPayload::RemoteActionResult {
                action_id,
                target_peer_id: from_peer_id,
                action: action_kind,
                ok,
                snapshot,
                receipt,
                threads,
                error,
            },
        )
        .await
        .map_err(|error| format!("broker action result publish failed: {error}"))
    } else {
        publish_remote_action_result_private(
            state,
            sender,
            from_peer_id,
            auth.device_id,
            action_id,
            action_kind,
            snapshot,
            receipt,
            threads,
            error,
            ok,
        )
        .await
    }
}

async fn handle_encrypted_remote_action(
    state: &AppState,
    sender: &mut futures_util::stream::SplitSink<BrokerSocket, Message>,
    from_peer_id: String,
    action_id: String,
    device_id: String,
    envelope: EncryptedEnvelope,
) -> Result<(), String> {
    let action_kind = decrypt_remote_action_kind(state, &device_id, &envelope).await?;
    state
        .push_runtime_log(
            "info",
            format!(
                "Encrypted broker action `{}` received from {}.",
                action_kind.as_str(),
                from_peer_id
            ),
        )
        .await;

    let result = match decrypt_remote_action(state, &device_id, &envelope).await {
        Ok(request) => {
            state
                .mark_remote_device_seen(&device_id, &from_peer_id)
                .await?;
            execute_remote_action(state, request.bind_device(device_id.clone())).await
        }
        Err(error) => Err(error),
    };
    let snapshot = state.snapshot().await;
    let (ok, receipt, threads, error) = match result {
        Ok(outcome) => (true, outcome.receipt, outcome.threads, None),
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Encrypted broker action `{}` from {} failed: {error}",
                        action_kind.as_str(),
                        from_peer_id
                    ),
                )
                .await;
            (false, None, None, Some(error))
        }
    };

    publish_remote_action_result_private(
        state,
        sender,
        from_peer_id,
        device_id,
        action_id,
        action_kind,
        snapshot,
        receipt,
        threads,
        error,
        ok,
    )
    .await
}

async fn execute_remote_action(
    state: &AppState,
    request: RemoteActionRequest,
) -> Result<RemoteActionOutcome, String> {
    match request {
        RemoteActionRequest::StartSession { input } => state
            .start_session(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ResumeSession { input } => state
            .resume_session(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::SendMessage { input } => state
            .send_message(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::TakeOver { input } => state
            .take_over_control(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::Heartbeat { input } => state
            .heartbeat_session(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ListThreads { query } => state
            .list_threads(query.limit.unwrap_or(80).clamp(1, 200), query.cwd)
            .await
            .map(|threads| RemoteActionOutcome {
                receipt: None,
                threads: Some(threads),
            }),
        RemoteActionRequest::DecideApproval { request_id, input } => state
            .decide_approval(&request_id, input)
            .await
            .map(|receipt| RemoteActionOutcome {
                receipt: Some(receipt),
                threads: None,
            })
            .map_err(approval_error_message),
    }
}

async fn decrypt_remote_action_kind(
    state: &AppState,
    device_id: &str,
    envelope: &EncryptedEnvelope,
) -> Result<RemoteActionKind, String> {
    let request = decrypt_remote_action(state, device_id, envelope).await?;
    Ok(request.kind())
}

async fn decrypt_remote_action(
    state: &AppState,
    device_id: &str,
    envelope: &EncryptedEnvelope,
) -> Result<RemoteActionRequest, String> {
    let secret = state.paired_device_secret(device_id).await?;
    decrypt_json(&secret, envelope)
}

async fn publish_remote_action_result_private(
    state: &AppState,
    sender: &mut futures_util::stream::SplitSink<BrokerSocket, Message>,
    target_peer_id: String,
    device_id: String,
    action_id: String,
    action: RemoteActionKind,
    snapshot: SessionSnapshot,
    receipt: Option<ApprovalReceipt>,
    threads: Option<ThreadsResponse>,
    error: Option<String>,
    ok: bool,
) -> Result<(), String> {
    let secret = state.paired_device_secret(&device_id).await?;
    let envelope = encrypt_json(
        &secret,
        &RemoteActionResultPlaintext {
            action,
            ok,
            snapshot,
            receipt,
            threads,
            error,
        },
    )?;

    publish_payload(
        sender,
        OutboundBrokerPayload::EncryptedRemoteActionResult {
            action_id,
            target_peer_id,
            device_id,
            envelope,
        },
    )
    .await
    .map_err(|error| format!("encrypted broker action result publish failed: {error}"))
}

fn approval_error_message(error: ApprovalError) -> String {
    match error {
        ApprovalError::NoPendingRequest => {
            "there is no approval request waiting for a remote decision".to_string()
        }
        ApprovalError::Bridge(message) => message,
    }
}

fn parse_inbound_payload(payload: Value) -> Result<Option<InboundBrokerPayload>, String> {
    let kind = payload.get("kind").and_then(Value::as_str);
    if !matches!(
        kind,
        Some("remote_action" | "pairing_request" | "encrypted_remote_action")
    ) {
        return Ok(None);
    }
    serde_json::from_value(payload)
        .map(Some)
        .map_err(|error| format!("invalid broker payload: {error}"))
}

fn server_message_name(message: &ServerMessage) -> &'static str {
    match message {
        ServerMessage::Welcome { .. } => "welcome",
        ServerMessage::Presence { .. } => "presence",
        ServerMessage::Message { .. } => "message",
        ServerMessage::Error { .. } => "error",
    }
}

async fn publish_snapshot(
    sender: &mut futures_util::stream::SplitSink<BrokerSocket, Message>,
    state: &AppState,
) -> Result<(), String> {
    let snapshot = state.snapshot().await;
    if state.broker_can_read_content().await {
        publish_payload(sender, OutboundBrokerPayload::SessionSnapshot { snapshot })
            .await
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    let targets = state.broker_targets().await;
    for target in targets {
        let envelope = encrypt_json(&target.shared_secret, &snapshot)?;
        publish_payload(
            sender,
            OutboundBrokerPayload::EncryptedSessionSnapshot {
                target_peer_id: target.peer_id,
                device_id: target.device_id,
                envelope,
            },
        )
        .await
        .map_err(|error| error.to_string())?;
    }

    Ok(())
}

async fn publish_payload(
    sender: &mut futures_util::stream::SplitSink<BrokerSocket, Message>,
    payload: OutboundBrokerPayload,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    let frame = ClientMessage::Publish {
        payload: serde_json::to_value(payload).expect("broker payload should serialize"),
    };
    sender
        .send(Message::Text(
            serde_json::to_string(&frame).expect("broker client frame should serialize"),
        ))
        .await
}

fn trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|value| trimmed_string(value))
}

fn trimmed_string(value: String) -> Option<String> {
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broker_config_builds_websocket_url() {
        let config = BrokerConfig::from_parts(
            Some("ws://127.0.0.1:8788".to_string()),
            Some("demo-room".to_string()),
            Some("relay-1".to_string()),
        )
        .expect("config should parse")
        .expect("config should be enabled");

        assert_eq!(config.base_url(), "ws://127.0.0.1:8788");
        assert_eq!(
            config.url.as_str(),
            "ws://127.0.0.1:8788/ws/demo-room?peer_id=relay-1&role=relay"
        );
    }

    #[test]
    fn broker_config_requires_channel() {
        let error = BrokerConfig::from_parts(
            Some("ws://127.0.0.1:8788".to_string()),
            None,
            Some("relay-1".to_string()),
        )
        .expect_err("missing channel should fail");
        assert!(error.contains("RELAY_BROKER_CHANNEL_ID"));
    }

    #[test]
    fn broker_config_disables_when_url_is_missing() {
        let config = BrokerConfig::from_parts(None, Some("demo-room".to_string()), None)
            .expect("missing url should be accepted");
        assert!(config.is_none());
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
                auth,
                request: RemoteActionRequest::SendMessage { input },
            } => {
                assert_eq!(action_id, "act-1");
                assert_eq!(auth.device_id, "phone-1");
                assert_eq!(auth.device_token, "token-1");
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
        let envelope = encrypt_json(
            "pairing-secret",
            &PairingRequestPlaintext {
                device_id: Some("phone-1".to_string()),
                device_label: Some("My Phone".to_string()),
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
                envelope,
            } => {
                assert_eq!(action_id, "act-2");
                assert_eq!(device_id, "phone-1");
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
}
