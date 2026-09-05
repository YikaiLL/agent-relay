import test from "node:test";
import assert from "node:assert/strict";

import {
  runLocalBootDataPhase,
  syncProjectsForSession,
} from "./boot-session-view.js";
import {
  createSessionViewController,
  createSessionViewStore,
} from "../shared/session-view-controller.js";

const sessions = () => ({ kind: "sessions" });

test("boot completes route restoration before session loading can reconcile Projects history", async () => {
  const writes = [];
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
  });
  const controller = createSessionViewController({
    store,
    historyAdapter: {
      write(value) {
        writes.push(value);
      },
    },
  });
  const calls = [];
  let releaseRestore;
  const restoreGate = new Promise((resolve) => {
    releaseRestore = resolve;
  });

  const bootPromise = runLocalBootDataPhase({
    async restoreHistory() {
      calls.push("restore-start");
      await restoreGate;
      await controller.restoreHistory(
        { version: 1, context: sessions() },
        "thread-deep-link"
      );
      calls.push("restore-complete");
    },
    async loadSession() {
      calls.push("load-session");
      // The same shape as app.js's Projects subscriber: drain earlier route
      // work, read canonical location, then reconcile it through history.
      await controller.whenIdle();
      const location = store.getState().location;
      await controller.restoreHistory(
        { version: 1, context: location.context },
        location.threadId
      );
    },
    async loadThreads() {
      calls.push("load-threads");
    },
    connectSessionStream() {
      calls.push("connect-stream");
    },
    scheduleThreadsPoll() {
      calls.push("schedule-poll");
    },
  });

  await Promise.resolve();
  assert.deepEqual(
    calls,
    ["restore-start"],
    "session loading must not start merely because restoreHistory was invoked"
  );
  releaseRestore();
  await bootPromise;

  assert.deepEqual(
    writes.map((write) => write.threadId),
    ["thread-deep-link", "thread-deep-link"],
    "Projects reconciliation must inherit the restored URL thread rather than erase it"
  );
  assert.deepEqual(calls, [
    "restore-start",
    "restore-complete",
    "load-session",
    "load-threads",
    "connect-stream",
    "schedule-poll",
  ]);
});

test("a failed route restore degrades to data, stream, and poll startup", async () => {
  const calls = [];
  const restoreError = new Error("corrupt persisted session view");

  await runLocalBootDataPhase({
    async restoreHistory() {
      calls.push("restore-history");
      throw restoreError;
    },
    async loadSession() {
      calls.push("load-session");
    },
    async loadThreads() {
      calls.push("load-threads");
    },
    connectSessionStream() {
      calls.push("connect-stream");
    },
    scheduleThreadsPoll() {
      calls.push("schedule-poll");
    },
    onRestoreError(error) {
      calls.push(`restore-error:${error.message}`);
    },
  });

  assert.deepEqual(calls, [
    "restore-history",
    "restore-error:corrupt persisted session view",
    "load-session",
    "load-threads",
    "connect-stream",
    "schedule-poll",
  ]);
});

test("route commits before the first session snapshot do not start a revision-zero Projects fetch", () => {
  const revisions = [];
  const projectsStore = {
    syncToRevision(revision) {
      revisions.push(revision);
    },
  };

  syncProjectsForSession(projectsStore, null);
  assert.deepEqual(revisions, []);

  syncProjectsForSession(projectsStore, { projects_revision: 7 });
  assert.deepEqual(revisions, [7]);
});
