import { base64UrlToBytes } from "./encoding.js";

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
  const key = await importSecretKey(secret);
  const nonce = window.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
    },
    key,
    plaintext
  );

  return {
    nonce: bytesToBase64(new Uint8Array(nonce)),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptJson(secret, envelope) {
  const key = await importSecretKey(secret);
  const plaintext = await window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(envelope.nonce),
    },
    key,
    base64ToBytes(envelope.ciphertext)
  );

  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function importSecretKey(secret) {
  const digest = await window.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret)
  );
  return window.crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary);
}

function base64ToBytes(value) {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
