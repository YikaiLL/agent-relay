use std::{collections::HashMap, sync::Arc};

use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};

use crate::events::{UsageEvent, UsageEventKind, UsageEventSink};
use crate::protocol::{PeerRole, PeerSummary, PresenceKind, ServerMessage};

#[derive(Clone, Default)]
pub struct BrokerState {
    inner: Arc<Mutex<Inner>>,
    /// Optional usage event stream. `None` disables usage logging (the default,
    /// e.g. in tests and when the env var is unset).
    events: Option<Arc<dyn UsageEventSink>>,
}

#[derive(Default)]
struct Inner {
    rooms: HashMap<String, RoomState>,
    next_connection_id: u64,
}

struct RoomState {
    peers: HashMap<String, PeerHandle>,
}

struct PeerHandle {
    connection_id: u64,
    role: PeerRole,
    device_id: Option<String>,
    tx: mpsc::UnboundedSender<ServerMessage>,
}

#[derive(Debug)]
pub struct JoinResult {
    pub connection_id: u64,
    pub existing_peers: Vec<PeerSummary>,
    pub receiver: mpsc::UnboundedReceiver<ServerMessage>,
}

impl BrokerState {
    /// Build state that records usage events to the given sink.
    pub fn with_event_sink(sink: Arc<dyn UsageEventSink>) -> Self {
        Self {
            inner: Arc::default(),
            events: Some(sink),
        }
    }

    /// Build state, enabling usage event logging when the environment
    /// configures it (see [`crate::events::USAGE_EVENTS_PATH_ENV`]).
    pub async fn from_env() -> Self {
        match crate::events::usage_event_sink_from_env().await {
            Some(sink) => Self::with_event_sink(sink),
            None => Self::default(),
        }
    }

    fn record_event(&self, event: UsageEvent) {
        if let Some(sink) = &self.events {
            sink.record(event);
        }
    }

    pub async fn join(
        &self,
        channel_id: &str,
        peer_id: &str,
        role: PeerRole,
        device_id: Option<String>,
    ) -> Result<JoinResult, String> {
        let (tx, rx) = mpsc::unbounded_channel();
        let joined_peer = PeerSummary {
            peer_id: peer_id.to_string(),
            role,
            device_id: device_id.clone(),
        };
        let mut inner = self.inner.lock().await;
        inner.next_connection_id = inner.next_connection_id.wrapping_add(1).max(1);
        let connection_id = inner.next_connection_id;
        let room = inner
            .rooms
            .entry(channel_id.to_string())
            .or_insert_with(RoomState::default);

        let replacing_relay = match room.peers.get(peer_id) {
            Some(existing) if existing.role == PeerRole::Relay && role == PeerRole::Relay => {
                info!(
                    channel_id,
                    peer_id,
                    old_connection_id = existing.connection_id,
                    new_connection_id = connection_id,
                    "broker relay peer connection replaced"
                );
                true
            }
            Some(_) => {
                return Err(format!(
                    "peer `{peer_id}` is already connected to channel `{channel_id}`"
                ));
            }
            None => false,
        };

        if replacing_relay {
            let existing = room
                .peers
                .get(peer_id)
                .expect("replaced relay should still be present");
            self.record_event(UsageEvent::new(
                UsageEventKind::Disconnect,
                channel_id,
                peer_id,
                existing.role,
                existing.device_id.clone(),
            ));
        }

        let existing_peers = room
            .peers
            .iter()
            .filter(|(existing_peer_id, _)| existing_peer_id.as_str() != peer_id)
            .map(|(peer_id, handle)| PeerSummary {
                peer_id: peer_id.clone(),
                role: handle.role,
                device_id: handle.device_id.clone(),
            })
            .collect::<Vec<_>>();

        for (existing_peer_id, handle) in &room.peers {
            if existing_peer_id == peer_id {
                continue;
            }
            let _ = handle.tx.send(ServerMessage::Presence {
                channel_id: channel_id.to_string(),
                kind: PresenceKind::Joined,
                peer: joined_peer.clone(),
            });
        }

        room.peers.insert(
            peer_id.to_string(),
            PeerHandle {
                connection_id,
                role,
                device_id,
                tx,
            },
        );

        self.record_event(UsageEvent::new(
            UsageEventKind::Connect,
            channel_id,
            peer_id,
            role,
            joined_peer.device_id,
        ));

        Ok(JoinResult {
            connection_id,
            existing_peers,
            receiver: rx,
        })
    }

