import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

function createRequest() {
  return {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
  };
}

function createIndexedDbStub() {
  const databases = new Map();

  function createDatabase() {
    const stores = new Map();

    return {
      objectStoreNames: {
        contains(name) {
          return stores.has(name);
        },
      },
      createObjectStore(name, options = {}) {
        if (!stores.has(name)) {
          stores.set(name, {
            keyPath: options.keyPath || "id",
            records: new Map(),
          });
        }
        return {};
      },
      transaction(name) {
        const storeState = stores.get(name);
        const transaction = {
          error: null,
          oncomplete: null,
          onabort: null,
          onerror: null,
          objectStore() {
            return {
              get(key) {
                const request = createRequest();
                queueMicrotask(() => {
                  request.result = storeState.records.get(key);
                  request.onsuccess?.();
                  queueMicrotask(() => transaction.oncomplete?.());
                });
                return request;
              },
              put(value) {
                const request = createRequest();
                queueMicrotask(() => {
                  storeState.records.set(value[storeState.keyPath], value);
                  request.result = value[storeState.keyPath];
                  request.onsuccess?.();
                  queueMicrotask(() => transaction.oncomplete?.());
                });
                return request;
              },
            };
          },
        };
        return transaction;
      },
      close() {},
    };
  }

  return {
    open(name) {
      const request = createRequest();
      queueMicrotask(() => {
        let database = databases.get(name);
        const isNew = !database;
        if (!database) {
          database = createDatabase();
          databases.set(name, database);
        }
        request.result = database;
        if (isNew) {
          request.onupgradeneeded?.();
        }
        queueMicrotask(() => request.onsuccess?.());
      });
      return request;
    },
  };
}

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
    crypto: webcrypto,
    indexedDB: createIndexedDbStub(),
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Test Browser" },
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: window.indexedDB,
  });

  return { localStorage };
}

test("remote auth storage keeps durable metadata but drops refresh and session secrets", async () => {
  const browser = installBrowserStubs();
  browser.localStorage.setItem(
    "agent-relay.remote-state-v2",
    JSON.stringify({
      activeRelayId: "relay-1",
      remoteProfiles: {
        "relay-1": {
          relayId: "relay-1",
          brokerUrl: "ws://broker.example.test",
          brokerChannelId: "room-a",
          relayPeerId: "relay-1",
          securityMode: "private",
          deviceId: "device-1",
          deviceLabel: "Primary Phone",
          payloadSecret: "payload-secret-1",
          deviceRefreshMode: "cookie",
          deviceRefreshToken: "refresh-token-1",
          deviceJoinTicket: "join-ticket-1",
          deviceJoinTicketExpiresAt: 123,
          sessionClaim: "session-claim-1",
          sessionClaimExpiresAt: 456,
        },
      },
    })
  );

  const { ensureDeviceIdentity, saveRemoteAuth, state } = await import("./state.js");

  assert.equal(state.remoteAuth.deviceId, "device-1");
  assert.equal(state.remoteAuth.payloadSecret, "payload-secret-1");
  assert.equal(state.remoteAuth.deviceRefreshToken, "refresh-token-1");
  assert.equal(state.remoteAuth.deviceJoinTicket, null);
  assert.equal(state.remoteAuth.sessionClaim, null);

  state.remoteAuth.deviceRefreshMode = "cookie";
  saveRemoteAuth(state.remoteAuth);

  const stored = JSON.parse(browser.localStorage.getItem("agent-relay.remote-state-v2"));
  const profile = stored.remoteProfiles["relay-1"];
  assert.equal(profile.deviceId, "device-1");
  assert.equal(profile.payloadSecret, "payload-secret-1");
  assert.equal(profile.deviceRefreshMode, "cookie");
  assert.equal("deviceRefreshToken" in profile, false);
  assert.equal("deviceJoinTicket" in profile, false);
  assert.equal("sessionClaim" in profile, false);

  await ensureDeviceIdentity();
  assert.ok(state.deviceKeypair);
  assert.match(state.requestedDeviceId, /^mobile-/);
  assert.equal(browser.localStorage.getItem("agent-relay.remote-device-keypair"), null);
});

test("self-hosted remote auth keeps the saved device join ticket across reloads", async () => {
  const browser = installBrowserStubs();
  browser.localStorage.setItem(
    "agent-relay.remote-state-v2",
    JSON.stringify({
      activeRelayId: "relay-1",
      remoteProfiles: {
        "relay-1": {
          relayId: "relay-1",
          brokerUrl: "ws://broker.example.test",
          brokerChannelId: "room-a",
          relayPeerId: "relay-1",
          securityMode: "private",
          deviceId: "device-1",
          deviceLabel: "Primary Phone",
          payloadSecret: "payload-secret-1",
          deviceJoinTicket: "self-hosted-join-ticket",
          deviceJoinTicketExpiresAt: 123456,
        },
      },
    })
  );

  const { state } = await import("./state.js?self-hosted-join-ticket");

  assert.equal(state.remoteAuth?.deviceJoinTicket, "self-hosted-join-ticket");
  assert.equal(state.remoteAuth?.deviceJoinTicketExpiresAt, 123456);

  const stored = JSON.parse(browser.localStorage.getItem("agent-relay.remote-state-v2"));
  assert.equal(stored.remoteProfiles["relay-1"].deviceJoinTicket, "self-hosted-join-ticket");
  assert.equal(stored.remoteProfiles["relay-1"].deviceJoinTicketExpiresAt, 123456);
});

test("explicit relay home selection persists without auto-opening a stored relay", async () => {
  const browser = installBrowserStubs();
  browser.localStorage.setItem(
    "agent-relay.remote-state-v2",
    JSON.stringify({
      activeRelayId: null,
      remoteProfiles: {
        "relay-1": {
          relayId: "relay-1",
          brokerUrl: "ws://broker.example.test",
          brokerChannelId: "room-a",
          relayPeerId: "relay-1",
          securityMode: "private",
          deviceId: "device-1",
          deviceLabel: "Primary Phone",
          payloadSecret: "payload-secret-1",
        },
      },
    })
  );

  const { clearActiveRelaySelection, selectRelayProfile, state } = await import("./state.js?home-selection");

  assert.equal(state.activeRelayId, null);
  assert.equal(state.remoteAuth, null);

  assert.equal(selectRelayProfile("relay-1"), true);
  assert.equal(state.activeRelayId, "relay-1");
  assert.equal(state.remoteAuth?.relayId, "relay-1");

  clearActiveRelaySelection();
  assert.equal(state.activeRelayId, null);
  assert.equal(state.remoteAuth, null);

  const stored = JSON.parse(browser.localStorage.getItem("agent-relay.remote-state-v2"));
  assert.equal(stored.activeRelayId, null);
  assert.equal(stored.remoteProfiles["relay-1"].relayId, "relay-1");
});
