mod crypto;
mod remote_actions;
mod session_claim;

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::{sink::SinkExt, stream::StreamExt};
use relay_broker::protocol::{ClientMessage, PeerRole, PresenceKind, ServerMessage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::watch;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use tracing::{debug, info, warn};
use url::Url;

use crate::{
    protocol::{ApprovalReceipt, PairedDeviceView, SessionSnapshot, ThreadsResponse},
    state::{AppState, BrokerPendingMessage},
};

use self::crypto::{decrypt_json, encrypt_json, EncryptedEnvelope};
use self::remote_actions::{
    handle_encrypted_remote_action, handle_remote_action, RemoteActionKind, RemoteActionRequest,
    RemoteDeviceAuth,
};
use self::session_claim::{issue_session_claim, verify_session_claim};

const RECONNECT_DELAY_SECS: u64 = 2;
type BrokerSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Clone, Debug)]
pub struct BrokerConfig {
    public_base_url: String,
    url: Url,
    pub channel_id: String,
    pub peer_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PairingRequestPlaintext {
    device_id: Option<String>,
    device_label: Option<String>,
    device_verify_key: String,
    pairing_proof: String,
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
        session_claim: Option<String>,
        device_id: Option<String>,
        auth: Option<RemoteDeviceAuth>,
        request: RemoteActionRequest,
    },
    EncryptedRemoteAction {
        action_id: String,
        session_claim: Option<String>,
        device_id: Option<String>,
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
        session_claim: Option<String>,
        session_claim_expires_at: Option<u64>,
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

impl BrokerConfig {
    pub fn from_env() -> Result<Option<Self>, String> {
        Self::from_parts(
            std::env::var("RELAY_BROKER_URL").ok(),
            std::env::var("RELAY_BROKER_PUBLIC_URL").ok(),
            std::env::var("RELAY_BROKER_CHANNEL_ID").ok(),
            std::env::var("RELAY_BROKER_PEER_ID").ok(),
        )
    }

    fn from_parts(
        url: Option<String>,
        public_url: Option<String>,
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
        let public_url = public_url
            .and_then(trimmed_string)
            .unwrap_or_else(|| url.clone());

        let mut url = Url::parse(&url)
            .map_err(|error| format!("invalid RELAY_BROKER_URL `{url}`: {error}"))?;
        let scheme = url.scheme().to_ascii_lowercase();
        if scheme != "ws" && scheme != "wss" {
            return Err("RELAY_BROKER_URL must use ws:// or wss://".to_string());
        }

        let mut public_url = Url::parse(&public_url)
            .map_err(|error| format!("invalid RELAY_BROKER_PUBLIC_URL `{public_url}`: {error}"))?;
        let public_scheme = public_url.scheme().to_ascii_lowercase();
        if public_scheme != "ws" && public_scheme != "wss" {
            return Err("RELAY_BROKER_PUBLIC_URL must use ws:// or wss://".to_string());
        }

        public_url.set_path("");
        public_url.set_query(None);
        let public_base_url = public_url.as_str().trim_end_matches('/').to_string();

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
            public_base_url,
            url,
            channel_id,
            peer_id,
        }))
    }

    pub fn public_base_url(&self) -> &str {
        &self.public_base_url
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
    publish_pending_broker_messages(&mut sender, state)
        .await
        .map_err(|error| format!("initial broker direct publish failed: {error}"))?;
    publish_snapshot(&mut sender, state)
        .await
        .map_err(|error| format!("initial broker publish failed: {error}"))?;

    loop {
        tokio::select! {
            changed = change_rx.changed() => {
                changed.map_err(|_| "relay change channel closed".to_string())?;
                publish_pending_broker_messages(&mut sender, state)
                    .await
                    .map_err(|error| format!("broker direct publish failed: {error}"))?;
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
                    session_claim,
                    device_id,
                    auth,
                    request,
                }) => {
                    handle_remote_action(
                        state,
                        sender,
                        from_peer_id,
                        action_id,
                        session_claim,
                        device_id,
                        auth,
                        request,
                    )
                    .await
                }
                Some(InboundBrokerPayload::EncryptedRemoteAction {
                    action_id,
                    session_claim,
                    device_id,
                    envelope,
                }) => {
                    handle_encrypted_remote_action(
                        state,
                        sender,
                        from_peer_id,
                        action_id,
                        session_claim,
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
    state
        .push_runtime_log(
            "info",
            format!(
                "Broker pairing request {} received from {}.",
                pairing_id, from_peer_id
            ),
        )
        .await;
    let pairing_secret = match state.pending_pairing_secret(&pairing_id).await {
        Ok(secret) => secret,
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Broker pairing {} from {} could not be resumed: {error}",
                        pairing_id, from_peer_id
                    ),
                )
                .await;
            return Ok(());
        }
    };
    let pairing_request: PairingRequestPlaintext = decrypt_json(&pairing_secret, &envelope)?;
    if let Err(error) = verify_pairing_request_proof(
        &pairing_id,
        pairing_request.device_id.as_deref(),
        &pairing_request.device_verify_key,
        &pairing_request.pairing_proof,
    ) {
        state
            .push_runtime_log(
                "warn",
                format!(
                    "Broker pairing {} from {} failed proof verification: {error}",
                    pairing_id, from_peer_id
                ),
            )
            .await;
        return Ok(());
    }
    let replay_result = match state
        .completed_pairing_result(
            &pairing_id,
            &pairing_request.device_verify_key,
            &from_peer_id,
        )
        .await
    {
        Ok(result) => result,
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Broker pairing {} from {} could not replay an existing result: {error}",
                        pairing_id, from_peer_id
                    ),
                )
                .await;
            return Ok(());
        }
    };
    if let Some(result) = replay_result {
        publish_pairing_result(sender, result).await?;
        state
            .push_runtime_log(
                "info",
                format!(
                    "Replayed completed pairing result {} to broker peer {}.",
                    pairing_id, from_peer_id
                ),
            )
            .await;
        return Ok(());
    }
    let result = state
        .complete_pairing(
            &pairing_id,
            pairing_request.device_id,
            pairing_request.device_label,
            pairing_request.device_verify_key,
            &from_peer_id,
        )
        .await;
    match result {
        Ok(request) => {
            state
                .push_runtime_log(
                    "info",
                    format!(
                        "Broker pairing {} from {} is waiting for local approval as {}.",
                        pairing_id, from_peer_id, request.device_id
                    ),
                )
                .await;
            Ok(())
        }
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Broker pairing {} from {} failed: {error}",
                        pairing_id, from_peer_id
                    ),
                )
                .await;
            Ok(())
        }
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

