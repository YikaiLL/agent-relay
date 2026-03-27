import { sha256 } from "@noble/hashes/sha2.js";
import nacl from "tweetnacl";

import { base64ToBytes, base64UrlToBytes, bytesToBase64 } from "./encoding.js";

export function parsePairingPayload(rawInput) {
  let raw = rawInput.trim();

  try {
    const url = new URL(raw);
    raw = url.searchParams.get("pairing") || raw;
  } catch {
    if (raw.startsWith("pairing=")) {
      raw = raw.slice("pairing=".length);
    }
  }

  const json = new TextDecoder().decode(base64UrlToBytes(raw));
  const payload = JSON.parse(json);

  if (!payload.pairing_id || !payload.pairing_secret || !payload.broker_url) {
    throw new Error("pairing payload is missing required fields");
  }

  return payload;
}

export function clearPairingQueryFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("pairing")) {
    return;
  }
  url.searchParams.delete("pairing");
  window.history.replaceState({}, "", url);
}

export async function encryptJson(secret, value) {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const key = deriveSecretKey(secret);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(plaintext, nonce, key);

  return {
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
  };
}

export async function decryptJson(secret, envelope) {
  const nonce = base64ToBytes(envelope.nonce);
  if (nonce.length !== nacl.secretbox.nonceLength) {
    throw new Error("invalid envelope nonce length");
  }

  const key = deriveSecretKey(secret);
  const plaintext = nacl.secretbox.open(base64ToBytes(envelope.ciphertext), nonce, key);
  if (!plaintext) {
    throw new Error("decryption failed");
  }

  return JSON.parse(new TextDecoder().decode(plaintext));
}

function deriveSecretKey(secret) {
  return sha256(new TextEncoder().encode(secret));
}
