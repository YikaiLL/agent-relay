use relay_broker::{
    auth::{BrokerAuthMode, BROKER_AUTH_MODE_ENV},
    join_ticket::{unix_now, JoinTicketClaims, JoinTicketKey, JOIN_TICKET_SECRET_ENV},
};
use url::Url;

pub(crate) const RELAY_BROKER_RELAY_WS_TOKEN_ENV: &str = "RELAY_BROKER_RELAY_WS_TOKEN";
pub(crate) const RELAY_BROKER_DEVICE_JOIN_TTL_SECS_ENV: &str = "RELAY_BROKER_DEVICE_JOIN_TTL_SECS";

#[derive(Clone, Debug)]
pub(crate) struct BrokerJoinCredential {
    pub(crate) token: String,
    pub(crate) expires_at: Option<u64>,
}

#[derive(Clone, Debug)]
pub(crate) enum BrokerAuthConfig {
    SelfHostedSharedSecret {
        join_ticket_key: JoinTicketKey,
        device_join_ttl_secs: Option<u64>,
    },
    PublicControlPlane {
        relay_ws_token: String,
    },
}

impl BrokerAuthConfig {
    pub(crate) fn from_parts(
        auth_mode: Option<String>,
        join_ticket_secret: Option<String>,
        relay_ws_token: Option<String>,
        device_join_ttl_secs: Option<String>,
    ) -> Result<Self, String> {
        match BrokerAuthMode::parse(auth_mode)? {
            BrokerAuthMode::SelfHostedSharedSecret => {
                let join_ticket_secret = trimmed(join_ticket_secret).ok_or_else(|| {
                    format!("{JOIN_TICKET_SECRET_ENV} is required in self-hosted broker auth mode")
                })?;
                let join_ticket_key = JoinTicketKey::from_secret(join_ticket_secret.as_bytes())?;
                Ok(Self::SelfHostedSharedSecret {
                    join_ticket_key,
                    device_join_ttl_secs: parse_optional_u64_env(
                        RELAY_BROKER_DEVICE_JOIN_TTL_SECS_ENV,
                        device_join_ttl_secs,
                    )?,
                })
            }
            BrokerAuthMode::PublicControlPlane => {
                let relay_ws_token = trimmed(relay_ws_token).ok_or_else(|| {
                    format!(
                        "{RELAY_BROKER_RELAY_WS_TOKEN_ENV} is required in public broker auth mode"
                    )
                })?;
                Ok(Self::PublicControlPlane { relay_ws_token })
            }
        }
    }

    pub(crate) fn mode(&self) -> BrokerAuthMode {
        match self {
            Self::SelfHostedSharedSecret { .. } => BrokerAuthMode::SelfHostedSharedSecret,
            Self::PublicControlPlane { .. } => BrokerAuthMode::PublicControlPlane,
        }
    }

    pub(crate) fn apply_relay_connect_query(
        &self,
        url: &mut Url,
        broker_room_id: &str,
        relay_peer_id: &str,
    ) -> Result<(), String> {
        let relay_token = match self {
            Self::SelfHostedSharedSecret {
                join_ticket_key, ..
            } => join_ticket_key
                .mint(&JoinTicketClaims::relay_join(broker_room_id, relay_peer_id))?,
            Self::PublicControlPlane { relay_ws_token } => relay_ws_token.clone(),
        };

        url.query_pairs_mut()
            .clear()
            .append_pair("peer_id", relay_peer_id)
            .append_pair("role", "relay")
            .append_pair("join_ticket", &relay_token);
        Ok(())
    }

    pub(crate) fn pairing_join_credential(
        &self,
        broker_room_id: &str,
        pairing_id: &str,
        expires_at: u64,
    ) -> Result<BrokerJoinCredential, String> {
        match self {
            Self::SelfHostedSharedSecret {
                join_ticket_key, ..
            } => Ok(BrokerJoinCredential {
                token: join_ticket_key.mint(&JoinTicketClaims::pairing_surface_join(
                    broker_room_id,
                    pairing_id,
                    expires_at,
                ))?,
                expires_at: Some(expires_at),
            }),
            Self::PublicControlPlane { .. } => Err(format!(
                "public broker auth mode requires hosted pairing token issuance; set {BROKER_AUTH_MODE_ENV}=self_hosted for local pairing today"
            )),
        }
    }

    pub(crate) fn device_join_credential(
        &self,
        broker_room_id: &str,
        device_id: &str,
    ) -> Result<BrokerJoinCredential, String> {
        match self {
            Self::SelfHostedSharedSecret {
                join_ticket_key,
                device_join_ttl_secs,
            } => {
                let expires_at = device_join_ttl_secs
                    .map(|ttl| unix_now().saturating_add(ttl))
                    .filter(|expires_at| *expires_at > 0);
                Ok(BrokerJoinCredential {
                    token: join_ticket_key.mint(&JoinTicketClaims::device_surface_join(
                        broker_room_id,
                        device_id,
                        expires_at,
                    ))?,
                    expires_at,
                })
            }
            Self::PublicControlPlane { .. } => Err(format!(
                "public broker auth mode requires hosted device token issuance; set {BROKER_AUTH_MODE_ENV}=self_hosted for local pairing today"
            )),
        }
    }

    pub(crate) fn device_join_ttl_secs(&self) -> Option<u64> {
        match self {
            Self::SelfHostedSharedSecret {
                device_join_ttl_secs,
                ..
            } => *device_join_ttl_secs,
            Self::PublicControlPlane { .. } => None,
        }
    }
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

fn parse_optional_u64_env(name: &str, value: Option<String>) -> Result<Option<u64>, String> {
    let Some(value) = trimmed(value) else {
        return Ok(None);
    };
    value
        .parse::<u64>()
        .map(Some)
        .map_err(|error| format!("{name} must be a positive integer: {error}"))
}
