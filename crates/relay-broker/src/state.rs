use std::{collections::HashMap, sync::Arc};

use tokio::sync::{mpsc, Mutex};

use crate::protocol::{PeerRole, PeerSummary, PresenceKind, ServerMessage};

#[derive(Clone, Default)]
pub struct BrokerState {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    rooms: HashMap<String, RoomState>,
}

struct RoomState {
    peers: HashMap<String, PeerHandle>,
}

struct PeerHandle {
    role: PeerRole,
    tx: mpsc::UnboundedSender<ServerMessage>,
}

#[derive(Debug)]
pub struct JoinResult {
    pub existing_peers: Vec<PeerSummary>,
    pub receiver: mpsc::UnboundedReceiver<ServerMessage>,
}

impl BrokerState {
    pub async fn join(
        &self,
        channel_id: &str,
        peer_id: &str,
        role: PeerRole,
    ) -> Result<JoinResult, String> {
        let (tx, rx) = mpsc::unbounded_channel();
        let joined_peer = PeerSummary {
            peer_id: peer_id.to_string(),
            role,
        };
        let mut inner = self.inner.lock().await;
        let room = inner
            .rooms
            .entry(channel_id.to_string())
            .or_insert_with(RoomState::default);

        if room.peers.contains_key(peer_id) {
            return Err(format!(
                "peer `{peer_id}` is already connected to channel `{channel_id}`"
            ));
        }

        let existing_peers = room
            .peers
            .iter()
            .map(|(peer_id, handle)| PeerSummary {
                peer_id: peer_id.clone(),
                role: handle.role,
            })
            .collect::<Vec<_>>();

        for handle in room.peers.values() {
            let _ = handle.tx.send(ServerMessage::Presence {
                channel_id: channel_id.to_string(),
                kind: PresenceKind::Joined,
                peer: joined_peer.clone(),
            });
        }

        room.peers
            .insert(peer_id.to_string(), PeerHandle { role, tx });

        Ok(JoinResult {
            existing_peers,
            receiver: rx,
        })
    }

    pub async fn leave(&self, channel_id: &str, peer_id: &str) {
        let mut inner = self.inner.lock().await;
        let Some(room) = inner.rooms.get_mut(channel_id) else {
            return;
        };

        let Some(handle) = room.peers.remove(peer_id) else {
            return;
        };

        let left_peer = PeerSummary {
            peer_id: peer_id.to_string(),
            role: handle.role,
        };

        for peer in room.peers.values() {
            let _ = peer.tx.send(ServerMessage::Presence {
                channel_id: channel_id.to_string(),
                kind: PresenceKind::Left,
                peer: left_peer.clone(),
            });
        }

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
        let inner = self.inner.lock().await;
        let Some(room) = inner.rooms.get(channel_id) else {
            return Err(format!("channel `{channel_id}` is not active"));
        };

        if !room.peers.contains_key(from_peer_id) {
            return Err(format!(
                "peer `{from_peer_id}` is not connected to channel `{channel_id}`"
            ));
        }

        let sender_role = room
            .peers
            .get(from_peer_id)
            .expect("sender should exist in room")
            .role;

        for (peer_id, handle) in &room.peers {
            if peer_id == from_peer_id {
                continue;
            }

            let _ = handle.tx.send(ServerMessage::Message {
                channel_id: channel_id.to_string(),
                from_peer_id: from_peer_id.to_string(),
                from_role: sender_role,
                payload: payload.clone(),
            });
        }

        Ok(())
    }
}

impl Default for RoomState {
    fn default() -> Self {
        Self {
            peers: HashMap::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{PresenceKind, ServerMessage};
    use serde_json::json;

    #[tokio::test]
    async fn join_publish_and_leave_broadcast_presence() {
        let state = BrokerState::default();
        let mut relay = state
            .join("room-a", "relay-1", PeerRole::Relay)
            .await
            .expect("relay should join");
        assert!(relay.existing_peers.is_empty());

        let mut surface = state
            .join("room-a", "phone-1", PeerRole::Surface)
            .await
            .expect("surface should join");
        assert_eq!(
            surface.existing_peers,
            vec![PeerSummary {
                peer_id: "relay-1".to_string(),
                role: PeerRole::Relay,
            }]
        );

        let joined = relay
            .receiver
            .recv()
            .await
            .expect("relay should see join presence");
        assert_eq!(
            joined,
            ServerMessage::Presence {
                channel_id: "room-a".to_string(),
                kind: PresenceKind::Joined,
                peer: PeerSummary {
                    peer_id: "phone-1".to_string(),
                    role: PeerRole::Surface,
                },
            }
        );

        state
            .publish("room-a", "relay-1", json!({"ciphertext":"abc"}))
            .await
            .expect("publish should succeed");
        let relayed = surface
            .receiver
            .recv()
            .await
            .expect("surface should receive message");
        assert_eq!(
            relayed,
            ServerMessage::Message {
                channel_id: "room-a".to_string(),
                from_peer_id: "relay-1".to_string(),
                from_role: PeerRole::Relay,
                payload: json!({"ciphertext":"abc"}),
            }
        );

        state.leave("room-a", "phone-1").await;
        let left = relay
            .receiver
            .recv()
            .await
            .expect("relay should see leave presence");
        assert_eq!(
            left,
            ServerMessage::Presence {
                channel_id: "room-a".to_string(),
                kind: PresenceKind::Left,
                peer: PeerSummary {
                    peer_id: "phone-1".to_string(),
                    role: PeerRole::Surface,
                },
            }
        );
    }

    #[tokio::test]
    async fn duplicate_peer_ids_are_rejected_per_channel() {
        let state = BrokerState::default();
        state
            .join("room-a", "phone-1", PeerRole::Surface)
            .await
            .expect("first peer should join");

        let error = state
            .join("room-a", "phone-1", PeerRole::Surface)
            .await
            .expect_err("duplicate peer should fail");
        assert!(error.contains("already connected"));

        state
            .join("room-b", "phone-1", PeerRole::Surface)
            .await
            .expect("same peer id in another channel should work");
    }
}
