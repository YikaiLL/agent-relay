import test from "node:test";
import assert from "node:assert/strict";

function createElementStub() {
  return {
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    hidden: false,
    className: "",
    scrollTop: 0,
    scrollHeight: 0,
    dataset: {},
    addEventListener() {},
    setAttribute() {},
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
  };
}

function installBrowserStubs() {
  const storage = new Map();
  const elements = new Map();
  const pendingTimers = [];
  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  };
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, createElementStub());
      }
      return elements.get(selector);
    },
  };
  const windowObject = {
    localStorage,
    location: { href: "https://remote.example.test/" },
    history: {
      replaceState() {},
    },
    atob(value) {
      return Buffer.from(value, "base64").toString("binary");
    },
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    },
    setTimeout(callback) {
      pendingTimers.push(callback);
      return pendingTimers.length;
    },
    clearTimeout(id) {
      pendingTimers[id - 1] = null;
    },
  };

  globalThis.document = document;
  globalThis.window = windowObject;
  globalThis.WebSocket = { OPEN: 1 };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Test Browser" },
  });

  return {
    localStorage,
    runTimers() {
      while (pendingTimers.length) {
        const callback = pendingTimers.shift();
        if (callback) {
          callback();
        }
      }
    },
  };
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("ensureRemoteClaim performs challenge-response without rotating payload secrets", async () => {
  const browser = installBrowserStubs();
  const sentPayloads = [];

  const { state, saveRemoteAuth } = await import("./state.js");
  const { ensureRemoteClaim, handleRemoteBrokerPayload } = await import("./actions.js");

  state.remoteAuth = {
    brokerUrl: "wss://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    securityMode: "managed",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    deviceRefreshMode: "cookie",
    deviceRefreshToken: null,
    deviceJoinTicket: "device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 300,
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  };
  saveRemoteAuth(state.remoteAuth);
  state.socketConnected = true;
  state.socketPeerId = "surface-peer-1";
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
      setImmediate(async () => {
        if (frame.payload.request?.type === "claim_challenge") {
          await handleRemoteBrokerPayload({
            kind: "remote_action_result",
            action_id: frame.payload.action_id,
            action: "claim_challenge",
            ok: true,
            snapshot: {},
            claim_challenge_id: "challenge-1",
            claim_challenge: "server-challenge",
            claim_challenge_expires_at: Math.floor(Date.now() / 1000) + 60,
          });
          return;
        }

        if (frame.payload.request?.type === "claim_device") {
          await handleRemoteBrokerPayload({
            kind: "remote_action_result",
            action_id: frame.payload.action_id,
            action: "claim_device",
            ok: true,
            snapshot: {},
            session_claim: "session-claim-2",
            session_claim_expires_at: Math.floor(Date.now() / 1000) + 300,
          });
        }
      });
    },
  };

  const sessionClaim = await ensureRemoteClaim({
    force: true,
    reason: "unit test",
    syncAfterClaim: false,
  });
  await nextTick();
  browser.runTimers();

  assert.equal(sessionClaim, "session-claim-2");
  assert.equal(sentPayloads.length, 2);
  assert.equal(sentPayloads[0].request.type, "claim_challenge");
  assert.equal(sentPayloads[0].device_id, "device-1");
  assert.ok(typeof sentPayloads[0].request.proof === "string");
  assert.ok(sentPayloads[0].request.proof.length > 20);
  assert.equal(sentPayloads[1].request.type, "claim_device");
  assert.equal(sentPayloads[1].request.challenge_id, "challenge-1");
  assert.ok(typeof sentPayloads[1].request.proof === "string");
  assert.ok(sentPayloads[1].request.proof.length > 20);
  assert.equal(sentPayloads[1].device_id, "device-1");
  assert.equal(state.remoteAuth.payloadSecret, "payload-secret-1");
  assert.equal(state.remoteAuth.sessionClaim, "session-claim-2");

  const storedAuth = JSON.parse(browser.localStorage.getItem("agent-relay.remote-auth"));
  assert.equal(storedAuth.payloadSecret, "payload-secret-1");
  assert.equal(storedAuth.deviceRefreshToken, undefined);
  assert.equal(storedAuth.deviceJoinTicket, undefined);
});

test("encrypted remote action results decrypt with the persisted payload secret", async () => {
  const browser = installBrowserStubs();

  const { encryptJson } = await import("./crypto.js");
  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");

  state.remoteAuth = {
    brokerUrl: "wss://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    securityMode: "private",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    deviceRefreshMode: "cookie",
    deviceRefreshToken: null,
    deviceJoinTicket: "device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 300,
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  };
  saveRemoteAuth(state.remoteAuth);
  state.socketPeerId = "surface-peer-1";

  const envelope = await encryptJson("payload-secret-1", {
    action: "claim_device",
    ok: true,
    snapshot: {},
    session_claim: "session-claim-3",
    session_claim_expires_at: Math.floor(Date.now() / 1000) + 300,
  });

  await handleRemoteBrokerPayload({
    kind: "encrypted_remote_action_result",
    action_id: "action-1",
    target_peer_id: "surface-peer-1",
    device_id: "device-1",
    envelope,
  });

  assert.equal(state.remoteAuth.payloadSecret, "payload-secret-1");
  assert.equal(state.remoteAuth.sessionClaim, "session-claim-3");

  const storedAuth = JSON.parse(browser.localStorage.getItem("agent-relay.remote-auth"));
  assert.equal(storedAuth.payloadSecret, "payload-secret-1");
});
