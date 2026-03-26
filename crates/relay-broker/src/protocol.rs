use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PeerRole {
    Relay,
    Surface,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PeerSummary {
    pub peer_id: String,
    pub role: PeerRole,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PresenceKind {
    Joined,
    Left,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Publish { payload: Value },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Welcome {
        channel_id: String,
        peer_id: String,
        peers: Vec<PeerSummary>,
    },
    Presence {
        channel_id: String,
        kind: PresenceKind,
        peer: PeerSummary,
    },
    Message {
        channel_id: String,
        from_peer_id: String,
        payload: Value,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectQuery {
    pub peer_id: String,
    pub role: PeerRole,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub service: String,
}
