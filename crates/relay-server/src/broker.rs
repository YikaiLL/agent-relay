use std::time::Duration;

use futures_util::{sink::SinkExt, stream::StreamExt};
use serde_json::json;
use tokio::sync::watch;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use tracing::{debug, info, warn};
use url::Url;

use crate::{protocol::SessionSnapshot, state::AppState};

const RECONNECT_DELAY_SECS: u64 = 2;
type BrokerSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Clone, Debug)]
pub struct BrokerConfig {
    url: Url,
    pub channel_id: String,
    pub peer_id: String,
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
            url,
            channel_id,
            peer_id,
        }))
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
    handle_server_frame(welcome)?;

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
                handle_server_frame(frame)?;
            }
        }
    }
}

fn handle_server_frame(frame: Message) -> Result<(), String> {
    match frame {
        Message::Text(text) => {
            let payload = serde_json::from_str::<serde_json::Value>(&text)
                .map_err(|error| format!("invalid broker frame: {error}"))?;
            if payload.get("type").and_then(|value| value.as_str()) == Some("error") {
                let message = payload
                    .get("message")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown broker error");
                return Err(message.to_string());
            }
            Ok(())
        }
        Message::Ping(_) | Message::Pong(_) => Ok(()),
        Message::Close(_) => Err("broker closed the socket".to_string()),
        Message::Binary(_) => Ok(()),
        _ => Ok(()),
    }
}

async fn publish_snapshot(
    sender: &mut futures_util::stream::SplitSink<BrokerSocket, Message>,
    snapshot: SessionSnapshot,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    let payload = json!({
        "type": "publish",
        "payload": {
            "kind": "session_snapshot",
            "snapshot": snapshot,
        }
    });
    sender.send(Message::Text(payload.to_string())).await
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
}
