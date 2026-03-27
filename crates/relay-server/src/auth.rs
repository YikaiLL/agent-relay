use axum::{
    http::{header, HeaderMap, StatusCode, Uri},
    Json,
};
use url::form_urlencoded;

use crate::protocol::ApiError;

#[derive(Clone, Debug)]
pub struct AuthConfig {
    token: Option<String>,
}

impl AuthConfig {
    pub fn from_env() -> Self {
        Self {
            token: normalized(std::env::var("RELAY_API_TOKEN").ok()),
        }
    }

    pub fn enabled(&self) -> bool {
        self.token.is_some()
    }

    pub fn authorize(
        &self,
        headers: &HeaderMap,
        uri: &Uri,
    ) -> Result<(), (StatusCode, Json<ApiError>)> {
        let Some(expected) = self.token.as_deref() else {
            return Ok(());
        };

        let header_token = bearer_token(headers);
        let query_token = query_access_token(uri);

        if header_token == Some(expected) || query_token.as_deref() == Some(expected) {
            Ok(())
        } else {
            Err(unauthorized())
        }
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

fn query_access_token(uri: &Uri) -> Option<String> {
    let query = uri.query()?;
    form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == "access_token")
        .map(|(_, value)| value.into_owned())
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
