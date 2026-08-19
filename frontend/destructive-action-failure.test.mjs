// The original symptom was not "delete is broken" but "delete looks like it did
// nothing": the failure reached only #client-log, a collapsed panel. These tests
// pin the pairing — a refused destructive action is both recorded AND shown —
// because a test that only checked the wording would still pass if the visible
// half were dropped.
import test from "node:test";
import assert from "node:assert/strict";

import {
  describeDestructiveActionFailure,
  reportDestructiveActionFailure,
} from "./shared/destructive-action-failure.js";

test("a refused action is reported through BOTH the log and a visible notice", () => {
  const logged = [];
  const shown = [];

  const text = reportDestructiveActionFailure({
    action: "delete",
    title: "Instagram Scraper",
    error: new Error("session 84ba0da5 was not found in local Cursor storage"),
    log: (message) => logged.push(message),
    notify: (message) => shown.push(message),
  });

  assert.equal(logged.length, 1, "the log keeps the record");
  assert.equal(shown.length, 1, "and the user is actually told");
  assert.equal(logged[0], shown[0], "both channels say the same thing");
  assert.equal(shown[0], text);
  assert.match(text, /Could not delete "Instagram Scraper"/);
  assert.match(text, /was not found in local Cursor storage/, "the relay's reason survives");
});

test("the message names the session, so it is clear which row was acted on", () => {
  assert.equal(
    describeDestructiveActionFailure({
      action: "archive",
      title: "Clean Up Chinese",
      message: "Cursor does not support archiving sessions",
    }),
    'Could not archive "Clean Up Chinese": Cursor does not support archiving sessions'
  );
});

// A throw with no message must not render "undefined" at the user.
test("a reasonless failure still produces a sentence", () => {
  for (const message of [undefined, null, "", "   "]) {
    const text = describeDestructiveActionFailure({ action: "delete", title: "X", message });
    assert.equal(text, 'Could not delete "X": the relay did not say why');
  }
});

test("an unnamed session degrades to a generic subject rather than empty quotes", () => {
  assert.equal(
    describeDestructiveActionFailure({ action: "delete", title: "", message: "nope" }),
    "Could not delete this session: nope"
  );
});

test("reporting is defensive about missing inputs rather than throwing in a catch block", () => {
  assert.doesNotThrow(() => reportDestructiveActionFailure());
  assert.doesNotThrow(() => reportDestructiveActionFailure({ action: "delete" }));
});
