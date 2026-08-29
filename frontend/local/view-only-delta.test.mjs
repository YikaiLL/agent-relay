import assert from "node:assert/strict";
import test from "node:test";

import { applyDeltaToViewOnlyPin } from "./view-only-thread.js";

const pin = (overrides = {}) => ({
  threadId: "thread-bg",
  entries: [],
  activeTurnId: null,
  wasWorking: false,
  ...overrides,
});

const delta = (overrides = {}) => ({
  thread_id: "thread-bg",
  item_id: "item-1",
  delta: "hello",
  turn_id: "turn-1",
  delta_kind: "agent_text",
  entry_seq: 3,
  ...overrides,
});

test("a delta for the pinned thread appends a new entry", () => {
  const next = applyDeltaToViewOnlyPin(pin(), delta());

  assert.equal(next.entries.length, 1);
  assert.deepEqual(
    { item_id: next.entries[0].item_id, text: next.entries[0].text, kind: next.entries[0].kind },
    { item_id: "item-1", text: "hello", kind: "agent_text" }
  );
});

test("a second delta for the same item appends to its text rather than duplicating it", () => {
  const first = applyDeltaToViewOnlyPin(pin(), delta());
  const second = applyDeltaToViewOnlyPin(first, delta({ delta: " world" }));

  assert.equal(second.entries.length, 1, "the same item_id must not create a second entry");
  assert.equal(second.entries[0].text, "hello world");
});

test("command output maps to the command entry kind", () => {
  const next = applyDeltaToViewOnlyPin(
    pin(),
    delta({ delta_kind: "command_output", item_id: "cmd-1" })
  );

  assert.equal(next.entries[0].kind, "command");
});

// The whole point of the pin is that it shows ONE thread read-only. If an unrelated
// thread's delta landed in it, a background thread's text would bleed into whatever
// the user was reading.
test("a delta for a different thread is ignored, and the pin identity is preserved", () => {
  const original = pin();
  const next = applyDeltaToViewOnlyPin(original, delta({ thread_id: "thread-other" }));

  assert.equal(next, original, "a non-matching delta must return the SAME object");
});

test("a delta with no thread_id is ignored rather than assumed to be ours", () => {
  const original = pin();
  const next = applyDeltaToViewOnlyPin(original, delta({ thread_id: undefined }));

  assert.equal(next, original);
});

test("a delta with no item_id is ignored", () => {
  const original = pin();
  const next = applyDeltaToViewOnlyPin(original, delta({ item_id: undefined }));

  assert.equal(next, original);
});

test("a null pin is passed through", () => {
  assert.equal(applyDeltaToViewOnlyPin(null, delta()), null);
});

// A pin receiving live text is mid-turn by definition. Reporting it idle is what made
// a watched background thread look finished while output was still arriving.
test("receiving a delta marks the pin as working", () => {
  const next = applyDeltaToViewOnlyPin(pin(), delta());

  assert.equal(next.wasWorking, true);
  assert.equal(next.activeTurnId, "turn-1");
});

test("an existing turn id is not overwritten by a later delta", () => {
  const next = applyDeltaToViewOnlyPin(
    pin({ activeTurnId: "turn-original" }),
    delta({ turn_id: "turn-late" })
  );

  assert.equal(next.activeTurnId, "turn-original");
});

// Deltas must never mutate the pin in place: render paths compare by identity to
// decide whether to re-render, and the old entries array may still be referenced.
test("applying a delta does not mutate the input pin", () => {
  const original = pin({ entries: [{ item_id: "item-1", text: "hello", kind: "agent_text" }] });
  const snapshot = JSON.parse(JSON.stringify(original));

  applyDeltaToViewOnlyPin(original, delta({ delta: " world" }));

  assert.deepEqual(original, snapshot, "the input pin must be untouched");
});

// REVIEW P1: the pin has the same re-delivery hazard as the hydration window — the
// stream can replay a chunk the pin's last authoritative refresh already carried.
test("a re-delivered delta does not double-append into the pin", () => {
  const start = applyDeltaToViewOnlyPin(pin(), delta({ delta: "Hello world", text_offset: 0 }));

  const again = applyDeltaToViewOnlyPin(start, delta({ delta: " world", text_offset: 5 }));

  assert.equal(again.entries[0].text, "Hello world");
});

test("a gapped delta is refused, and now says so instead of waiting", () => {
  const start = applyDeltaToViewOnlyPin(pin(), delta({ delta: "Hello", text_offset: 0 }));

  const gapped = applyDeltaToViewOnlyPin(start, delta({ delta: "tail", text_offset: 99 }));

  // This used to assert `gapped === start` -- identity standing in for "the pin
  // was untouched". The refusal is unchanged and still the point; what changed
  // is that it is no longer SILENT, so identity is expected to differ. The
  // invariant that mattered is the text.
  assert.equal(gapped.entries[0].text, "Hello", "refusing must never splice");
  assert.equal(gapped.entries.length, start.entries.length);
  assert.equal(gapped.tailGap, true, "and the hole is reported for repair now");
});

test("a partially-overlapping re-delivery appends only the missing tail", () => {
  const start = applyDeltaToViewOnlyPin(pin(), delta({ delta: "Hello wor", text_offset: 0 }));

  const next = applyDeltaToViewOnlyPin(start, delta({ delta: " world", text_offset: 5 }));

  assert.equal(next.entries[0].text, "Hello world");
});

// REVIEW P2: a first delta for an unknown item that starts mid-stream means the opening
// text was lost. Showing the tail as a whole message is worse than showing nothing —
// the pin's next authoritative refresh will bring the real body.
test("a first delta for an unknown item at a non-zero offset is refused", () => {
  const original = pin();

  const next = applyDeltaToViewOnlyPin(original, delta({ item_id: "late", text_offset: 42 }));

  // Same inversion as above: the entry must still not be created (its opening
  // text never arrived, so it would render truncated as if whole), but the pin
  // now reports that it needs a page before it can show this item at all.
  assert.deepEqual(
    next.entries.map((entry) => entry.item_id),
    original.entries.map((entry) => entry.item_id),
    "a mid-stream body must not become a new entry"
  );
  assert.equal(next.tailGap, true);
});

test("a first delta at offset 0 still creates the entry", () => {
  const next = applyDeltaToViewOnlyPin(pin(), delta({ item_id: "fresh", text_offset: 0 }));

  assert.equal(next.entries.at(-1).text, "hello");
});
