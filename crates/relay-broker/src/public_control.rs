use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{fs, sync::Mutex};

use crate::join_ticket::{unix_now, JoinTicketClaims, JoinTicketKey};

pub const PUBLIC_ISSUER_SECRET_ENV: &str = "RELAY_BROKER_PUBLIC_ISSUER_SECRET";
pub const PUBLIC_RELAY_REGISTRATIONS_ENV: &str = "RELAY_BROKER_PUBLIC_RELAYS_JSON";
pub const PUBLIC_STATE_PATH_ENV: &str = "RELAY_BROKER_PUBLIC_STATE_PATH";
pub const PUBLIC_RELAY_WS_TTL_SECS_ENV: &str = "RELAY_BROKER_PUBLIC_RELAY_WS_TTL_SECS";
pub const PUBLIC_DEVICE_WS_TTL_SECS_ENV: &str = "RELAY_BROKER_PUBLIC_DEVICE_WS_TTL_SECS";

const DEFAULT_PUBLIC_RELAY_WS_TTL_SECS: u64 = 300;
const DEFAULT_PUBLIC_DEVICE_WS_TTL_SECS: u64 = 300;
const PUBLIC_CONTROL_STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayRegistrationConfig {
    pub relay_id: String,
    pub broker_room_id: String,
    pub refresh_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayWsTokenRequest {
    pub relay_id: String,
    pub broker_room_id: String,
    pub relay_peer_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayWsTokenResponse {
    pub relay_id: String,
    pub broker_room_id: String,
    pub relay_ws_token: String,
    pub relay_ws_token_expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingWsTokenRequest {
    pub relay_id: String,
    pub broker_room_id: String,
    pub pairing_id: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingWsTokenResponse {
    pub relay_id: String,
    pub broker_room_id: String,
    pub pairing_join_ticket: String,
    pub pairing_join_ticket_expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceGrantRequest {
    pub relay_id: String,
    pub broker_room_id: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceGrantResponse {
    pub relay_id: String,
    pub broker_room_id: String,
    pub device_id: String,
    pub device_refresh_token: String,
    pub device_ws_token: String,
    pub device_ws_token_expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceWsTokenResponse {
    pub broker_room_id: String,
    pub device_id: String,
    pub device_ws_token: String,
    pub device_ws_token_expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceGrantRevokeRequest {
    pub relay_id: String,
    pub broker_room_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceGrantRevokeResponse {
    pub relay_id: String,
    pub broker_room_id: String,
    pub device_id: String,
    pub revoked: bool,
    pub revoked_grant_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceGrantBulkRevokeRequest {
    pub relay_id: String,
    pub broker_room_id: String,
    pub keep_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceGrantBulkRevokeResponse {
    pub relay_id: String,
    pub broker_room_id: String,
    pub kept_device_id: String,
    pub revoked_device_ids: Vec<String>,
    pub revoked_count: usize,
}

#[derive(Clone)]
pub struct PublicControlPlane {
    inner: Arc<PublicControlPlaneInner>,
}

struct PublicControlPlaneInner {
    issuer_key: JoinTicketKey,
    relay_registrations: HashMap<String, RelayRegistration>,
    relay_ws_ttl_secs: u64,
    device_ws_ttl_secs: u64,
    state_path: Option<PathBuf>,
    device_grants: Mutex<DeviceGrantStore>,
}

#[derive(Debug, Clone)]
struct RelayRegistration {
    relay_id: String,
    broker_room_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedPublicControlState {
    schema_version: u32,
    #[serde(default)]
    device_grants: Vec<PersistedDeviceGrant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedDeviceGrant {
    relay_id: String,
    broker_room_id: String,
    device_id: String,
    refresh_token_hash: String,
    created_at: u64,
}

#[derive(Debug, Default)]
struct DeviceGrantStore {
    grants_by_hash: HashMap<String, PersistedDeviceGrant>,
}

impl PublicControlPlane {
    pub async fn from_env() -> Result<Self, String> {
        Self::from_parts(
            std::env::var(PUBLIC_ISSUER_SECRET_ENV).ok(),
            std::env::var(PUBLIC_RELAY_REGISTRATIONS_ENV).ok(),
            std::env::var(PUBLIC_STATE_PATH_ENV).ok(),
            std::env::var(PUBLIC_RELAY_WS_TTL_SECS_ENV).ok(),
            std::env::var(PUBLIC_DEVICE_WS_TTL_SECS_ENV).ok(),
        )
        .await
    }

    pub async fn from_parts(
        issuer_secret: Option<String>,
        relay_registrations_json: Option<String>,
        state_path: Option<String>,
        relay_ws_ttl_secs: Option<String>,
        device_ws_ttl_secs: Option<String>,
    ) -> Result<Self, String> {
        let issuer_secret = trimmed(issuer_secret).ok_or_else(|| {
            format!("{PUBLIC_ISSUER_SECRET_ENV} is required in public broker auth mode")
        })?;
        let issuer_key = JoinTicketKey::from_secret(issuer_secret.as_bytes())?;
        let relay_registrations = parse_relay_registrations(relay_registrations_json)?
            .into_iter()
            .map(|registration| {
                (
                    sha256_hex(&registration.refresh_token),
                    RelayRegistration {
                        relay_id: registration.relay_id,
                        broker_room_id: registration.broker_room_id,
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        if relay_registrations.is_empty() {
            return Err(format!(
                "{PUBLIC_RELAY_REGISTRATIONS_ENV} must contain at least one relay registration in public broker auth mode"
            ));
        }

        let state_path = trimmed(state_path).map(PathBuf::from);
        let device_grants = DeviceGrantStore::load(state_path.as_deref()).await?;

        Ok(Self {
            inner: Arc::new(PublicControlPlaneInner {
                issuer_key,
                relay_registrations,
                relay_ws_ttl_secs: parse_optional_u64(
                    PUBLIC_RELAY_WS_TTL_SECS_ENV,
                    relay_ws_ttl_secs,
                )?
                .unwrap_or(DEFAULT_PUBLIC_RELAY_WS_TTL_SECS),
                device_ws_ttl_secs: parse_optional_u64(
                    PUBLIC_DEVICE_WS_TTL_SECS_ENV,
                    device_ws_ttl_secs,
                )?
                .unwrap_or(DEFAULT_PUBLIC_DEVICE_WS_TTL_SECS),
                state_path,
                device_grants: Mutex::new(device_grants),
            }),
        })
    }

    pub fn issuer_key(&self) -> &JoinTicketKey {
        &self.inner.issuer_key
    }

    pub async fn issue_relay_ws_token(
        &self,
        bearer_token: &str,
        request: RelayWsTokenRequest,
    ) -> Result<RelayWsTokenResponse, String> {
        let registration =
            self.authenticate_relay(bearer_token, &request.relay_id, &request.broker_room_id)?;
        let expires_at = unix_now().saturating_add(self.inner.relay_ws_ttl_secs);
        Ok(RelayWsTokenResponse {
            relay_id: registration.relay_id.clone(),
            broker_room_id: registration.broker_room_id.clone(),
            relay_ws_token: self.inner.issuer_key.mint(
                &JoinTicketClaims::relay_join_with_expiry(
                    &registration.broker_room_id,
                    &request.relay_peer_id,
                    Some(expires_at),
                ),
            )?,
            relay_ws_token_expires_at: expires_at,
        })
    }

    pub async fn issue_pairing_ws_token(
        &self,
        bearer_token: &str,
        request: PairingWsTokenRequest,
    ) -> Result<PairingWsTokenResponse, String> {
        let registration =
            self.authenticate_relay(bearer_token, &request.relay_id, &request.broker_room_id)?;
        Ok(PairingWsTokenResponse {
            relay_id: registration.relay_id.clone(),
            broker_room_id: registration.broker_room_id.clone(),
            pairing_join_ticket: self.inner.issuer_key.mint(
                &JoinTicketClaims::pairing_surface_join(
                    &registration.broker_room_id,
                    &request.pairing_id,
                    request.expires_at,
                ),
            )?,
            pairing_join_ticket_expires_at: request.expires_at,
        })
    }

    pub async fn issue_device_grant(
        &self,
        bearer_token: &str,
        request: DeviceGrantRequest,
    ) -> Result<DeviceGrantResponse, String> {
        let registration =
            self.authenticate_relay(bearer_token, &request.relay_id, &request.broker_room_id)?;
        let refresh_token = format!("dref-{}", random_token(40).to_ascii_lowercase());
        let refresh_token_hash = sha256_hex(&refresh_token);
        let created_at = unix_now();

        let mut store = self.inner.device_grants.lock().await;
        store.remove_device_grants(&registration.relay_id, None, Some(&request.device_id));
        store.grants_by_hash.insert(
            refresh_token_hash.clone(),
            PersistedDeviceGrant {
                relay_id: registration.relay_id.clone(),
                broker_room_id: registration.broker_room_id.clone(),
                device_id: request.device_id.clone(),
                refresh_token_hash,
                created_at,
            },
        );
        store.save(self.inner.state_path.as_deref()).await?;

        let issued =
            self.issue_device_ws_token_for_registration(&registration, &request.device_id)?;
        Ok(DeviceGrantResponse {
            relay_id: registration.relay_id.clone(),
            broker_room_id: registration.broker_room_id.clone(),
            device_id: request.device_id,
            device_refresh_token: refresh_token,
            device_ws_token: issued.device_ws_token,
            device_ws_token_expires_at: issued.device_ws_token_expires_at,
        })
    }

    pub async fn issue_device_ws_token(
        &self,
        bearer_token: &str,
    ) -> Result<DeviceWsTokenResponse, String> {
        let token_hash = sha256_hex(bearer_token.trim());
        let store = self.inner.device_grants.lock().await;
        let grant = store
            .grants_by_hash
            .get(&token_hash)
            .cloned()
            .ok_or_else(|| "device refresh token is invalid".to_string())?;
        let registration = RelayRegistration {
            relay_id: grant.relay_id,
            broker_room_id: grant.broker_room_id,
        };
        self.issue_device_ws_token_for_registration(&registration, &grant.device_id)
    }

    pub async fn revoke_device_grant(
        &self,
        bearer_token: &str,
        device_id: &str,
        request: DeviceGrantRevokeRequest,
    ) -> Result<DeviceGrantRevokeResponse, String> {
        let registration =
            self.authenticate_relay(bearer_token, &request.relay_id, &request.broker_room_id)?;
        let mut store = self.inner.device_grants.lock().await;
        let revoked_grant_count = store.remove_device_grants(
            &registration.relay_id,
            Some(&registration.broker_room_id),
            Some(device_id),
        );
        if revoked_grant_count > 0 {
            store.save(self.inner.state_path.as_deref()).await?;
        }
        Ok(DeviceGrantRevokeResponse {
            relay_id: registration.relay_id.clone(),
            broker_room_id: registration.broker_room_id.clone(),
            device_id: device_id.to_string(),
            revoked: revoked_grant_count > 0,
            revoked_grant_count,
        })
    }

    pub async fn revoke_other_device_grants(
        &self,
        bearer_token: &str,
        request: DeviceGrantBulkRevokeRequest,
    ) -> Result<DeviceGrantBulkRevokeResponse, String> {
        let registration =
            self.authenticate_relay(bearer_token, &request.relay_id, &request.broker_room_id)?;
        let mut store = self.inner.device_grants.lock().await;
        let revoked_device_ids = store.remove_all_other_device_grants(
            &registration.relay_id,
            &registration.broker_room_id,
            &request.keep_device_id,
        );
        if !revoked_device_ids.is_empty() {
            store.save(self.inner.state_path.as_deref()).await?;
        }
        Ok(DeviceGrantBulkRevokeResponse {
            relay_id: registration.relay_id.clone(),
            broker_room_id: registration.broker_room_id.clone(),
            kept_device_id: request.keep_device_id,
            revoked_count: revoked_device_ids.len(),
            revoked_device_ids,
        })
    }

    fn authenticate_relay(
        &self,
        bearer_token: &str,
        relay_id: &str,
        broker_room_id: &str,
    ) -> Result<RelayRegistration, String> {
        let token_hash = sha256_hex(bearer_token.trim());
        let registration = self
            .inner
            .relay_registrations
            .get(&token_hash)
            .ok_or_else(|| "relay refresh token is invalid".to_string())?;
        if registration.relay_id != relay_id {
            return Err("relay refresh token does not match relay_id".to_string());
        }
        if registration.broker_room_id != broker_room_id {
            return Err("relay refresh token does not match broker_room_id".to_string());
        }
        Ok(registration.clone())
    }

    fn issue_device_ws_token_for_registration(
        &self,
        registration: &RelayRegistration,
        device_id: &str,
    ) -> Result<DeviceWsTokenResponse, String> {
        let expires_at = unix_now().saturating_add(self.inner.device_ws_ttl_secs);
        Ok(DeviceWsTokenResponse {
            broker_room_id: registration.broker_room_id.clone(),
            device_id: device_id.to_string(),
            device_ws_token: self
                .inner
                .issuer_key
                .mint(&JoinTicketClaims::device_surface_join(
                    &registration.broker_room_id,
                    device_id,
                    Some(expires_at),
                ))?,
            device_ws_token_expires_at: expires_at,
        })
    }
}

impl DeviceGrantStore {
    async fn load(path: Option<&Path>) -> Result<Self, String> {
        let Some(path) = path else {
            return Ok(Self::default());
        };
        let bytes = match fs::read(path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default())
            }
            Err(error) => {
                return Err(format!(
                    "failed to read public control-plane state {}: {error}",
                    path.display()
                ))
            }
        };
        let persisted: PersistedPublicControlState =
            serde_json::from_slice(&bytes).map_err(|error| {
                format!(
                    "failed to decode public control-plane state {}: {error}",
                    path.display()
                )
            })?;
        if persisted.schema_version != PUBLIC_CONTROL_STATE_VERSION {
            return Err(format!(
                "unsupported public control-plane state schema {} in {}",
                persisted.schema_version,
                path.display()
            ));
        }
        Ok(Self {
            grants_by_hash: persisted
                .device_grants
                .into_iter()
                .map(|grant| (grant.refresh_token_hash.clone(), grant))
                .collect(),
        })
    }

    async fn save(&self, path: Option<&Path>) -> Result<(), String> {
        let Some(path) = path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
        }
        let payload = serde_json::to_vec_pretty(&PersistedPublicControlState {
            schema_version: PUBLIC_CONTROL_STATE_VERSION,
            device_grants: self.grants_by_hash.values().cloned().collect(),
        })
        .map_err(|error| format!("failed to encode public control-plane state: {error}"))?;
        let temp_path = path.with_extension("tmp");
        fs::write(&temp_path, payload)
            .await
            .map_err(|error| format!("failed to write {}: {error}", temp_path.display()))?;
        fs::rename(&temp_path, path)
            .await
            .map_err(|error| format!("failed to replace {}: {error}", path.display()))?;
        Ok(())
    }

    fn remove_device_grants(
        &mut self,
        relay_id: &str,
        broker_room_id: Option<&str>,
        device_id: Option<&str>,
    ) -> usize {
        let mut removed = 0;
        self.grants_by_hash.retain(|_, grant| {
            let matches = grant.relay_id == relay_id
                && broker_room_id
                    .map(|value| value == grant.broker_room_id)
                    .unwrap_or(true)
                && device_id
                    .map(|value| value == grant.device_id)
                    .unwrap_or(true);
            if matches {
                removed += 1;
            }
            !matches
        });
        removed
    }

    fn remove_all_other_device_grants(
        &mut self,
        relay_id: &str,
        broker_room_id: &str,
        keep_device_id: &str,
    ) -> Vec<String> {
        let mut revoked_device_ids = Vec::new();
        self.grants_by_hash.retain(|_, grant| {
            let revoke = grant.relay_id == relay_id
                && grant.broker_room_id == broker_room_id
                && grant.device_id != keep_device_id;
            if revoke && !revoked_device_ids.iter().any(|id| id == &grant.device_id) {
                revoked_device_ids.push(grant.device_id.clone());
            }
            !revoke
        });
        revoked_device_ids.sort();
        revoked_device_ids
    }
}

fn parse_relay_registrations(
    value: Option<String>,
) -> Result<Vec<RelayRegistrationConfig>, String> {
    let raw = trimmed(value).ok_or_else(|| {
        format!("{PUBLIC_RELAY_REGISTRATIONS_ENV} is required in public broker auth mode")
    })?;
    let parsed: Vec<RelayRegistrationConfig> = serde_json::from_str(&raw)
        .map_err(|error| format!("{PUBLIC_RELAY_REGISTRATIONS_ENV} must be valid JSON: {error}"))?;
    for registration in &parsed {
        if registration.relay_id.trim().is_empty() {
            return Err(format!(
                "{PUBLIC_RELAY_REGISTRATIONS_ENV} entries must include relay_id"
            ));
        }
        if registration.broker_room_id.trim().is_empty() {
            return Err(format!(
                "{PUBLIC_RELAY_REGISTRATIONS_ENV} entries must include broker_room_id"
            ));
        }
        if registration.refresh_token.trim().is_empty() {
            return Err(format!(
                "{PUBLIC_RELAY_REGISTRATIONS_ENV} entries must include refresh_token"
            ));
        }
    }
    Ok(parsed)
}

fn parse_optional_u64(name: &str, value: Option<String>) -> Result<Option<u64>, String> {
    let Some(value) = trimmed(value) else {
        return Ok(None);
    };
    value
        .parse::<u64>()
        .map(Some)
        .map_err(|error| format!("{name} must be a positive integer: {error}"))
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

fn trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}
