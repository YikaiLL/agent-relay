import test from "node:test";
import assert from "node:assert/strict";

import { applyRenameToRow } from "./thread-rename.js";

// The optimistic-update rule, extracted from app.js so the ordering hazard below is
// testable without a browser.
//
// A rename triggers a `threads_revision` bump, which makes THIS client refetch the
// thread list too. So three writes race for the same row: the optimistic one, the
// refetched row, and the server receipt applied when the request resolves. They must
// converge on the truth no matter which order they land in.

test("setting a name writes both the display title and the override", () => {
  const row = { id: "t1", name: "Fix the auth bug", preview: "hello" };
  applyRenameToRow(row, "Auth work");
  assert.equal(row.name, "Auth work");
  assert.equal(row.renamed, true);
});

// THE bug this file exists for. A reset cannot write `name = null`, because the receipt
// is applied AFTER the request resolves — by which time the refetch this same rename
// triggered may already have delivered the agent's real title. Nulling it there wipes
// the correct value that just arrived, and the revision has already been consumed, so
// nothing corrects it until the next 12s poll.
test("a reset never clears the display title, so a landed refetch is not clobbered", () => {
  const row = { id: "t1", name: "Auth work", renamed: true };

  // 1. optimistic reset — the override goes, the title is left for the refetch.
  applyRenameToRow(row, null);
  assert.equal(row.renamed, false, "the session is no longer renamed");
  assert.equal(
    row.name,
    "Auth work",
    "the last known title holds for one round trip rather than blanking the tab"
  );

  // 2. the refetch lands with the agent's own title.
  row.name = "Fix the auth bug";

  // 3. the receipt is applied late. It must not undo step 2.
  applyRenameToRow(row, null);
  assert.equal(
    row.name,
    "Fix the auth bug",
    "a late reset receipt must not wipe the agent title the refetch just delivered"
  );
  assert.equal(row.renamed, false);
});

test("a late set receipt is idempotent", () => {
  const row = { id: "t1", name: "Fix the auth bug" };
  applyRenameToRow(row, "Auth work");
  row.name = "Auth work"; // the refetch agrees
  applyRenameToRow(row, "Auth work");
  assert.equal(row.name, "Auth work");
  assert.equal(row.renamed, true);
});

test("a missing row is tolerated (the session may have been closed mid-rename)", () => {
  assert.doesNotThrow(() => applyRenameToRow(null, "Auth work"));
  assert.doesNotThrow(() => applyRenameToRow(undefined, null));
});
