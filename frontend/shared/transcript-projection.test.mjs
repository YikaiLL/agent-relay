import test from "node:test";
import assert from "node:assert/strict";

import {
  adoptSettledTranscript,
  markTranscriptWindowProjectionPending,
  settleTranscriptProjection,
} from "./transcript-projection.js";

function loadedWindowState(threadId, entries, overrides = {}) {
  return {
    transcriptHydrationThreadId: threadId,
    transcriptHydrationEntries: new Map(entries.map((entry) => [entry.item_id, entry])),
    transcriptHydrationOrder: entries.map((entry) => entry.item_id),
    ...overrides,
  };
}

test("settleTranscriptProjection is a no-op when nothing is pending", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "a", text: "hi", status: "running" },
  ]);
  state.session = { active_thread_id: "thread-1", transcript: [] };

  assert.equal(settleTranscriptProjection(state), false);
});

test("settleTranscriptProjection materialises the window into state.session by default", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "a", text: "hello world", status: "running" },
  ]);
  state.session = {
    active_thread_id: "thread-1",
    transcript: [{ item_id: "a", text: "hello", status: "running" }],
  };
  markTranscriptWindowProjectionPending(state);

  const changed = settleTranscriptProjection(state);

  assert.equal(changed, true);
  assert.equal(state.session.transcript[0].text, "hello world");
});

// Remote's shape: two session slots. When they alias the same object (the
// common, unpinned case), settle must rebuild once and keep them aliased —
// not fork them into two separately-rebuilt-but-value-identical objects.
test("settleTranscriptProjection rebuilds once and keeps two aliased session slots aliased", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "a", text: "hello world", status: "running" },
  ]);
  const shared = {
    active_thread_id: "thread-1",
    transcript: [{ item_id: "a", text: "hello", status: "running" }],
  };
  state.realSession = shared;
  state.session = shared;
  markTranscriptWindowProjectionPending(state);

  const changed = settleTranscriptProjection(state, ["realSession", "session"]);

  assert.equal(changed, true);
  assert.equal(state.realSession, state.session, "aliasing must survive the rebuild");
  assert.equal(state.session.transcript[0].text, "hello world");
});

test("settleTranscriptProjection's onRebuild fires exactly once for two aliased session slots", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "a", text: "hello world", status: "running" },
  ]);
  const shared = {
    active_thread_id: "thread-1",
    transcript: [{ item_id: "a", text: "hello", status: "running" }],
  };
  state.realSession = shared;
  state.session = shared;
  markTranscriptWindowProjectionPending(state);

  let rebuildCount = 0;
  settleTranscriptProjection(state, ["realSession", "session"], () => {
    rebuildCount += 1;
  });

  assert.equal(rebuildCount, 1, "one object, one actual rebuild, regardless of how many slots point at it");
});

// P1 regression (.sealwire/PLAN.md, "The criterion-3 proof is currently
// unsound"): a caller's own rebuild counter (remote's
// transcriptDeltaRebuildCount) must be driven by onRebuild firing per actual
// rebuild, not by "did this settle() call change anything" — two DIFFERENT
// session objects that both happen to match the window's thread is exactly
// the case a once-per-call counter cannot tell apart from the aliased case
// above, and would silently under-report by half.
test("settleTranscriptProjection's onRebuild fires once per DISTINCT session object rebuilt, not once per call", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "a", text: "hello world", status: "running" },
  ]);
  state.realSession = {
    active_thread_id: "thread-1",
    transcript: [{ item_id: "a", text: "hello", status: "running" }],
  };
  // A second, genuinely different object for the SAME thread — not the
  // aliasing case above, and not the pinned-different-thread case below.
  state.session = {
    active_thread_id: "thread-1",
    transcript: [{ item_id: "a", text: "hello", status: "running" }],
  };
  markTranscriptWindowProjectionPending(state);

  let rebuildCount = 0;
  const changed = settleTranscriptProjection(state, ["realSession", "session"], () => {
    rebuildCount += 1;
  });

  assert.equal(changed, true);
  assert.equal(rebuildCount, 2, "two distinct objects were rebuilt — the counter must reflect both, not one");
});

