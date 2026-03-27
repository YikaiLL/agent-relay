use std::{
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::state::AppState;

const SESSION_CLAIM_TTL_SECS: u64 = 3600;
type HmacSha256 = Hmac<Sha256>;
static SESSION_CLAIM_SIGNING_KEY: OnceLock<[u8; 32]> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct SessionClaimPayload {
    pub(super) version: u8,
    pub(super) device_id: String,
    pub(super) peer_id: String,
    pub(super) expires_at: u64,
}

#[derive(Debug, Clone)]
pub(super) struct IssuedSessionClaim {
    pub(super) token: String,
    pub(super) expires_at: u64,
}

pub(super) fn issue_session_claim(
    device_id: &str,
    peer_id: &str,
) -> Result<IssuedSessionClaim, String> {
    let payload = SessionClaimPayload {
        version: 1,
        device_id: device_id.to_string(),
        peer_id: peer_id.to_string(),
        expires_at: unix_now().saturating_add(SESSION_CLAIM_TTL_SECS),
    };
    let payload_bytes = serde_json::to_vec(&payload)
        .map_err(|error| format!("failed to encode session claim: {error}"))?;
    let payload_part = URL_SAFE_NO_PAD.encode(&payload_bytes);
    let signature_part = URL_SAFE_NO_PAD.encode(sign_bytes(payload_part.as_bytes()));

    Ok(IssuedSessionClaim {
        token: format!("{payload_part}.{signature_part}"),
        expires_at: payload.expires_at,
    })
}

pub(super) async fn verify_session_claim(
    state: &AppState,
    token: &str,
    peer_id: &str,
) -> Result<String, String> {
    let payload = decode_and_verify_session_claim(token, peer_id)?;
    state.paired_device_secret(&payload.device_id).await?;
    Ok(payload.device_id)
}

pub(super) fn decode_and_verify_session_claim(
    token: &str,
    peer_id: &str,
) -> Result<SessionClaimPayload, String> {
    let (payload_part, signature_part) = token
        .split_once('.')
        .ok_or_else(|| "session claim is invalid".to_string())?;
    let expected_signature = sign_bytes(payload_part.as_bytes());
    let actual_signature = URL_SAFE_NO_PAD
        .decode(signature_part)
        .map_err(|_| "session claim is invalid".to_string())?;
    if actual_signature != expected_signature {
        return Err("session claim is invalid".to_string());
    }

    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_part)
        .map_err(|_| "session claim is invalid".to_string())?;
    let payload: SessionClaimPayload = serde_json::from_slice(&payload_bytes)
        .map_err(|_| "session claim is invalid".to_string())?;
    if payload.version != 1 {
        return Err("session claim version is unsupported".to_string());
    }
    if payload.peer_id != peer_id {
        return Err("session claim is bound to a different broker peer".to_string());
    }
    if payload.expires_at <= unix_now() {
        return Err("session claim has expired".to_string());
    }
    Ok(payload)
}

fn sign_bytes(payload: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(session_claim_signing_key())
        .expect("session claim signing key should be valid");
    mac.update(payload);
    mac.finalize().into_bytes().to_vec()
}

fn session_claim_signing_key() -> &'static [u8; 32] {
    SESSION_CLAIM_SIGNING_KEY.get_or_init(|| {
        let mut key = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        key
    })
}

pub(super) fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
