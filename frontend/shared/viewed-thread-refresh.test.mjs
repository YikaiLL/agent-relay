import test from "node:test";
import assert from "node:assert/strict";

import {
  createViewedThreadRefreshLatch,
  VIEWED_THREAD_REFRESH_INTERVAL_MS,
  shouldRefreshViewedThread,
} from "./viewed-thread-refresh.js";

// This used to assert the opposite: that a still-working thread refetches its
// tail once every VIEWED_THREAD_REFRESH_INTERVAL_MS. That poll is gone, and the
// inversion is the point of the change rather than a casualty of it.
//
// It was written when the relay streamed only the globally-active thread, so
// polling WAS how a viewed thread's tail arrived. Per-thread streaming landed
// two months later and made it redundant -- but not harmless: every refetch
// replaced the live tail with a server page built moments earlier, so whatever
// the stream had appended in between vanished. Users reported it as "sometimes
// it loses my own message", which is exactly right: their message is the newest
// entry in the pin and so the likeliest to be missing from that page.
test("a still-working viewed thread is not re-polled; the stream owns its tail", () => {
  for (const elapsedMs of [0, VIEWED_THREAD_REFRESH_INTERVAL_MS, 60_000]) {
    assert.equal(
      shouldRefreshViewedThread({ elapsedMs, wasWorking: true, working: true }),
      false,
      `no refetch at ${elapsedMs}ms while the thread is still working`
    );
  }
});

test("working to idle always gets a final refresh", () => {
  assert.equal(
    shouldRefreshViewedThread({
      elapsedMs: 0,
      historyLoading: true,
      wasWorking: true,
      working: false,
    }),
    true,
    "older-history loading must not swallow the only terminal snapshot"
  );
});

test("loading and settled viewed threads do not start another refresh", () => {
  assert.equal(
    shouldRefreshViewedThread({
      elapsedMs: VIEWED_THREAD_REFRESH_INTERVAL_MS,
      loading: true,
      wasWorking: true,
      working: false,
    }),
    false
  );
  assert.equal(
    shouldRefreshViewedThread({
      elapsedMs: VIEWED_THREAD_REFRESH_INTERVAL_MS,
      historyLoading: true,
      wasWorking: true,
      working: true,
    }),
    false,
    "an older-page fetch must not be invalidated by a new tail generation"
  );
  assert.equal(
    shouldRefreshViewedThread({
      elapsedMs: VIEWED_THREAD_REFRESH_INTERVAL_MS,
      wasWorking: false,
      working: false,
    }),
    false
  );
});

test("an older-page fetch settling re-arms a deferred terminal tail refresh", () => {
  const latch = createViewedThreadRefreshLatch();
  const threadId = "thread-A";
  const terminalRefreshNeeded = shouldRefreshViewedThread({
    elapsedMs: 0,
    historyLoading: true,
    wasWorking: true,
    working: false,
  });

  assert.equal(terminalRefreshNeeded, true);
  latch.defer(threadId);
  assert.equal(
    latch.take(),
    threadId,
    "history completion returns the viewed thread whose final refresh was deferred"
  );
  assert.equal(
    shouldRefreshViewedThread({
      elapsedMs: 0,
      historyLoading: false,
      wasWorking: true,
      working: false,
    }),
    true,
    "the completion re-check starts the authoritative terminal tail refresh"
  );
  assert.equal(latch.take(), null, "the deferred refresh is consumed exactly once");
});

// A refused delta leaves a hole. The conversation repairs one on the next
// render (its entry is downgraded to `preview`, which re-arms hydration); a pin
// had to wait for whatever refreshed next, and since the 300ms poll went away
// that is the end of the turn. The pin's reducer now raises `tailGap`, and this
// is what makes it mean something.
test("a reported gap is repaired now, not at the end of the turn", () => {
  assert.equal(
    shouldRefreshViewedThread({ wasWorking: true, working: true, needsRepair: true }),
    true,
    "mid-turn is exactly when a hole is worth closing"
  );
});

test("but not while a fetch for it is already in flight", () => {
  assert.equal(
    shouldRefreshViewedThread({ wasWorking: true, working: true, needsRepair: true, loading: true }),
    false
  );
});

test("no reported gap keeps the quiet default", () => {
  assert.equal(
    shouldRefreshViewedThread({ wasWorking: true, working: true, needsRepair: false }),
    false
  );
});