    pub async fn leave(&self, channel_id: &str, peer_id: &str) {
        self.leave_inner(channel_id, peer_id, None).await;
    }

    pub async fn leave_connection(&self, channel_id: &str, peer_id: &str, connection_id: u64) {
        self.leave_inner(channel_id, peer_id, Some(connection_id))
            .await;
    }

    async fn leave_inner(
        &self,
        channel_id: &str,
        peer_id: &str,
        expected_connection_id: Option<u64>,
    ) {
        let mut inner = self.inner.lock().await;
        let Some(room) = inner.rooms.get_mut(channel_id) else {
            return;
        };

        if let Some(expected_connection_id) = expected_connection_id {
            let Some(handle) = room.peers.get(peer_id) else {
                return;
            };
            if handle.connection_id != expected_connection_id {
                return;
            }
        }

        let Some(handle) = room.peers.remove(peer_id) else {
            return;
        };

        let left_peer = PeerSummary {
            peer_id: peer_id.to_string(),
            role: handle.role,
            device_id: handle.device_id,
        };

        for peer in room.peers.values() {
            let _ = peer.tx.send(ServerMessage::Presence {
                channel_id: channel_id.to_string(),
                kind: PresenceKind::Left,
                peer: left_peer.clone(),
            });
        }

        self.record_event(UsageEvent::new(
            UsageEventKind::Disconnect,
            channel_id,
            peer_id,
            left_peer.role,
            left_peer.device_id,
        ));

        if room.peers.is_empty() {
            inner.rooms.remove(channel_id);
        }
    }

    pub async fn publish(
        &self,
        channel_id: &str,
        from_peer_id: &str,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        self.publish_inner(channel_id, from_peer_id, None, payload)
            .await
    }

    pub async fn publish_connection(
        &self,
        channel_id: &str,
        from_peer_id: &str,
        connection_id: u64,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        self.publish_inner(channel_id, from_peer_id, Some(connection_id), payload)
            .await
    }

