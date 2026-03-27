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
