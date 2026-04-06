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

const browser = installBrowserStubs();
const { renderEmptyState } = await import("./render.js");
const { state } = await import("./state.js");

test("renderEmptyState shows relay directory home when no relay is selected", async () => {

  state.clientAuth = {
    clientId: "client-1",
    clientRefreshToken: "refresh-1",
    brokerControlUrl: "https://broker.example.test",
  };
  state.remoteAuth = null;
  state.pairingTicket = null;
  state.relayDirectory = [
    {
      relayId: "relay-1",
      relayLabel: "Work Mac",
      brokerRoomId: "room-a",
      deviceId: "device-1",
      deviceLabel: "iPhone",
      hasLocalProfile: true,
      grantedAt: null,
    },
  ];

  renderEmptyState();

  assert.match(browser.elements.get("#remote-transcript").innerHTML, /Choose a relay/);
  assert.match(browser.elements.get("#remote-transcript").innerHTML, /Work Mac/);
  assert.equal(browser.elements.get("#remote-session-toggle").disabled, true);
  assert.equal(browser.elements.get("#remote-session-toggle").textContent, "Select a relay first");
  assert.equal(browser.elements.get("#remote-home-button").hidden, true);
});

test("renderEmptyState shows first-pair copy when no relay grants exist", async () => {
  state.clientAuth = null;
  state.remoteAuth = null;
  state.pairingTicket = null;
  state.relayDirectory = [];

  renderEmptyState();

  assert.match(browser.elements.get("#remote-transcript").innerHTML, /Pair your first relay/);
  assert.match(
    browser.elements.get("#remote-message-input").placeholder,
    /Pair this browser before sending messages/
  );
});
