import test from "node:test";
import assert from "node:assert/strict";

import {
  readWorkspaceRepair,
  setWorkspaceRepairError,
  setWorkspaceRepairPending,
  workspaceRepairResolved,
} from "./local/workspace-repair.js";

test("repair pending and failure are tracked per thread", () => {
  const state = {};

  setWorkspaceRepairPending(state, "thread-1", true);
  assert.equal(readWorkspaceRepair(state, "thread-1").pending, true);
  // A pending repair on one thread must not freeze another thread's banner.
  assert.equal(readWorkspaceRepair(state, "thread-2").pending, false);

  setWorkspaceRepairError(state, "thread-1", "permission denied");
  assert.equal(readWorkspaceRepair(state, "thread-1").pending, false);
  assert.equal(readWorkspaceRepair(state, "thread-1").error, "permission denied");

  // Starting another attempt drops the stale failure.
  setWorkspaceRepairPending(state, "thread-1", true);
  assert.equal(readWorkspaceRepair(state, "thread-1").error, "");
});

test("a settled repair clears the button's own state", () => {
  const state = {};
  setWorkspaceRepairPending(state, "thread-1", true);

  // The BANNER goes away because the snapshot the relay hands back says the workspace is
  // there; this only has to stop the button claiming it is still working.
  workspaceRepairResolved(state, "thread-1");
  assert.equal(readWorkspaceRepair(state, "thread-1").pending, false);
  assert.equal(readWorkspaceRepair(state, "thread-1").error, "");
});
