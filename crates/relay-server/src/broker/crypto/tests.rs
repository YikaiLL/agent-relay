use super::*;
use serde_json::json;

#[test]
fn round_trips_encrypted_json() {
    let envelope =
        encrypt_json("secret-1", &json!({"hello":"world"})).expect("encryption should succeed");
    let value: serde_json::Value =
        decrypt_json("secret-1", &envelope).expect("decryption should succeed");
    assert_eq!(value, json!({"hello":"world"}));
}

#[test]
fn decrypt_rejects_wrong_secret() {
    let envelope = encrypt_json("secret-1", &json!({"hello":"world"})).expect("should encrypt");
    let error = decrypt_json::<serde_json::Value>("secret-2", &envelope)
        .expect_err("wrong secret should fail");
    assert!(error.contains("decryption failed"));
}
