import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_TRACKED_COMPOSER_ERRORS,
  threadError,
  withThreadError,
  withoutThreadError,
} from "./composer-errors.js";

// Composer failures are per-thread, on BOTH surfaces, because every operation
// that touches them races with navigation:
//   - a send/settings request can land after the user switched sessions;
//   - the success of one thread's request must not silence another thread's
//     real failure.
// A single "most recent failure" slot makes each of those a separate bug to
// notice and patch. Keyed by thread, the whole class stops existing: an
// operation on A can only ever touch A's entry.

test("a failure is keyed by its thread", () => {
  const errors = withThreadError({}, "thread-a", "thread not found: thread-a");

  assert.equal(threadError(errors, "thread-a"), "thread not found: thread-a");
  assert.equal(threadError(errors, "thread-b"), "", "B has no failure of its own");
});

test("recording a failure on one thread leaves another thread's failure alone", () => {
  let errors = withThreadError({}, "thread-a", "a failed");
  errors = withThreadError(errors, "thread-b", "b failed");

  assert.equal(threadError(errors, "thread-a"), "a failed");
  assert.equal(threadError(errors, "thread-b"), "b failed");
});

test("clearing one thread leaves another thread's failure visible", () => {
  // The inverse race: A's request SUCCEEDS while B is showing a real failure.
  // A global clear would silence B and put us right back at "the send failed
  // and nothing said so".
  let errors = withThreadError({}, "thread-b", "b failed");
  errors = withoutThreadError(errors, "thread-a");

  assert.equal(threadError(errors, "thread-b"), "b failed");
});

test("clearing a thread drops its own failure", () => {
  let errors = withThreadError({}, "thread-a", "a failed");
  errors = withoutThreadError(errors, "thread-a");

  assert.equal(threadError(errors, "thread-a"), "");
});

test("an empty message clears instead of recording a blank alert", () => {
  let errors = withThreadError({}, "thread-a", "a failed");
  errors = withThreadError(errors, "thread-a", "   ");

  assert.equal(threadError(errors, "thread-a"), "");
});

test("a missing thread id records nothing", () => {
  assert.deepEqual(withThreadError({}, "", "orphan failure"), {});
  assert.equal(threadError({ "thread-a": "a" }, null), "");
});

test("the map is bounded, evicting the oldest failures first", () => {
  // The local shell is a long-lived page; without a bound this grows once per
  // failing thread forever.
  let errors = {};
  for (let i = 0; i < MAX_TRACKED_COMPOSER_ERRORS + 3; i += 1) {
    errors = withThreadError(errors, `thread-${i}`, `failure ${i}`);
  }

  assert.equal(Object.keys(errors).length, MAX_TRACKED_COMPOSER_ERRORS);
  assert.equal(threadError(errors, "thread-0"), "", "the oldest entry is evicted");
  assert.equal(
    threadError(errors, `thread-${MAX_TRACKED_COMPOSER_ERRORS + 2}`),
    `failure ${MAX_TRACKED_COMPOSER_ERRORS + 2}`,
    "the newest entry survives"
  );
});

test("re-recording a thread keeps it fresh against eviction", () => {
  let errors = {};
  for (let i = 0; i < MAX_TRACKED_COMPOSER_ERRORS; i += 1) {
    errors = withThreadError(errors, `thread-${i}`, `failure ${i}`);
  }
  errors = withThreadError(errors, "thread-0", "still failing");
  errors = withThreadError(errors, "thread-new", "newest");

  assert.equal(threadError(errors, "thread-0"), "still failing");
  assert.equal(threadError(errors, "thread-1"), "", "the next-oldest went instead");
});

test("inputs are never mutated in place", () => {
  const original = { "thread-a": "a failed" };
  withThreadError(original, "thread-b", "b failed");
  withoutThreadError(original, "thread-a");

  assert.deepEqual(original, { "thread-a": "a failed" });
});
