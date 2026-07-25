import test from "node:test";
import assert from "node:assert/strict";

import {
  createViewedThreadRefreshLatch,
  VIEWED_THREAD_REFRESH_INTERVAL_MS,
  shouldRefreshViewedThread,
} from "./viewed-thread-refresh.js";

test("working viewed threads refresh only after the throttle interval", () => {
  assert.equal(
    shouldRefreshViewedThread({
      elapsedMs: VIEWED_THREAD_REFRESH_INTERVAL_MS - 1,
      wasWorking: true,
      working: true,
    }),
    false
  );
  assert.equal(
    shouldRefreshViewedThread({
      elapsedMs: VIEWED_THREAD_REFRESH_INTERVAL_MS,
      wasWorking: true,
      working: true,
    }),
    true
  );
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