    async fn publish_inner(
        &self,
        channel_id: &str,
        from_peer_id: &str,
        expected_connection_id: Option<u64>,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        let inner = self.inner.lock().await;
        let Some(room) = inner.rooms.get(channel_id) else {
            return Err(format!("channel `{channel_id}` is not active"));
        };

        if !room.peers.contains_key(from_peer_id) {
            return Err(format!(
                "peer `{from_peer_id}` is not connected to channel `{channel_id}`"
            ));
        }

        let sender_handle = room
            .peers
            .get(from_peer_id)
            .expect("sender should exist in room");
        if expected_connection_id
            .is_some_and(|connection_id| sender_handle.connection_id != connection_id)
        {
            return Err(format!(
                "peer `{from_peer_id}` connection has been replaced in channel `{channel_id}`"
            ));
        }
        let sender_role = sender_handle.role;
        let sender_device_id = sender_handle.device_id.clone();
        let outbound_payload_kind = payload_kind(&payload).to_string();

        // Built now (while the sender is known) but only recorded once the
        // publish is accepted below, so the usage stream counts delivered
        // activity rather than malformed frames that fail validation.
        let publish_event = UsageEvent::new(
            UsageEventKind::Publish,
            channel_id,
            from_peer_id,
            sender_role,
            sender_device_id,
        )
        .with_payload_kind(outbound_payload_kind.clone());

        if is_targeted_messages_payload(&payload) {
            let targeted = parse_targeted_messages_payload(payload)?;
            self.record_event(publish_event);
            let target_count = targeted.messages.len();
            let inner_kinds = targeted
                .messages
                .iter()
                .map(|message| payload_kind(&message.payload).to_string())
                .collect::<Vec<_>>()
                .join(",");
            let mut delivered_count = 0usize;
            let mut skipped_sender_count = 0usize;
            let mut missing_target_count = 0usize;
            let mut failed_count = 0usize;
            for message in targeted.messages {
                if message.target_peer_id == from_peer_id {
                    skipped_sender_count += 1;
                    continue;
                }
                let Some(handle) = room.peers.get(&message.target_peer_id) else {
                    missing_target_count += 1;
                    warn!(
                        channel_id,
                        from_peer_id,
                        target_peer_id = %message.target_peer_id,
                        "broker targeted publish target is not connected"
                    );
                    continue;
                };
                if handle
                    .tx
                    .send(ServerMessage::Message {
                        channel_id: channel_id.to_string(),
                        from_peer_id: from_peer_id.to_string(),
                        from_role: sender_role,
                        payload: message.payload,
                    })
                    .is_ok()
                {
                    delivered_count += 1;
                } else {
                    failed_count += 1;
                    warn!(
                        channel_id,
                        from_peer_id,
                        target_peer_id = %message.target_peer_id,
                        "broker targeted publish receiver is closed"
                    );
                }
            }
            info!(
                channel_id,
                from_peer_id,
                target_count,
                delivered_count,
                skipped_sender_count,
                missing_target_count,
                failed_count,
                inner_kinds = %inner_kinds,
                "broker targeted publish fanout"
            );
            return Ok(());
        }

        self.record_event(publish_event);

        let mut recipient_count = 0usize;
        let mut delivered_count = 0usize;
        let mut failed_count = 0usize;
        for (peer_id, handle) in &room.peers {
            if peer_id == from_peer_id {
                continue;
            }

            recipient_count += 1;
            if handle
                .tx
                .send(ServerMessage::Message {
                    channel_id: channel_id.to_string(),
                    from_peer_id: from_peer_id.to_string(),
                    from_role: sender_role,
                    payload: payload.clone(),
                })
                .is_ok()
            {
                delivered_count += 1;
            } else {
                failed_count += 1;
                warn!(
                    channel_id,
                    from_peer_id,
                    target_peer_id = %peer_id,
                    payload_kind = %outbound_payload_kind,
                    "broker publish receiver is closed"
                );
            }
        }
        info!(
            channel_id,
            from_peer_id,
            payload_kind = %outbound_payload_kind,
            recipient_count,
            delivered_count,
            failed_count,
            "broker publish fanout"
        );

        Ok(())
    }
}

#[derive(serde::Deserialize)]
struct TargetedMessagesPayload {
    messages: Vec<TargetedMessagePayload>,
}

#[derive(serde::Deserialize)]
struct TargetedMessagePayload {
    target_peer_id: String,
    payload: serde_json::Value,
}

fn is_targeted_messages_payload(payload: &serde_json::Value) -> bool {
    payload.get("kind").and_then(serde_json::Value::as_str) == Some("targeted_messages")
}

fn payload_kind(payload: &serde_json::Value) -> &str {
    payload
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("-")
}

fn parse_targeted_messages_payload(
    payload: serde_json::Value,
) -> Result<TargetedMessagesPayload, String> {
    let targeted = serde_json::from_value::<TargetedMessagesPayload>(payload)
        .map_err(|error| format!("invalid targeted_messages payload: {error}"))?;
    if targeted
        .messages
        .iter()
        .any(|message| message.target_peer_id.is_empty())
    {
        return Err("invalid targeted_messages payload: target_peer_id is empty".to_string());
    }
    Ok(targeted)
}

impl Default for RoomState {
    fn default() -> Self {
        Self {
            peers: HashMap::new(),
        }
    }
}

#[cfg(test)]
mod tests;
