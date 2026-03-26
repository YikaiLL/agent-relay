use base64::{engine::general_purpose::STANDARD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce,
};
use rand::RngCore;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct EncryptedEnvelope {
    pub nonce: String,
    pub ciphertext: String,
}

pub(crate) fn encrypt_json<T: Serialize>(
    secret: &str,
    value: &T,
) -> Result<EncryptedEnvelope, String> {
    let plaintext = serde_json::to_vec(value)
        .map_err(|error| format!("failed to encode plaintext: {error}"))?;
    encrypt_bytes(secret, &plaintext)
}

pub(crate) fn decrypt_json<T: DeserializeOwned>(
    secret: &str,
    envelope: &EncryptedEnvelope,
) -> Result<T, String> {
    let plaintext = decrypt_bytes(secret, envelope)?;
    serde_json::from_slice(&plaintext)
        .map_err(|error| format!("failed to decode decrypted payload: {error}"))
}

fn encrypt_bytes(secret: &str, plaintext: &[u8]) -> Result<EncryptedEnvelope, String> {
    let cipher = cipher(secret);
    let mut nonce_bytes = [0_u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|error| format!("encryption failed: {error}"))?;

    Ok(EncryptedEnvelope {
        nonce: STANDARD.encode(nonce_bytes),
        ciphertext: STANDARD.encode(ciphertext),
    })
}

fn decrypt_bytes(secret: &str, envelope: &EncryptedEnvelope) -> Result<Vec<u8>, String> {
    let cipher = cipher(secret);
    let nonce_bytes = STANDARD
        .decode(&envelope.nonce)
        .map_err(|error| format!("invalid envelope nonce: {error}"))?;
    if nonce_bytes.len() != 12 {
        return Err("invalid envelope nonce length".to_string());
    }
    let ciphertext = STANDARD
        .decode(&envelope.ciphertext)
        .map_err(|error| format!("invalid envelope ciphertext: {error}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|error| format!("decryption failed: {error}"))
}

fn cipher(secret: &str) -> ChaCha20Poly1305 {
    let digest = Sha256::digest(secret.as_bytes());
    let key = Key::from_slice(&digest);
    ChaCha20Poly1305::new(key)
}

#[cfg(test)]
mod tests {
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
}
