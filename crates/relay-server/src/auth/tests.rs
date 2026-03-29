use super::*;
use axum::http::{HeaderValue, Uri};
use std::net::{IpAddr, Ipv4Addr};

fn uri(path: &str) -> Uri {
    path.parse().expect("uri should parse")
}

#[test]
fn disabled_auth_allows_requests() {
    let auth = AuthConfig {
        token: None,
        insecure_no_auth_override: false,
    };
    let headers = HeaderMap::new();

    assert!(auth.authorize(&headers, &uri("/api/session")).is_ok());
}

#[test]
fn bearer_header_authorizes_request() {
    let auth = AuthConfig {
        token: Some("secret".to_string()),
        insecure_no_auth_override: false,
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
        insecure_no_auth_override: false,
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
        insecure_no_auth_override: false,
    };
    let headers = HeaderMap::new();
    let error = auth
        .authorize(&headers, &uri("/api/stream?access_token=secret"))
        .expect_err("query tokens should no longer authorize the stream");

    assert_eq!(error.0, StatusCode::UNAUTHORIZED);
    assert_eq!(error.1 .0.error.code, "unauthorized");
}

#[test]
fn loopback_bind_allows_missing_token() {
    let auth = AuthConfig::from_parts(None, None, IpAddr::V4(Ipv4Addr::LOCALHOST))
        .expect("loopback bind should allow missing auth");

    assert!(!auth.enabled());
    assert!(!auth.insecure_no_auth_override_active());
}

#[test]
fn non_loopback_bind_requires_token_by_default() {
    let error = AuthConfig::from_parts(None, None, IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)))
        .expect_err("non-loopback bind should require auth");

    assert!(error.contains("RELAY_API_TOKEN"));
}

#[test]
fn non_loopback_bind_allows_explicit_insecure_override() {
    let auth = AuthConfig::from_parts(
        None,
        Some("1".to_string()),
        IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)),
    )
    .expect("explicit insecure override should allow startup");

    assert!(!auth.enabled());
    assert!(auth.insecure_no_auth_override_active());
}

#[test]
fn non_loopback_bind_accepts_token() {
    let auth = AuthConfig::from_parts(
        Some("secret".to_string()),
        None,
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, 12)),
    )
    .expect("non-loopback bind should accept explicit auth");

    assert!(auth.enabled());
    assert!(!auth.insecure_no_auth_override_active());
}

#[test]
fn invalid_insecure_override_value_is_rejected() {
    let error = AuthConfig::from_parts(
        None,
        Some("maybe".to_string()),
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, 12)),
    )
    .expect_err("invalid override values should be rejected");

    assert!(error.contains("RELAY_ALLOW_INSECURE_NO_AUTH"));
}
