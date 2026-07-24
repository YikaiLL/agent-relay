import test from "node:test";
import assert from "node:assert/strict";

import { createThreadListStore, readThreadListViewMode } from "./thread-list-store.js";

// The remote Sessions/Projects toggle is a `useSyncExternalStore(store.subscribe,
// () => readThreadListViewMode(store))`. For it to re-render on click, two things must
// hold: setViewMode must NOTIFY store subscribers, and readThreadListViewMode must
// return the NEW value. (The earlier bug snapshotted the sibling `threadList` object,
// which setViewMode never replaces, so the toggle changed hidden state without
// re-rendering.)
test("setViewMode notifies subscribers and flips the viewMode snapshot", () => {
  const store = createThreadListStore();
  assert.equal(readThreadListViewMode(store), "sessions", "defaults to sessions");

  let notified = 0;
  const unsub = store.subscribe(() => {
    notified += 1;
  });
  store.getState().setViewMode("projects");
  assert.ok(notified >= 1, "setViewMode fires store subscribers (drives useSyncExternalStore)");
  assert.equal(readThreadListViewMode(store), "projects", "the viewMode snapshot flips immediately");

  store.getState().setViewMode("sessions");
  assert.equal(readThreadListViewMode(store), "sessions");
  unsub();
});

test("readThreadListViewMode normalizes unknown modes to sessions", () => {
  const store = createThreadListStore();
  store.getState().setViewMode("garbage");
  assert.equal(readThreadListViewMode(store), "sessions");
  const seeded = createThreadListStore({ viewMode: "projects" });
  assert.equal(readThreadListViewMode(seeded), "projects", "initial viewMode is honored");
});
