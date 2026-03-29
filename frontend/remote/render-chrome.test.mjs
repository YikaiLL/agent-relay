import test from "node:test";
import assert from "node:assert/strict";

function createElementStub() {
  return {
    value: "",
    textContent: "",
    innerHTML: "",
    className: "",
    disabled: false,
    hidden: false,
    readOnly: false,
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

  globalThis.document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, createElementStub());
      }
      return elements.get(selector);
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

  return { elements };
}

test("legacy device key storage renders a visible warning", async () => {
  const browser = installBrowserStubs();
  const { renderDeviceMeta } = await import("./render-chrome.js");
  const { state } = await import("./state.js");

  state.deviceKeyStorageMode = "legacy";
  state.remoteAuth = null;
  state.pairingTicket = null;
  renderDeviceMeta();

  const unpairedMarkup = browser.elements.get("#device-meta").innerHTML;
  assert.match(unpairedMarkup, /Legacy key storage/);
  assert.match(unpairedMarkup, /device signing key in legacy localStorage/);

  state.remoteAuth = {
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    securityMode: "private",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    deviceToken: "device-token-1",
    deviceRefreshMode: "cookie",
    deviceRefreshToken: null,
    deviceJoinTicket: "device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 300,
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  };
  renderDeviceMeta();

  const pairedMarkup = browser.elements.get("#device-meta").innerHTML;
  assert.match(pairedMarkup, /Legacy key storage/);
  assert.match(pairedMarkup, /protected browser crypto storage/);
});
