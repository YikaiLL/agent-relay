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

#[test]
fn decrypts_tweetnacl_known_answer() {
    // Generated independently with frontend's tweetnacl 1.0.3 implementation,
    // sha256("interop-secret-v1"), and nonce bytes 0..=23. This pins the
    // cross-language NaCl secretbox wire format across Rust crate migrations.
    let envelope = EncryptedEnvelope {
        nonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX".to_string(),
        ciphertext:
            "/iiBXuKJZd+pK7V+TfU19NhSVWLTsqLcyy+SjIM/kqbo9Ktc0BGXtMwr/uEzZ5fHBWyg+yH7Dkte0Ahc"
                .to_string(),
    };

    let value: serde_json::Value =
        decrypt_json("interop-secret-v1", &envelope).expect("TweetNaCl vector should decrypt");
    assert_eq!(value, json!({"message":"hello from tweetnacl","count":7}));
}

#[test]
fn decrypt_rejects_wrong_nonce_length() {
    let envelope = EncryptedEnvelope {
        nonce: STANDARD.encode([0_u8; 23]),
        ciphertext: STANDARD.encode([0_u8; 16]),
    };

    let error = decrypt_json::<serde_json::Value>("secret-1", &envelope)
        .expect_err("wrong nonce length should fail");
    assert_eq!(error, "invalid envelope nonce length");
}

#[test]
fn decrypt_rejects_tampered_ciphertext() {
    let mut envelope = encrypt_json("secret-1", &json!({"hello":"world"})).expect("should encrypt");
    let mut ciphertext = STANDARD
        .decode(&envelope.ciphertext)
        .expect("ciphertext should be valid base64");
    ciphertext[0] ^= 1;
    envelope.ciphertext = STANDARD.encode(ciphertext);

    let error = decrypt_json::<serde_json::Value>("secret-1", &envelope)
        .expect_err("tampered ciphertext should fail authentication");
    assert!(error.contains("decryption failed"));
}
