import test from "node:test";
import assert from "node:assert/strict";

import { createThreadListStore, readActiveProjectId } from "./thread-list-store.js";

// `activeProjectId` lives as a SIBLING of `threadList`, and the remote surface snapshots
// it through `useSyncExternalStore`. For a selection to reach the screen, two things
// must hold: `setActiveProject` must NOTIFY subscribers, and the read must see the new
// value immediately. The trap the deleted `viewMode` tests documented still applies —
// a setter that mutates a nested object the store never replaces changes hidden state
// without re-rendering anything.
test("setActiveProject notifies subscribers and flips the snapshot", () => {
  const store = createThreadListStore();
  assert.equal(readActiveProjectId(store), null, "defaults to no project");

  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });

  store.getState().setActiveProject("proj_pay");
  assert.ok(notified >= 1, "setActiveProject fires store subscribers");
  assert.equal(readActiveProjectId(store), "proj_pay", "the snapshot flips immediately");

  store.getState().setActiveProject(null);
  assert.equal(readActiveProjectId(store), null);
});

// Null, never "" or a non-string: every consumer treats a truthy id as "a project is
// pinned", so a falsy-but-present value would pin nothing while reading as a selection.
test("readActiveProjectId normalizes anything that is not a real id to null", () => {
  const store = createThreadListStore();
  for (const value of ["", 0, false, undefined, null, 123]) {
    store.getState().setActiveProject(value);
    assert.equal(readActiveProjectId(store), null, `${JSON.stringify(value)} is not an id`);
  }

  const seeded = createThreadListStore({ activeProjectId: "proj_docs" });
  assert.equal(readActiveProjectId(seeded), "proj_docs", "an initial selection is honored");
});
