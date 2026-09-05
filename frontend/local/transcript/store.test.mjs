import assert from "node:assert/strict";
import test from "node:test";

import { adoptSettledTranscript } from "./store.js";

// adoptSettledTranscript is the reconciliation session-controller.js's
// renderSessionAndClearPendingFlush needs and render-session.js's own
// renderSession (P1 fix: internal callbacks — teamsCache.sync's resolve,
// render-session.js:624 — call renderSession directly, bypassing every
// external wrapper) also needs, now shared instead of duplicated.

test("adoptSettledTranscript returns session unchanged when nothing settled", () => {
  const state = { session: { active_thread_id: "thread-1", transcript: ["fresh"] } };
  const session = { active_thread_id: "thread-1", transcript: ["stale"] };

  assert.equal(adoptSettledTranscript(state, session, false), session);
});

test("adoptSettledTranscript grafts the freshly-settled transcript into a same-thread session copy", () => {
  const state = { session: { active_thread_id: "thread-1", transcript: ["fresh"] } };
  const session = { active_thread_id: "thread-1", transcript: ["stale"], current_status: "idle" };

  const result = adoptSettledTranscript(state, session, true);

  assert.deepEqual(result, { active_thread_id: "thread-1", transcript: ["fresh"], current_status: "idle" });
});

test("adoptSettledTranscript leaves a different thread's session alone", () => {
  const state = { session: { active_thread_id: "thread-1", transcript: ["fresh"] } };
  const session = { active_thread_id: "thread-2", transcript: ["other-thread"] };

  assert.equal(adoptSettledTranscript(state, session, true), session);
});
