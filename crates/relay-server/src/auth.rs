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
mod tests {
    use super::*;
    use axum::http::{HeaderValue, Uri};

    fn uri(path: &str) -> Uri {
        path.parse().expect("uri should parse")
    }

    #[test]
    fn disabled_auth_allows_requests() {
        let auth = AuthConfig { token: None };
        let headers = HeaderMap::new();

        assert!(auth.authorize(&headers, &uri("/api/session")).is_ok());
    }

    #[test]
    fn bearer_header_authorizes_request() {
        let auth = AuthConfig {
            token: Some("secret".to_string()),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer secret"),
        );

        assert!(auth.authorize(&headers, &uri("/api/session")).is_ok());
    }

    #[test]
    fn access_token_query_authorizes_request() {
        let auth = AuthConfig {
            token: Some("secret".to_string()),
        };
        let headers = HeaderMap::new();

        assert!(auth
            .authorize(&headers, &uri("/api/stream?access_token=secret"))
            .is_ok());
    }

    #[test]
    fn invalid_token_is_rejected() {
        let auth = AuthConfig {
            token: Some("secret".to_string()),
        };
        let headers = HeaderMap::new();
        let error = auth
            .authorize(&headers, &uri("/api/session"))
            .expect_err("missing token should be rejected");

        assert_eq!(error.0, StatusCode::UNAUTHORIZED);
        assert_eq!(error.1 .0.error.code, "unauthorized");
    }
}
