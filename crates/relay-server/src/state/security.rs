use crate::protocol::SecurityMode;

#[derive(Clone, Copy, Debug)]
pub(crate) struct SecurityProfile {
    mode: SecurityMode,
    e2ee_enabled: bool,
    broker_can_read_content: bool,
    audit_enabled: bool,
}

impl SecurityProfile {
    pub(crate) fn from_env() -> Result<Self, String> {
        let mode = std::env::var("RELAY_SECURITY_MODE")
            .ok()
            .map(|value| parse_security_mode(&value))
            .transpose()?
            .unwrap_or(SecurityMode::Private);

        Ok(Self::for_mode(mode))
    }

    #[cfg(test)]
    pub(crate) fn private() -> Self {
        Self::for_mode(SecurityMode::Private)
    }

    pub(crate) fn mode(self) -> SecurityMode {
        self.mode
    }

    pub(crate) fn e2ee_enabled(self) -> bool {
        self.e2ee_enabled
    }

    pub(crate) fn broker_can_read_content(self) -> bool {
        self.broker_can_read_content
    }

    pub(crate) fn audit_enabled(self) -> bool {
        self.audit_enabled
    }

    pub(crate) fn summary(self) -> &'static str {
        match self.mode {
            SecurityMode::Private => {
                "Private mode enabled. Treat the future broker as blind transport only."
            }
            SecurityMode::Managed => {
                "Managed mode enabled. Future broker/org services are allowed to read content for audit."
            }
        }
    }

    fn for_mode(mode: SecurityMode) -> Self {
        match mode {
            SecurityMode::Private => Self {
                mode,
                e2ee_enabled: true,
                broker_can_read_content: false,
                audit_enabled: false,
            },
            SecurityMode::Managed => Self {
                mode,
                e2ee_enabled: false,
                broker_can_read_content: true,
                audit_enabled: true,
            },
        }
    }
}

fn parse_security_mode(value: &str) -> Result<SecurityMode, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "private" => Ok(SecurityMode::Private),
        "managed" => Ok(SecurityMode::Managed),
        other => Err(format!(
            "invalid RELAY_SECURITY_MODE `{other}`. Expected `private` or `managed`"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_mode_defaults_to_e2ee() {
        let profile = SecurityProfile::private();

        assert_eq!(profile.mode(), SecurityMode::Private);
        assert!(profile.e2ee_enabled());
        assert!(!profile.broker_can_read_content());
        assert!(!profile.audit_enabled());
    }

    #[test]
    fn managed_mode_enables_audit_visibility() {
        let profile = SecurityProfile::for_mode(SecurityMode::Managed);

        assert_eq!(profile.mode(), SecurityMode::Managed);
        assert!(!profile.e2ee_enabled());
        assert!(profile.broker_can_read_content());
        assert!(profile.audit_enabled());
    }
}
