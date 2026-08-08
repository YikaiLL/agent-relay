import test from "node:test";
import assert from "node:assert/strict";

// SECURITY / correctness: a pairing ticket that is dead — expired, or superseded
// because a later client claimed its single seat — must stop being used. The remote
// client reconnects automatically on every socket close, and `connectionTarget()`
// is what feeds that reconnect, so this is the one place that can actually stop it.
// Two clients sharing one QR would otherwise evict each other on every retry until
// the ticket expires, and neither would ever pair.

const storage = new Map();
globalThis.window = {
  atob,
  btoa,
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
};
globalThis.localStorage = globalThis.window.localStorage;

const { connectionTarget, hasActivePairing, pairingTicketIsLive, state } = await import(
  "./remote/state.js"
);
const { selectDeviceChromeRenderModel } = await import("./remote/chrome-view-model.js");

function liveTicket(overrides = {}) {
  return {
    pairing_id: "pair-abc",
    broker_url: "wss://broker.example.com",
    broker_channel_id: "room-a",
    pairing_join_ticket: "join-ticket",
    expires_at: Math.floor(Date.now() / 1000) + 120,
    ...overrides,
  };
}

function resetPairingState() {
  state.pairingTicket = null;
  state.pairingRetired = false;
  state.pairingError = null;
  state.pairingPhase = null;
  state.remoteAuth = null;
}

test("connectionTarget offers a live pairing ticket", () => {
  resetPairingState();
  state.pairingTicket = liveTicket();

  const target = connectionTarget();
  assert.equal(target?.joinTicket, "join-ticket");
});

test("connectionTarget refuses a retired pairing ticket so no reconnect re-presents it", () => {
  resetPairingState();
  state.pairingTicket = liveTicket();
  state.pairingRetired = true;

  assert.equal(
    connectionTarget(),
    null,
    "a superseded/expired ticket must not be handed back to the reconnect path"
  );
});

test("connectionTarget refuses a pairing ticket past its expiry, with no error frame needed", () => {
  // The broker hides the real reason behind a generic "broker join rejected", so
  // message sniffing cannot be the only expiry check — and a plain socket close
  // produces no message at all.
  resetPairingState();
  state.pairingTicket = liveTicket({ expires_at: Math.floor(Date.now() / 1000) - 1 });

  assert.equal(connectionTarget(), null, "an expired ticket must not be retried");
});

test("pairingTicketIsLive treats an unknown expiry as live and lets the broker decide", () => {
  assert.equal(pairingTicketIsLive({ pairing_id: "p" }), true);
  assert.equal(pairingTicketIsLive(null), false);
});

test("a retired pairing keeps its error card visible instead of dropping the user home", () => {
  resetPairingState();
  state.pairingTicket = liveTicket();
  state.pairingRetired = true;
  state.pairingPhase = "error";
  state.pairingError = "Another device took over this pairing code.";

  const { cards } = selectDeviceChromeRenderModel(state).deviceMeta;
  assert.equal(
    cards.length,
    1,
    "the pairing card must survive retirement so the explanation stays on screen"
  );
  assert.deepEqual(
    cards[0].badges.map((badge) => [badge.label, badge.tone]),
    [["Pairing failed", "alert"]],
    "the card must read as failed, not as still-in-progress"
  );
  assert.ok(
    cards[0].metaLines.some((line) => line.includes("took over")),
    `the actionable reason must be shown; got ${JSON.stringify(cards[0].metaLines)}`
  );
});

// The dangerous state the earlier tests missed: a browser that ALREADY has a paired
// device profile and then scans a QR that dies. `connectionTarget` falls back to the
// device ticket, so a connection succeeds — and every "are we pairing?" check that
// looks only at `state.pairingTicket` then misfires against the OLD relay room.

function seedPairedDevice() {
  state.remoteAuth = {
    relayId: "relay-1",
    brokerUrl: "wss://broker.example.com",
    brokerChannelId: "old-room",
    deviceId: "device-1",
    deviceJoinTicket: "device-join-ticket",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 600,
    payloadSecret: "secret",
  };
}

test("a retired pairing falls back to the paired device, not to the dead pairing room", () => {
  resetPairingState();
  seedPairedDevice();
  state.pairingTicket = liveTicket();
  state.pairingRetired = true;

  const target = connectionTarget();
  assert.equal(
    target?.joinTicket,
    "device-join-ticket",
    "the existing device profile must stay usable after a failed pairing"
  );
  assert.equal(target?.brokerChannelId, "old-room");
});

test("hasActivePairing is the single source of truth for 'are we pairing right now'", () => {
  resetPairingState();
  seedPairedDevice();
  assert.equal(hasActivePairing(), false, "no ticket at all");

  state.pairingTicket = liveTicket();
  assert.equal(hasActivePairing(), true, "a live, un-retired ticket");

  state.pairingRetired = true;
  assert.equal(
    hasActivePairing(),
    false,
    "a retired ticket must not be treated as an in-flight pairing, or the ready \
handler sends a dead pairing request into the old device's room"
  );

  state.pairingRetired = false;
  state.pairingTicket = liveTicket({ expires_at: Math.floor(Date.now() / 1000) - 1 });
  assert.equal(hasActivePairing(), false, "an expired ticket is not in flight either");
});

test("a pairing error with no ticket is still shown, not swallowed into the unpaired screen", () => {
  // SECURITY-ADJACENT: a legacy `?pairing=` link is rejected precisely BECAUSE its secret
  // already reached the broker, and the user has to be told to generate a fresh one. That
  // path has no ticket to attach the message to (parsing is what failed), so gating the
  // card on `pairingTicket` hid the only actionable instruction behind the generic
  // "no paired device" screen. Same for a malformed fragment.
  resetPairingState();
  state.pairingPhase = "error";
  state.pairingError =
    "this pairing link carries its secret in the query string, which exposes it to the broker; generate a fresh QR";

  const model = selectDeviceChromeRenderModel(state);
  const { cards, emptyMessage } = model.deviceMeta;

  assert.equal(cards.length, 1, "the failure must be rendered as a card");
  assert.deepEqual(
    cards[0].badges.map((badge) => badge.label),
    ["Pairing failed"]
  );
  assert.ok(
    cards[0].metaLines.some((line) => line.includes("generate a fresh QR")),
    `the instruction must be visible; got ${JSON.stringify(cards[0].metaLines)}`
  );
  assert.equal(
    emptyMessage,
    null,
    "and it must not also render the generic unpaired empty state"
  );
});
