import test from "node:test";
import assert from "node:assert/strict";

import { displayedEntriesFrom, displayedThreadIdFrom } from "./displayed-thread.js";

// The bug this pins: `displayedThreadId()` knew two ways a thread can be on
// screen (a view-only pin, or the active thread) and not the third. The Tasks
// screen draws the Orchestrator BESIDE the conversation rather than instead of
// it, so it matched neither — and every detail fetch from that pane would have
// resolved against the session's thread instead. That is why the tool toggles
// were withheld rather than merely broken.
test("the Orchestrator wins while the Tasks screen is drawing it", () => {
  const state = {
    orchestratorOnScreenThreadId: "orch-1",
    viewOnlyThread: { threadId: "pinned-1" },
    session: { active_thread_id: "thread-1" },
  };

  assert.equal(displayedThreadIdFrom(state), "orch-1");
});

test("a view-only pin still wins over the active thread when Tasks is not up", () => {
  const state = {
    orchestratorOnScreenThreadId: null,
    viewOnlyThread: { threadId: "pinned-1" },
    session: { active_thread_id: "thread-1" },
  };

  assert.equal(displayedThreadIdFrom(state), "pinned-1");
});

test("otherwise it is the active thread, and null when there is none", () => {
  assert.equal(displayedThreadIdFrom({ session: { active_thread_id: "thread-1" } }), "thread-1");
  assert.equal(displayedThreadIdFrom({}), null);
  assert.equal(displayedThreadIdFrom(null), null);
});

// Entries have to come from the same place the pane draws from, or a click
// resolves against a list the user cannot see.
test("the Orchestrator's entries follow whether it is the active thread", () => {
  const cached = [{ item_id: "cached" }];
  const live = [{ item_id: "live" }];

  const notActive = {
    orchestratorOnScreenThreadId: "orch-1",
    orchestratorEntries: cached,
    session: { active_thread_id: "thread-1" },
  };
  assert.deepEqual(displayedEntriesFrom(notActive, live), cached);

  // Once it IS the active thread the pane renders session.transcript, so the
  // cached page is stale and must not be what a click resolves against.
  const active = {
    orchestratorOnScreenThreadId: "orch-1",
    orchestratorEntries: cached,
    session: { active_thread_id: "orch-1" },
  };
  assert.deepEqual(displayedEntriesFrom(active, live), live);
});

test("entries fall back to the pin, then to the hydrated transcript", () => {
  const live = [{ item_id: "live" }];
  const pinned = [{ item_id: "pinned" }];

  assert.deepEqual(displayedEntriesFrom({ viewOnlyThread: { entries: pinned } }, live), pinned);
  assert.deepEqual(displayedEntriesFrom({}, live), live);
  assert.deepEqual(displayedEntriesFrom(null, undefined), []);
});
