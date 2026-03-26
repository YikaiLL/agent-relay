use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use qrcode::{render::svg, QrCode};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use url::Url;

use crate::protocol::{PairedDeviceView, PairingTicketView};

use super::RelayState;

const DEFAULT_PAIRING_TTL_SECS: u64 = 90;
const MAX_PAIRING_TTL_SECS: u64 = 600;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct PendingPairing {
    pub(crate) pairing_id: String,
    pub(crate) pairing_secret: String,
    pub(crate) secret_hash: String,
    pub(crate) created_at: u64,
    pub(crate) expires_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct PairedDevice {
    pub(crate) device_id: String,
    pub(crate) label: String,
    pub(crate) shared_secret: String,
    pub(crate) token_hash: String,
    pub(crate) created_at: u64,
    pub(crate) last_seen_at: Option<u64>,
    pub(crate) last_peer_id: Option<String>,
}

impl PairedDevice {
    pub(crate) fn to_view(&self) -> PairedDeviceView {
        PairedDeviceView {
            device_id: self.device_id.clone(),
            label: self.label.clone(),
            created_at: self.created_at,
            last_seen_at: self.last_seen_at,
            last_peer_id: self.last_peer_id.clone(),
        }
    }
}

impl RelayState {
    pub fn issue_pairing_ticket(
        &mut self,
        broker_url: &str,
        broker_channel_id: &str,
        relay_peer_id: &str,
        requested_ttl_secs: Option<u64>,
    ) -> PairingTicketView {
        let now = super::super::unix_now();
        self.prune_expired_pairings(now);

        let ttl_secs = requested_ttl_secs
            .unwrap_or(DEFAULT_PAIRING_TTL_SECS)
            .clamp(30, MAX_PAIRING_TTL_SECS);
        let pairing_id = format!("pair-{}", random_token(10).to_ascii_lowercase());
        let pairing_secret = random_token(32);
        let expires_at = now.saturating_add(ttl_secs);

        self.pending_pairings.insert(
            pairing_id.clone(),
            PendingPairing {
                pairing_id: pairing_id.clone(),
                pairing_secret: pairing_secret.clone(),
                secret_hash: sha256_hex(&pairing_secret),
                created_at: now,
                expires_at,
            },
        );

        let pairing_payload = pairing_payload(
            &pairing_id,
            &pairing_secret,
            expires_at,
            broker_url,
            broker_channel_id,
            relay_peer_id,
            self.security.mode(),
        );
        let pairing_url = pairing_url(broker_url, &pairing_payload);
        let pairing_qr_svg = pairing_qr_svg(&pairing_url);

        PairingTicketView {
            pairing_id,
            pairing_secret,
            expires_at,
            broker_url: broker_url.to_string(),
            broker_channel_id: broker_channel_id.to_string(),
            relay_peer_id: relay_peer_id.to_string(),
            security_mode: self.security.mode(),
            pairing_payload,
            pairing_url,
            pairing_qr_svg,
        }
    }

    pub fn consume_pairing_ticket(
        &mut self,
        pairing_id: &str,
        pairing_secret: &str,
        requested_device_id: Option<String>,
        device_label: Option<String>,
        peer_id: &str,
        now: u64,
    ) -> Result<(PairedDeviceView, String), String> {
        self.prune_expired_pairings(now);
        let pending = self
            .pending_pairings
            .get(pairing_id)
            .cloned()
            .ok_or_else(|| "pairing request is missing or expired".to_string())?;

        if pending.secret_hash != sha256_hex(pairing_secret) {
            return Err("pairing secret is invalid".to_string());
        }
        self.pending_pairings.remove(pairing_id);

        let device_id = normalize_remote_device_id(requested_device_id.as_deref())
            .filter(|candidate| !candidate.is_empty())
            .unwrap_or_else(|| format!("device-{}", random_token(8).to_ascii_lowercase()));
        let label_fallback = requested_device_id
            .as_deref()
            .or(Some(peer_id))
            .unwrap_or("Remote Device");
        let label = normalize_device_label(device_label, label_fallback);
        let device_token = random_token(40);
        let token_hash = sha256_hex(&device_token);

        let device = self
            .paired_devices
            .entry(device_id.clone())
            .or_insert_with(|| PairedDevice {
                device_id: device_id.clone(),
                label: label.clone(),
                shared_secret: device_token.clone(),
                token_hash: token_hash.clone(),
                created_at: now,
                last_seen_at: Some(now),
                last_peer_id: Some(peer_id.to_string()),
            });

        device.label = label;
        device.shared_secret = device_token.clone();
        device.token_hash = token_hash;
        device.last_seen_at = Some(now);
        device.last_peer_id = Some(peer_id.to_string());

        Ok((device.to_view(), device_token))
    }

    pub fn authenticate_paired_device(
        &mut self,
        device_id: &str,
        device_token: &str,
        peer_id: &str,
        now: u64,
    ) -> Result<String, String> {
        let device = self
            .paired_devices
            .get_mut(device_id)
            .ok_or_else(|| "device is not paired".to_string())?;
        if device.token_hash != sha256_hex(device_token) {
            return Err("device token is invalid".to_string());
        }

        device.last_seen_at = Some(now);
        device.last_peer_id = Some(peer_id.to_string());
        Ok(device.device_id.clone())
    }

    pub fn revoke_paired_device(&mut self, device_id: &str) -> bool {
        self.paired_devices.remove(device_id).is_some()
    }

    pub fn pending_pairing_secret(&mut self, pairing_id: &str, now: u64) -> Result<String, String> {
        self.prune_expired_pairings(now);
        self.pending_pairings
            .get(pairing_id)
            .map(|pairing| pairing.pairing_secret.clone())
            .ok_or_else(|| "pairing request is missing or expired".to_string())
    }

    pub fn paired_device_shared_secret(&self, device_id: &str) -> Result<String, String> {
        self.paired_devices
            .get(device_id)
            .map(|device| device.shared_secret.clone())
            .ok_or_else(|| "device is not paired".to_string())
    }

    pub fn mark_paired_device_seen(
        &mut self,
        device_id: &str,
        peer_id: &str,
        now: u64,
    ) -> Result<(), String> {
        let device = self
            .paired_devices
            .get_mut(device_id)
            .ok_or_else(|| "device is not paired".to_string())?;
        device.last_seen_at = Some(now);
        device.last_peer_id = Some(peer_id.to_string());
        Ok(())
    }

    pub fn prune_expired_pairings(&mut self, now: u64) {
        self.pending_pairings
            .retain(|_, pairing| pairing.expires_at > now);
    }
}

pub(crate) fn normalize_remote_device_id(value: Option<&str>) -> Option<String> {
    let input = value?.trim().to_ascii_lowercase();
    if input.is_empty() {
        return None;
    }

    let mut normalized = String::new();
    let mut previous_was_dash = false;

    for character in input.chars() {
        if character.is_ascii_alphanumeric() {
            normalized.push(character);
            previous_was_dash = false;
            continue;
        }

        if matches!(character, '-' | '_' | ' ' | '.')
            && !previous_was_dash
            && !normalized.is_empty()
        {
            normalized.push('-');
            previous_was_dash = true;
        }
    }

    while normalized.ends_with('-') {
        normalized.pop();
    }

    if normalized.is_empty() {
        None
    } else {
        normalized.truncate(48);
        Some(normalized)
    }
}

pub(crate) fn normalize_device_label(value: Option<String>, fallback: &str) -> String {
    let label = super::super::non_empty(value).unwrap_or_else(|| fallback.trim().to_string());
    let mut normalized = label.trim().to_string();
    if normalized.is_empty() {
        normalized = "Remote Device".to_string();
    }
    if normalized.chars().count() > 80 {
        normalized = normalized.chars().take(80).collect();
    }
    normalized
}

fn random_token(length: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(length)
        .map(char::from)
        .collect()
}

fn sha256_hex(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

fn pairing_payload(
    pairing_id: &str,
    pairing_secret: &str,
    expires_at: u64,
    broker_url: &str,
    broker_channel_id: &str,
    relay_peer_id: &str,
    security_mode: crate::protocol::SecurityMode,
) -> String {
    let payload = json!({
        "version": 1,
        "pairing_id": pairing_id,
        "pairing_secret": pairing_secret,
        "expires_at": expires_at,
        "broker_url": broker_url,
        "broker_channel_id": broker_channel_id,
        "relay_peer_id": relay_peer_id,
        "security_mode": security_mode,
    });

    URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("pairing payload should serialize"))
}

fn pairing_url(broker_url: &str, pairing_payload: &str) -> String {
    let mut url = browser_url(broker_url);
    url.query_pairs_mut()
        .clear()
        .append_pair("pairing", pairing_payload);
    url.to_string()
}

fn pairing_qr_svg(pairing_url: &str) -> String {
    QrCode::new(pairing_url.as_bytes())
        .expect("pairing url should always encode as qr")
        .render::<svg::Color<'_>>()
        .min_dimensions(240, 240)
        .dark_color(svg::Color("#10211b"))
        .light_color(svg::Color("#f7f4ea"))
        .build()
}

fn browser_url(broker_url: &str) -> Url {
    let mut url = Url::parse(broker_url).expect("broker url should parse");
    let scheme = match url.scheme() {
        "ws" => "http",
        "wss" => "https",
        other => other,
    }
    .to_string();
    let _ = url.set_scheme(&scheme);
    url.set_path("/");
    url.set_query(None);
    url
}
