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
    },
    state::{AppState, ApprovalError},
};

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

#[derive(Debug, Clone, Deserialize)]
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
            Self::DecideApproval => "decide_approval",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum InboundBrokerPayload {
    PairingRequest {
        pairing_id: String,
        pairing_secret: String,
        device_id: Option<String>,
        device_label: Option<String>,
    },
    RemoteAction {
        action_id: String,
        auth: RemoteDeviceAuth,
        request: RemoteActionRequest,
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
        error: Option<String>,
    },
    PairingResult {
        pairing_id: String,
        target_peer_id: String,
        ok: bool,
        device: Option<PairedDeviceView>,
        device_token: Option<String>,
        error: Option<String>,
    },
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
    publish_snapshot(&mut sender, state.snapshot().await)
        .await
        .map_err(|error| format!("initial broker publish failed: {error}"))?;

    loop {
        tokio::select! {
            changed = change_rx.changed() => {
                changed.map_err(|_| "relay change channel closed".to_string())?;
                publish_snapshot(&mut sender, state.snapshot().await)
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
                    pairing_secret,
                    device_id,
                    device_label,
                }) => {
                    handle_pairing_request(
                        state,
                        sender,
                        from_peer_id,
                        pairing_id,
                        pairing_secret,
                        device_id,
                        device_label,
                    )
                    .await
                }
                Some(InboundBrokerPayload::RemoteAction {
                    action_id,
                    auth,
                    request,
                }) => {
                    handle_remote_action(state, sender, from_peer_id, action_id, auth, request)
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
    pairing_secret: String,
    device_id: Option<String>,
    device_label: Option<String>,
) -> Result<(), String> {
    let result = state
        .complete_pairing(
            &pairing_id,
            &pairing_secret,
            device_id,
            device_label,
            &from_peer_id,
        )
        .await;

    let (ok, device, device_token, error) = match result {
        Ok((device, token)) => (true, Some(device), Some(token), None),
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!("Broker pairing from {} failed: {error}", from_peer_id),
                )
                .await;
            (false, None, None, Some(error))
        }
    };

    publish_payload(
        sender,
        OutboundBrokerPayload::PairingResult {
            pairing_id,
            target_peer_id: from_peer_id,
            ok,
            device,
            device_token,
            error,
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

    let (ok, receipt, error) = match result {
        Ok(receipt) => (true, receipt, None),
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
            (false, None, Some(error))
        }
    };

    publish_payload(
        sender,
        OutboundBrokerPayload::RemoteActionResult {
            action_id,
            target_peer_id: from_peer_id,
            action: action_kind,
            ok,
            snapshot,
            receipt,
            error,
        },
    )
    .await
    .map_err(|error| format!("broker action result publish failed: {error}"))
}

async fn execute_remote_action(
    state: &AppState,
    request: RemoteActionRequest,
) -> Result<Option<ApprovalReceipt>, String> {
    match request {
        RemoteActionRequest::StartSession { input } => {
            state.start_session(input).await.map(|_| None)
        }
        RemoteActionRequest::ResumeSession { input } => {
            state.resume_session(input).await.map(|_| None)
        }
        RemoteActionRequest::SendMessage { input } => state.send_message(input).await.map(|_| None),
        RemoteActionRequest::TakeOver { input } => {
            state.take_over_control(input).await.map(|_| None)
        }
        RemoteActionRequest::Heartbeat { input } => {
            state.heartbeat_session(input).await.map(|_| None)
        }
        RemoteActionRequest::DecideApproval { request_id, input } => state
            .decide_approval(&request_id, input)
            .await
            .map(Some)
            .map_err(approval_error_message),
    }
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
    if !matches!(kind, Some("remote_action" | "pairing_request")) {
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
    snapshot: SessionSnapshot,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    publish_payload(sender, OutboundBrokerPayload::SessionSnapshot { snapshot }).await
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
    fn parse_inbound_payload_parses_pairing_requests() {
        let payload = serde_json::json!({
            "kind": "pairing_request",
            "pairing_id": "pair-1",
            "pairing_secret": "secret-1",
            "device_id": "phone-1",
            "device_label": "My Phone"
        });

        let request = parse_inbound_payload(payload)
            .expect("payload should parse")
            .expect("pairing request should be handled");
        match request {
            InboundBrokerPayload::PairingRequest {
                pairing_id,
                pairing_secret,
                device_id,
                device_label,
            } => {
                assert_eq!(pairing_id, "pair-1");
                assert_eq!(pairing_secret, "secret-1");
                assert_eq!(device_id.as_deref(), Some("phone-1"));
                assert_eq!(device_label.as_deref(), Some("My Phone"));
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
