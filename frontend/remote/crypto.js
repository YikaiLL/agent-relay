import { sha256 } from "@noble/hashes/sha2.js";
import nacl from "tweetnacl";

import { base64ToBytes, base64UrlToBytes, bytesToBase64 } from "./encoding.js";

const REMOTE_DEVICE_KEY_DB_NAME = "agent-relay-crypto";
const REMOTE_DEVICE_KEY_STORE_NAME = "device-keys";
const REMOTE_DEVICE_KEY_RECORD_ID = "remote-device-keypair-v1";

let deviceKeypairPromise = null;

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

  const missingFields = [];
  if (!payload.pairing_id) {
    missingFields.push("pairing_id");
  }
  if (!payload.pairing_secret) {
    missingFields.push("pairing_secret");
  }
  if (!payload.broker_url) {
    missingFields.push("broker_url");
  }
  if (!payload.pairing_join_ticket) {
    missingFields.push("pairing_join_ticket");
  }
  if (missingFields.length > 0) {
    if (missingFields.length === 1 && missingFields[0] === "pairing_join_ticket") {
      throw new Error(
        "pairing link is outdated and missing pairing_join_ticket; generate a new QR or pairing link from the local relay"
      );
    }
    throw new Error(`pairing payload is missing required fields: ${missingFields.join(", ")}`);
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

export async function ensureDeviceKeypair() {
  if (!deviceKeypairPromise) {
    deviceKeypairPromise = loadOrCreateDeviceKeypair().catch((error) => {
      deviceKeypairPromise = null;
      throw error;
    });
  }
  return deviceKeypairPromise;
}

export function pairingProofMessage(pairingId, deviceId) {
  return `agent-relay:pairing:${pairingId}:${deviceId || ""}`;
}

export async function signPairingProof(pairingId, deviceId, keypair = null) {
  return signDeviceProof(
    pairingProofMessage(pairingId, deviceId),
    keypair || (await ensureDeviceKeypair())
  );
}

export function claimProofMessage(challengeId, challenge, deviceId, peerId) {
  return `agent-relay:claim-challenge:${challengeId}:${challenge}:${deviceId || ""}:${peerId || ""}`;
}

export function claimInitProofMessage(actionId, deviceId, peerId) {
  return `agent-relay:claim-init:${actionId}:${deviceId || ""}:${peerId || ""}`;
}

export async function signClaimInitProof(actionId, deviceId, peerId, keypair = null) {
  return signDeviceProof(
    claimInitProofMessage(actionId, deviceId, peerId),
    keypair || (await ensureDeviceKeypair())
  );
}

export async function signClaimChallengeProof(
  challengeId,
  challenge,
  deviceId,
  peerId,
  keypair = null
) {
  return signDeviceProof(
    claimProofMessage(challengeId, challenge, deviceId, peerId),
    keypair || (await ensureDeviceKeypair())
  );
}

async function signDeviceProof(message, keypair) {
  const encodedMessage = new TextEncoder().encode(message);
  const signature = await keypair.sign(encodedMessage);
  return bytesToBase64(signature);
}

function deriveSecretKey(secret) {
  return sha256(new TextEncoder().encode(secret));
}

async function loadOrCreateDeviceKeypair() {
  if (!supportsProtectedDeviceKeypairStorage()) {
    throw new Error(
      "protected device key storage is unavailable in this browser context"
    );
  }

  const protectedKeypair = await loadProtectedDeviceKeypair();
  if (protectedKeypair) {
    return protectedKeypair;
  }

  return createProtectedDeviceKeypair();
}

function supportsProtectedDeviceKeypairStorage() {
  return Boolean(getWebCrypto()?.subtle && getIndexedDb());
}

function getWebCrypto() {
  return globalThis.crypto || window.crypto || null;
}

function getIndexedDb() {
  return globalThis.indexedDB || window.indexedDB || null;
}

async function loadProtectedDeviceKeypair() {
  const record = await readProtectedDeviceKeypairRecord();
  if (!record?.verifyKey || !record.privateKey || !record.publicKey) {
    return null;
  }
  return buildProtectedDeviceKeypair(record);
}

async function createProtectedDeviceKeypair() {
  const webcrypto = getWebCrypto();
  const generated = await webcrypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ]);
  const verifyKey = bytesToBase64(
    new Uint8Array(await webcrypto.subtle.exportKey("raw", generated.publicKey))
  );
  const record = {
    id: REMOTE_DEVICE_KEY_RECORD_ID,
    verifyKey,
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
  };
  await writeProtectedDeviceKeypairRecord(record);
  return buildProtectedDeviceKeypair(record);
}

function buildProtectedDeviceKeypair(record) {
  const webcrypto = getWebCrypto();
  return {
    verifyKey: record.verifyKey,
    async sign(messageBytes) {
      const signature = await webcrypto.subtle.sign("Ed25519", record.privateKey, messageBytes);
      return new Uint8Array(signature);
    },
  };
}

async function readProtectedDeviceKeypairRecord() {
  return withProtectedKeyStore("readonly", (store) => {
    const request = store.get(REMOTE_DEVICE_KEY_RECORD_ID);
    return wrapRequest(request);
  });
}

async function writeProtectedDeviceKeypairRecord(record) {
  return withProtectedKeyStore("readwrite", (store) => {
    const request = store.put(record);
    return wrapRequest(request);
  });
}

async function withProtectedKeyStore(mode, run) {
  const database = await openProtectedKeyDatabase();
  try {
    const transaction = database.transaction(REMOTE_DEVICE_KEY_STORE_NAME, mode);
    const store = transaction.objectStore(REMOTE_DEVICE_KEY_STORE_NAME);
    const completion = waitForTransaction(transaction);
    const result = await run(store);
    await completion;
    return result;
  } finally {
    database.close();
  }
}

function openProtectedKeyDatabase() {
  return new Promise((resolve, reject) => {
    const request = getIndexedDb().open(REMOTE_DEVICE_KEY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(REMOTE_DEVICE_KEY_STORE_NAME)) {
        database.createObjectStore(REMOTE_DEVICE_KEY_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("failed to open device key database"));
  });
}

function waitForTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error || new Error("device key transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error || new Error("device key transaction failed"));
  });
}

function wrapRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("device key storage request failed"));
  });
}
