import test from "node:test";
import assert from "node:assert/strict";

import {
  clearComposerError,
  recordComposerError,
  resetComposerErrorsForTest,
  syncComposerError,
} from "./composer-error.js";

function node() {
  return { textContent: "", hidden: true };
}

test.beforeEach(() => {
  resetComposerErrorsForTest();
});

test("a failure is shown only on the thread it happened to", () => {
  const target = node();
  recordComposerError({ threadId: "thread-a", message: "thread not found: thread-a" });

  syncComposerError(target, "thread-a");
  assert.equal(target.hidden, false);
  assert.match(target.textContent, /thread not found: thread-a/);

  // The user navigates away. A's failure is not B's problem — showing it here
  // reads as "B is broken", and the text even names the wrong thread.
  syncComposerError(target, "thread-b");
  assert.equal(target.hidden, true);
  assert.equal(target.textContent, "");
});

test("returning to the thread shows its failure again", () => {
  const target = node();
  recordComposerError({ threadId: "thread-a", message: "boom" });
  syncComposerError(target, "thread-b");
  syncComposerError(target, "thread-a");

  assert.equal(target.hidden, false);
  assert.equal(target.textContent, "boom");
});

test("clearing a thread drops only that thread's failure", () => {
  const target = node();
  recordComposerError({ threadId: "thread-a", message: "a failed" });
  recordComposerError({ threadId: "thread-b", message: "b failed" });

  clearComposerError("thread-a");

  syncComposerError(target, "thread-a");
  assert.equal(target.hidden, true, "a cleared failure must stay gone");
  syncComposerError(target, "thread-b");
  assert.equal(target.textContent, "b failed", "B's failure is none of A's business");
});

test("two threads can hold their own failures at once", () => {
  const target = node();
  recordComposerError({ threadId: "thread-a", message: "a failed" });
  recordComposerError({ threadId: "thread-b", message: "b failed" });

  syncComposerError(target, "thread-a");
  assert.equal(target.textContent, "a failed");
  syncComposerError(target, "thread-b");
  assert.equal(target.textContent, "b failed");
});

test("an empty message clears rather than showing a blank alert", () => {
  const target = node();
  recordComposerError({ threadId: "thread-a", message: "boom" });
  syncComposerError(target, "thread-a");

  recordComposerError({ threadId: "thread-a", message: "   " });
  syncComposerError(target, "thread-a");

  assert.equal(target.hidden, true);
  assert.equal(target.textContent, "");
});

test("syncing without a node still resolves what would be shown", () => {
  // render-session may sync before the composer region exists (a shell that has
  // not mounted); it must not throw, and must not lose the record.
  recordComposerError({ threadId: "thread-a", message: "boom" });

  assert.equal(syncComposerError(null, "thread-a"), "boom");
  assert.equal(syncComposerError(undefined, "thread-b"), "");
});
