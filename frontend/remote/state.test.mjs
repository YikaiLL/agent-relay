import test from "node:test";
import assert from "node:assert/strict";

function installBrowserStubs() {
  const storage = new Map();
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

  globalThis.window = {
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
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Test Browser" },
  });

  return { localStorage };
}

test("remote auth storage keeps durable metadata but drops refresh and session secrets", async () => {
  const browser = installBrowserStubs();
  browser.localStorage.setItem(
    "agent-relay.remote-auth",
    JSON.stringify({
      brokerUrl: "ws://broker.example.test",
      brokerChannelId: "room-a",
      relayPeerId: "relay-1",
      securityMode: "private",
      deviceId: "device-1",
      deviceLabel: "Primary Phone",
      payloadSecret: "payload-secret-1",
      deviceRefreshToken: "legacy-refresh-token",
      deviceJoinTicket: "legacy-join-ticket",
      deviceJoinTicketExpiresAt: 123,
      sessionClaim: "legacy-session-claim",
      sessionClaimExpiresAt: 456,
    })
  );

  const { ensureDeviceIdentity, saveRemoteAuth, state } = await import("./state.js");

  assert.equal(state.remoteAuth.deviceId, "device-1");
  assert.equal(state.remoteAuth.payloadSecret, "payload-secret-1");
  assert.equal(state.remoteAuth.deviceRefreshToken, "legacy-refresh-token");
  assert.equal(state.remoteAuth.deviceJoinTicket, null);
  assert.equal(state.remoteAuth.sessionClaim, null);

  state.remoteAuth.deviceRefreshMode = "cookie";
  saveRemoteAuth(state.remoteAuth);

  const stored = JSON.parse(browser.localStorage.getItem("agent-relay.remote-auth"));
  assert.equal(stored.deviceId, "device-1");
  assert.equal(stored.payloadSecret, "payload-secret-1");
  assert.equal(stored.deviceRefreshMode, "cookie");
  assert.equal("deviceRefreshToken" in stored, false);
  assert.equal("deviceJoinTicket" in stored, false);
  assert.equal("sessionClaim" in stored, false);

  await ensureDeviceIdentity();
  assert.ok(state.deviceKeypair);
  assert.match(state.requestedDeviceId, /^mobile-/);
  const legacyKeypair = JSON.parse(
    browser.localStorage.getItem("agent-relay.remote-device-keypair")
  );
  assert.ok(legacyKeypair.verifyKey);
  assert.ok(legacyKeypair.signSecretKey);
});