async fn publish_pending_broker_messages(
    sender: &mut futures_util::stream::SplitSink<BrokerSocket, Message>,
    state: &AppState,
) -> Result<(), String> {
    for message in state.drain_pending_broker_messages().await {
        match message {
            BrokerPendingMessage::PairingResult(result) => {
                publish_pairing_result(sender, result).await?;
            }
        }
    }
    Ok(())
}

async fn publish_pairing_result(
    sender: &mut futures_util::stream::SplitSink<BrokerSocket, Message>,
    result: crate::state::PendingPairingResult,
) -> Result<(), String> {
    let encrypted = encrypt_json(
        &result.pairing_secret,
        &PairingResultPlaintext {
            ok: result.error.is_none(),
            device: result.device,
            device_token: result.device_token,
            error: result.error,
        },
    )?;
    publish_payload(
        sender,
        OutboundBrokerPayload::EncryptedPairingResult {
            pairing_id: result.pairing_id,
            target_peer_id: result.target_peer_id,
            envelope: encrypted,
        },
    )
    .await
    .map_err(|error| error.to_string())
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

fn verify_pairing_request_proof(
    pairing_id: &str,
    device_id: Option<&str>,
    verify_key_b64: &str,
    signature_b64: &str,
) -> Result<(), String> {
    let verify_key_bytes: [u8; 32] = STANDARD
        .decode(verify_key_b64)
        .map_err(|_| "pairing verify key is invalid".to_string())?
        .try_into()
        .map_err(|_| "pairing verify key is invalid".to_string())?;
    let signature_bytes: [u8; 64] = STANDARD
        .decode(signature_b64)
        .map_err(|_| "pairing proof is invalid".to_string())?
        .try_into()
        .map_err(|_| "pairing proof is invalid".to_string())?;
    let verify_key = VerifyingKey::from_bytes(&verify_key_bytes)
        .map_err(|_| "pairing verify key is invalid".to_string())?;
    let signature = Signature::from_bytes(&signature_bytes);
    verify_key
        .verify(
            pairing_proof_message(pairing_id, device_id).as_bytes(),
            &signature,
        )
        .map_err(|_| "pairing proof is invalid".to_string())
}

fn pairing_proof_message(pairing_id: &str, device_id: Option<&str>) -> String {
    format!(
        "agent-relay:pairing:{}:{}",
        pairing_id,
        device_id.unwrap_or_default()
    )
}

#[cfg(test)]
mod tests;
