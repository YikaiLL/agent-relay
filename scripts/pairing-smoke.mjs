import nacl from "tweetnacl";
import { sha256 } from "@noble/hashes/sha2.js";

const relayBase = process.env.RELAY_BASE_URL || "http://127.0.0.1:8787";
const prompt = process.env.PAIRING_SMOKE_PROMPT || "Reply with exactly: pairing-smoke";
const cwd = process.env.PAIRING_SMOKE_CWD || process.cwd();
const timeoutMs = Number(process.env.PAIRING_SMOKE_TIMEOUT_MS || 25000);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function deriveKey(secret) {
  return sha256(encoder.encode(secret));
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function encryptJson(secret, value) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = nacl.secretbox(plaintext, nonce, deriveKey(secret));
  return { nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(ciphertext) };
}

function decryptJson(secret, envelope) {
  const plaintext = nacl.secretbox.open(
    base64ToBytes(envelope.ciphertext),
    base64ToBytes(envelope.nonce),
    deriveKey(secret)
  );
  if (!plaintext) {
    throw new Error("decryption failed");
  }
  return JSON.parse(decoder.decode(plaintext));
}

function createFrameQueue(ws) {
  const frames = [];
  const waiters = [];

  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data);
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (waiterIndex >= 0) {
      const waiter = waiters.splice(waiterIndex, 1)[0];
      clearTimeout(waiter.timeout);
      waiter.resolve(frame);
      return;
    }
    frames.push(frame);
  });

  return (predicate, waitTimeoutMs = 10000) => {
    const existingIndex = frames.findIndex(predicate);
    if (existingIndex >= 0) {
      return Promise.resolve(frames.splice(existingIndex, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        reject(new Error("timed out waiting for broker frame"));
      }, waitTimeoutMs);
      waiters.push({ predicate, resolve, timeout });
    });
  };
}

async function main() {
  const pairingEnvelope = await fetch(`${relayBase}/api/pairing/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((response) => response.json());
  if (!pairingEnvelope.ok) {
    throw new Error(`pairing/start failed: ${JSON.stringify(pairingEnvelope)}`);
  }

  const ticket = pairingEnvelope.data;
  const wsUrl = `${ticket.broker_url}/ws/${encodeURIComponent(ticket.broker_channel_id)}?role=surface`;
  const ws = new WebSocket(wsUrl);
  const nextFrame = createFrameQueue(ws);

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket failed to open")), {
      once: true,
    });
  });

  const welcome = await nextFrame((frame) => frame.type === "welcome");
  const peerId = welcome.peer_id;
  if (!peerId) {
    throw new Error("broker welcome did not include an assigned peer_id");
  }

  ws.send(
    JSON.stringify({
      type: "publish",
      payload: {
        kind: "pairing_request",
        pairing_id: ticket.pairing_id,
        envelope: encryptJson(ticket.pairing_secret, {
          device_id: "smoke-phone",
          device_label: "Smoke Phone",
        }),
      },
    })
  );

  const pairingFrame = await nextFrame(
    (frame) =>
      frame.type === "message" &&
      frame.payload?.kind === "encrypted_pairing_result" &&
      frame.payload?.target_peer_id === peerId,
    timeoutMs
  );
  const pairingResult = decryptJson(ticket.pairing_secret, pairingFrame.payload.envelope);
  if (!pairingResult.ok) {
    throw new Error(`pairing failed: ${pairingResult.error}`);
  }

  const deviceId = pairingResult.device.device_id;
  const deviceToken = pairingResult.device_token;

  ws.send(
    JSON.stringify({
      type: "publish",
      payload: {
        kind: "encrypted_remote_action",
        action_id: "claim-smoke",
        device_id: deviceId,
        envelope: encryptJson(deviceToken, { type: "claim_device" }),
      },
    })
  );

  const claimFrame = await nextFrame(
    (frame) =>
      frame.type === "message" &&
      frame.payload?.kind === "encrypted_remote_action_result" &&
      frame.payload?.action_id === "claim-smoke",
    timeoutMs
  );
  const claimResult = decryptJson(deviceToken, claimFrame.payload.envelope);
  if (!claimResult.ok) {
    throw new Error(`claim failed: ${claimResult.error}`);
  }

  ws.send(
    JSON.stringify({
      type: "publish",
      payload: {
        kind: "encrypted_remote_action",
        action_id: "start-smoke",
        device_id: deviceId,
        session_claim: claimResult.session_claim,
        envelope: encryptJson(deviceToken, {
          type: "start_session",
          input: {
            cwd,
            initial_prompt: prompt,
            model: "gpt-5-codex",
            approval_policy: "never",
            sandbox: "workspace-write",
            effort: "low",
          },
        }),
      },
    })
  );

  const startFrame = await nextFrame(
    (frame) =>
      frame.type === "message" &&
      frame.payload?.kind === "encrypted_remote_action_result" &&
      frame.payload?.action_id === "start-smoke",
    timeoutMs
  );
  const startResult = decryptJson(deviceToken, startFrame.payload.envelope);
  if (!startResult.ok) {
    throw new Error(`start_session failed: ${startResult.error}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));
  const sessionSnapshot = await fetch(`${relayBase}/api/session`)
    .then((response) => response.json())
    .then((response) => response.data);
  const lastAssistant = [...sessionSnapshot.transcript]
    .reverse()
    .find((entry) => entry.role === "assistant");

  console.log(
    JSON.stringify(
      {
        pairedDevice: pairingResult.device,
        claimExpiresAt: claimResult.session_claim_expires_at,
        startedThread: startResult.snapshot.active_thread_id,
        lastAssistant: lastAssistant?.text || null,
      },
      null,
      2
    )
  );
  ws.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
