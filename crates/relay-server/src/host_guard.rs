//! Host-header allowlist for the local surface.
//!
//! This is the defense against DNS rebinding specifically, and it is the only
//! one that works. After a rebind the browser still sends the attacker's
//! hostname — only the resolved IP changed — so `Origin` and `Host` are both
//! `evil.example` and agree with each other. `relay_http::request_origin`
//! *derives* the expected origin from `Host`, which means the same-origin
//! check in `authorize_csrf_protection` compares the attacker's origin against
//! itself and passes. Pinning the set of hostnames we answer to is what breaks
//! that, and it has to happen before routing.
//!
//! Scope, deliberately: this stops a *browser* being used as a confused
//! deputy. It does nothing about code already running as you — that process
//! can set any header it likes.

use std::collections::BTreeSet;
use std::net::IpAddr;

pub(crate) const ALLOWED_HOSTS_ENV: &str = "RELAY_ALLOWED_HOSTS";

/// Which `Host` values this process will answer to.
#[derive(Clone, Debug)]
pub struct HostPolicy {
    /// Non-loopback binds with no explicit allowlist opt out entirely: we
    /// cannot guess the reverse-proxy hostname, and guessing wrong takes the
    /// deployment down. Those binds already require a token (`AuthConfig`).
    enforced: bool,
    /// Extra names beyond the always-allowed loopback set.
    allowed: BTreeSet<String>,
}

impl HostPolicy {
    pub fn from_env_for_bind_host(bind_host: IpAddr) -> Result<Self, String> {
        Self::from_parts(bind_host, std::env::var(ALLOWED_HOSTS_ENV).ok())
    }

    pub fn from_parts(bind_host: IpAddr, allowed_hosts: Option<String>) -> Result<Self, String> {
        let mut allowed = BTreeSet::new();
        for entry in allowed_hosts.iter().flat_map(|raw| raw.split(',')) {
            let Some(host) = normalize_host(entry) else {
                continue;
            };
            allowed.insert(host);
        }
        // Only an operator-supplied list counts as opting in. The bind address
        // added below is derived, not chosen, so it must not flip enforcement
        // on for a deployment that never asked for it.
        let opted_in = !allowed.is_empty();

        // A concrete bind address is a legitimate way to reach this process.
        // `0.0.0.0` / `::` name no host in particular, so they add nothing.
        if !bind_host.is_unspecified() && !bind_host.is_loopback() {
            allowed.insert(bind_host.to_string().to_ascii_lowercase());
        }

        Ok(Self {
            enforced: bind_host.is_loopback() || opted_in,
            allowed,
        })
    }

    /// The default posture: loopback bind, no extra names.
    pub fn loopback_only() -> Self {
        Self::from_parts(IpAddr::from([127, 0, 0, 1]), None)
            .expect("a loopback bind with no allowlist is always valid")
    }

    /// `raw` is the `Host` header, or the request URI's authority when the
    /// protocol carries it there instead (HTTP/2 `:authority`).
    pub fn allows_host(&self, raw: Option<&str>) -> bool {
        if !self.enforced {
            return true;
        }

        // HTTP/1.1 requires Host and every browser sends it. Refusing the
        // ambiguous case keeps the allowlist from being bypassed by omission.
        let Some(raw) = raw else {
            return false;
        };
        let Some(host) = normalize_host(raw) else {
            return false;
        };

        host_is_loopback(&host) || self.allowed.contains(&host)
    }
}

/// Whether an authority (`localhost:5173`, `[::1]`, `127.0.0.1:8787`) names a
/// loopback host. Used to accept the vite dev proxy's cross-port `Origin`: a
/// hostile page can never present a loopback origin, so this widens the
/// same-origin comparison without widening the threat model.
pub(crate) fn authority_is_loopback(raw: &str) -> bool {
    normalize_host(raw).is_some_and(|host| host_is_loopback(&host))
}

/// Lowercase and strip the port, handling bracketed IPv6 authorities.
fn normalize_host(raw: &str) -> Option<String> {
    let lowered = raw.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return None;
    }

    // `[::1]:8787` / `[::1]`
    if let Some(rest) = lowered.strip_prefix('[') {
        let (inside, _) = rest.split_once(']')?;
        return (!inside.is_empty()).then(|| inside.to_string());
    }

    let host = match lowered.split_once(':') {
        // `127.0.0.1:8787` — a single colon followed by digits is a port.
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        // A bare IPv6 literal (`::1`) has colons that are not a port.
        _ => lowered.as_str(),
    };

    (!host.is_empty()).then(|| host.to_string())
}

fn host_is_loopback(host: &str) -> bool {
    host == "localhost"
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_host_strips_ports_and_ipv6_brackets() {
        assert_eq!(
            normalize_host("127.0.0.1:8787").as_deref(),
            Some("127.0.0.1")
        );
        assert_eq!(normalize_host("LocalHost").as_deref(), Some("localhost"));
        assert_eq!(normalize_host("[::1]:8787").as_deref(), Some("::1"));
        assert_eq!(normalize_host("[::1]").as_deref(), Some("::1"));
        // A bare IPv6 literal must not lose everything after its first colon.
        assert_eq!(normalize_host("::1").as_deref(), Some("::1"));
        assert_eq!(normalize_host("  ").as_deref(), None);
    }
}
