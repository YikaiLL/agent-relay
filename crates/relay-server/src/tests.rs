use super::*;

#[test]
fn security_headers_are_applied() {
    let mut headers = HeaderMap::new();
    apply_security_headers(&mut headers, &SecurityHeadersConfig::default(), false);

    assert_eq!(
        headers
            .get("content-security-policy")
            .and_then(|value| value.to_str().ok()),
        Some(build_content_security_policy(DEFAULT_CONNECT_SRC).as_str())
    );
    assert_eq!(
        headers
            .get("permissions-policy")
            .and_then(|value| value.to_str().ok()),
        Some(PERMISSIONS_POLICY)
    );
    assert_eq!(
        headers
            .get("referrer-policy")
            .and_then(|value| value.to_str().ok()),
        Some(REFERRER_POLICY)
    );
    assert_eq!(
        headers
            .get("x-content-type-options")
            .and_then(|value| value.to_str().ok()),
        Some(X_CONTENT_TYPE_OPTIONS)
    );
    assert!(!headers.contains_key("strict-transport-security"));
}

#[test]
fn strict_transport_security_only_applies_when_enabled_for_https_requests() {
    let mut secure_headers = HeaderMap::new();
    apply_security_headers(
        &mut secure_headers,
        &SecurityHeadersConfig::from_parts(true, None, Some("max-age=86400".to_string()))
            .expect("custom HSTS config should parse"),
        true,
    );
    assert_eq!(
        secure_headers
            .get("strict-transport-security")
            .and_then(|value| value.to_str().ok()),
        Some("max-age=86400")
    );

    let mut insecure_headers = HeaderMap::new();
    apply_security_headers(
        &mut insecure_headers,
        &SecurityHeadersConfig::from_parts(true, None, Some("max-age=86400".to_string()))
            .expect("custom HSTS config should parse"),
        false,
    );
    assert!(!insecure_headers.contains_key("strict-transport-security"));
}

#[test]
fn content_security_policy_can_override_connect_src() {
    let mut headers = HeaderMap::new();
    let connect_src = "'self' https://relay.example.com wss://broker.example.com";
    apply_security_headers(
        &mut headers,
        &SecurityHeadersConfig::from_parts(false, Some(connect_src.to_string()), None)
            .expect("custom CSP config should parse"),
        false,
    );

    assert_eq!(
        headers
            .get("content-security-policy")
            .and_then(|value| value.to_str().ok()),
        Some(build_content_security_policy(connect_src).as_str())
    );
}

#[test]
fn forwarded_https_is_treated_as_secure() {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("x-forwarded-proto"),
        HeaderValue::from_static("https"),
    );

    assert!(request_uses_https(&headers, &Uri::from_static("/")));
    assert!(!request_uses_https(
        &HeaderMap::new(),
        &Uri::from_static("/")
    ));
}

#[test]
fn forwarded_and_forwarded_ssl_headers_are_treated_as_secure() {
    let mut forwarded_headers = HeaderMap::new();
    forwarded_headers.insert(
        HeaderName::from_static("forwarded"),
        HeaderValue::from_static("for=203.0.113.9;proto=https"),
    );
    assert!(request_uses_https(
        &forwarded_headers,
        &Uri::from_static("/")
    ));

    let mut forwarded_ssl_headers = HeaderMap::new();
    forwarded_ssl_headers.insert(
        HeaderName::from_static("x-forwarded-ssl"),
        HeaderValue::from_static("on"),
    );
    assert!(request_uses_https(
        &forwarded_ssl_headers,
        &Uri::from_static("/")
    ));
}

#[test]
fn invalid_security_header_overrides_are_rejected() {
    let csp_error = SecurityHeadersConfig::from_parts(
        false,
        Some("https://relay.example.com\r\nx".to_string()),
        None,
    )
    .expect_err("invalid CSP override should fail");
    assert!(csp_error.contains(CSP_CONNECT_SRC_ENV));

    let hsts_error =
        SecurityHeadersConfig::from_parts(true, None, Some("max-age=86400\r\nx".to_string()))
            .expect_err("invalid HSTS override should fail");
    assert!(hsts_error.contains(HSTS_VALUE_ENV));
}
