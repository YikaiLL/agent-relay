use axum::{
    http::{header, HeaderMap, StatusCode, Uri},
    Json,
};
use std::net::IpAddr;

use crate::protocol::ApiError;

const API_TOKEN_ENV: &str = "RELAY_API_TOKEN";
const ALLOW_INSECURE_NO_AUTH_ENV: &str = "RELAY_ALLOW_INSECURE_NO_AUTH";

#[derive(Clone, Debug)]
pub struct AuthConfig {
    token: Option<String>,
    insecure_no_auth_override: bool,
}

impl AuthConfig {
    pub fn from_env_for_bind_host(bind_host: IpAddr) -> Result<Self, String> {
        Self::from_parts(
            normalized(std::env::var(API_TOKEN_ENV).ok()),
            std::env::var(ALLOW_INSECURE_NO_AUTH_ENV).ok(),
            bind_host,
        )
    }

    pub fn enabled(&self) -> bool {
        self.token.is_some()
    }

    pub fn insecure_no_auth_override_active(&self) -> bool {
        self.insecure_no_auth_override
    }

    pub fn authorize(
        &self,
        headers: &HeaderMap,
        _uri: &Uri,
    ) -> Result<(), (StatusCode, Json<ApiError>)> {
        let Some(expected) = self.token.as_deref() else {
            return Ok(());
        };

        let header_token = bearer_token(headers);
        if header_token == Some(expected) {
            Ok(())
        } else {
            Err(unauthorized())
        }
    }
}

impl AuthConfig {
    fn from_parts(
        token: Option<String>,
        allow_insecure_no_auth: Option<String>,
        bind_host: IpAddr,
    ) -> Result<Self, String> {
        let insecure_no_auth_override =
            parse_bool_env(ALLOW_INSECURE_NO_AUTH_ENV, allow_insecure_no_auth)?;
        if !bind_host.is_loopback() && token.is_none() && !insecure_no_auth_override {
            return Err(format!(
                "{API_TOKEN_ENV} is required when BIND_HOST is non-loopback; set {ALLOW_INSECURE_NO_AUTH_ENV}=1 only for explicit insecure development"
            ));
        }

        Ok(Self {
            token,
            insecure_no_auth_override,
        })
    }
}

fn normalized(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let header_value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    header_value.strip_prefix("Bearer ")
}

fn parse_bool_env(name: &str, value: Option<String>) -> Result<bool, String> {
    let Some(value) = normalized(value) else {
        return Ok(false);
    };
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(format!(
            "{name} must be one of: 1, true, yes, on, 0, false, no, off"
        )),
    }
}

fn unauthorized() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(ApiError::new(
            "unauthorized",
            "Missing or invalid API token.",
        )),
    )
}

#[cfg(test)]
mod tests;
