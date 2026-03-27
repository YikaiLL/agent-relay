use base64::{engine::general_purpose::STANDARD, Engine as _};
use rand::RngCore;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use xsalsa20poly1305::{
    aead::{Aead, KeyInit},
    Key, Nonce, XSalsa20Poly1305,
};

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
    let mut nonce_bytes = [0_u8; 24];
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
    if nonce_bytes.len() != 24 {
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

fn cipher(secret: &str) -> XSalsa20Poly1305 {
    let digest = Sha256::digest(secret.as_bytes());
    let key = Key::from_slice(&digest);
    XSalsa20Poly1305::new(key)
}

#[cfg(test)]
mod tests;
