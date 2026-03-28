pub const BROKER_AUTH_MODE_ENV: &str = "RELAY_BROKER_AUTH_MODE";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrokerAuthMode {
    SelfHostedSharedSecret,
    PublicControlPlane,
}

impl BrokerAuthMode {
    pub fn from_env() -> Result<Self, String> {
        Self::parse(std::env::var(BROKER_AUTH_MODE_ENV).ok())
    }

    pub fn parse(value: Option<String>) -> Result<Self, String> {
        match value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            None => Ok(Self::SelfHostedSharedSecret),
            Some("self_hosted") => Ok(Self::SelfHostedSharedSecret),
            Some("public") => Ok(Self::PublicControlPlane),
            Some(other) => Err(format!(
                "{BROKER_AUTH_MODE_ENV} must be `self_hosted` or `public`, got `{other}`"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SelfHostedSharedSecret => "self_hosted",
            Self::PublicControlPlane => "public",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::BrokerAuthMode;

    #[test]
    fn broker_auth_mode_defaults_to_self_hosted() {
        assert_eq!(
            BrokerAuthMode::parse(None).expect("default mode should parse"),
            BrokerAuthMode::SelfHostedSharedSecret
        );
    }

    #[test]
    fn broker_auth_mode_parses_supported_values() {
        assert_eq!(
            BrokerAuthMode::parse(Some("self_hosted".to_string()))
                .expect("self hosted mode should parse"),
            BrokerAuthMode::SelfHostedSharedSecret
        );
        assert_eq!(
            BrokerAuthMode::parse(Some("public".to_string())).expect("public mode should parse"),
            BrokerAuthMode::PublicControlPlane
        );
    }

    #[test]
    fn broker_auth_mode_rejects_unknown_values() {
        let error =
            BrokerAuthMode::parse(Some("maybe".to_string())).expect_err("invalid mode should fail");
        assert!(error.contains("RELAY_BROKER_AUTH_MODE"));
    }
}