// A background thread pinned view-only: state.realSession (the live thread)
// and state.session (the pinned projection) are genuinely different threads.
// Only the slot(s) matching the window's own thread may be rebuilt.
test("settleTranscriptProjection rebuilds only the slot(s) matching the window's thread", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "a", text: "hello world", status: "running" },
  ]);
  state.realSession = {
    active_thread_id: "thread-1",
    transcript: [{ item_id: "a", text: "hello", status: "running" }],
  };
  const pinnedTranscript = [{ item_id: "b", text: "pinned thread's own text", status: "completed" }];
  state.session = { active_thread_id: "thread-2", transcript: pinnedTranscript };
  markTranscriptWindowProjectionPending(state);

  const changed = settleTranscriptProjection(state, ["realSession", "session"]);

  assert.equal(changed, true);
  assert.equal(state.realSession.transcript[0].text, "hello world");
  assert.equal(state.session.transcript, pinnedTranscript, "the unrelated pinned thread must be left untouched");
});

test("settleTranscriptProjection consumes the pending flag even with no session to settle into", () => {
  // An auth loss / teardown nulled every session slot — the flag must not
  // survive to poison the NEXT session's first settle. See .sealwire/PLAN.md,
  // "Discarding the session must discard pending derived state".
  const state = loadedWindowState("thread-1", [{ item_id: "a", text: "x", status: "running" }]);
  state.session = null;
  markTranscriptWindowProjectionPending(state);

  const changed = settleTranscriptProjection(state);

  assert.equal(changed, false);
  assert.equal(
    state.transcriptWindowProjectionPending,
    false,
    "the flag must be consumed, not left pending for whatever session arrives next"
  );
});

test("settleTranscriptProjection does nothing when the window is not loaded", () => {
  const state = {
    transcriptHydrationThreadId: null,
    transcriptHydrationEntries: new Map(),
    transcriptHydrationOrder: [],
    session: { active_thread_id: "thread-1", transcript: [] },
  };
  markTranscriptWindowProjectionPending(state);

  assert.equal(settleTranscriptProjection(state), false);
});

test("adoptSettledTranscript returns the session unchanged when nothing settled", () => {
  const state = { session: { active_thread_id: "thread-1", transcript: ["fresh"] } };
  const session = { active_thread_id: "thread-1", transcript: ["stale"] };

  assert.equal(adoptSettledTranscript(state, session, false), session);
});

test("adoptSettledTranscript grafts the freshly-settled transcript by matching active_thread_id, not identity", () => {
  const state = { session: { active_thread_id: "thread-1", transcript: ["fresh"] } };
  const session = { active_thread_id: "thread-1", transcript: ["stale"] };

  const adopted = adoptSettledTranscript(state, session, true);

  assert.equal(adopted.transcript, state.session.transcript);
  assert.deepEqual(adopted.transcript, ["fresh"]);
});

// Remote's shape: checks state.realSession before state.session, matching
// the order the old hand-rolled applyRenderedSession logic used.
test("adoptSettledTranscript checks sessionKeys in order — realSession before session", () => {
  const state = {
    realSession: { active_thread_id: "thread-1", transcript: ["from realSession"] },
    session: { active_thread_id: "thread-1", transcript: ["from session"] },
  };
  const session = { active_thread_id: "thread-1", transcript: ["stale"] };

  const adopted = adoptSettledTranscript(state, session, true, ["realSession", "session"]);

  assert.deepEqual(adopted.transcript, ["from realSession"]);
});

test("adoptSettledTranscript leaves a different thread's session alone", () => {
  const state = { session: { active_thread_id: "thread-1", transcript: ["fresh"] } };
  const session = { active_thread_id: "thread-2", transcript: ["own text"] };

  const adopted = adoptSettledTranscript(state, session, true);

  assert.equal(adopted, session);
});
