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

#[test]
fn access_token_query_is_rejected() {
    let auth = AuthConfig {
        token: Some("secret".to_string()),
    };
    let headers = HeaderMap::new();
    let error = auth
        .authorize(&headers, &uri("/api/stream?access_token=secret"))
        .expect_err("query tokens should no longer authorize the stream");

    assert_eq!(error.0, StatusCode::UNAUTHORIZED);
    assert_eq!(error.1 .0.error.code, "unauthorized");
}
