import test from "node:test";
import assert from "node:assert/strict";

import { forkCompletionEffect } from "./fork-submit-ownership.js";

test("a completion for the dialog still on screen applies", () => {
  assert.equal(
    forkCompletionEffect({ capturedGeneration: 3, currentGeneration: 3, ok: true }),
    "close"
  );
  assert.equal(
    forkCompletionEffect({ capturedGeneration: 3, currentGeneration: 3, ok: false }),
    "showError"
  );
});

// The bug this encodes: submit fork A, cancel it, open fork B, then let A
// finish. A's success used to close B (throwing away B's prompt and pasted
// screenshots) and A's failure used to stamp B with A's error while B's own
// request was still in flight.
test("a completion from a superseded dialog opening is discarded", () => {
  assert.equal(
    forkCompletionEffect({ capturedGeneration: 3, currentGeneration: 4, ok: true }),
    "discard",
    "a stale success must not close the dialog the user reopened"
  );
  assert.equal(
    forkCompletionEffect({ capturedGeneration: 3, currentGeneration: 4, ok: false }),
    "discard",
    "a stale failure must not stamp its error on the newer dialog"
  );
});
