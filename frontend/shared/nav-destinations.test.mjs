// The sidebar nav's two destinations, driven against a real store + controller.
//
// The reducer half of this is already covered: session-view-state.test.mjs proves that
// SHOW_OVERVIEW keeps a workspace's remembered focus and that SWITCH_CONTEXT restores
// it. What was NOT covered is which of those two commands the nav actually sends — and
// that is where the bug lived. `openSessionsScreen` sent SHOW_OVERVIEW, so a round trip
// through Tasks came back to a blank "Relay console home" with the session still listed
// in the sidebar. These tests pin the wiring, not the reducer.

import assert from "node:assert/strict";
import test from "node:test";

import {
  openSessionsDestination,
  openTasksDestination,
  openTeamsDestination,
  openUsageDestination,
} from "./nav-destinations.js";
import {
  createSessionViewController,
  createSessionViewStore,
} from "./session-view-controller.js";

function harness({ projectIds = null } = {}) {
  const store = createSessionViewStore({
    initialLocation: { context: { kind: "sessions" }, threadId: null },
  });
  // `null` = "catalogue unknown", the same signal app.js sends before the Projects
  // payload lands. The controller's own default is an authoritative EMPTY list, which
  // would have these tests assert deletion behaviour they are not about.
  return {
    store,
    controller: createSessionViewController({ store, getProjectIds: () => projectIds }),
  };
}

/**
 * The configuration the real app actually runs in.
 *
 * The plain `harness()` above has no persistence, and that is not a smaller version of
 * production — it is a different code path. A persisted dispatch rebuilds state from the
 * stored workspace snapshot inside `transactionPlan`, so anything the store keeps OUTSIDE
 * `location`/`workspaces` has to be threaded through that rebuild explicitly or it is
 * silently dropped on every single command. Tests that only used the in-memory store hid
 * exactly that class of bug.
 *
 * Dispatch is genuinely async here, which is what lets two commands overlap.
 */
function persistedHarness({ projectIds = null, unavailableThreadIds = [] } = {}) {
  const values = new Map();
  const persistence = {
    async transact(operation) {
      const snapshot = Object.fromEntries(values.entries());
      const plan = operation(snapshot);
      for (const key of new Set(plan?.deletes || [])) {
        values.delete(key);
      }
      for (const [key, workspace] of Object.entries(plan?.writes || {})) {
        values.set(key, workspace);
      }
      return plan?.value;
    },
  };
  const store = createSessionViewStore({
    initialLocation: { context: { kind: "sessions" }, threadId: null },
    persistence,
  });
  const controller = createSessionViewController({
    store,
    // Mirrors app.js: null means "the catalogue has not loaded, absence proves nothing".
    getProjectIds: () => projectIds,
    // app.js feeds the stored tombstone list on EVERY command, so for any user who has
    // ever deleted or archived a session this set is permanently non-empty. Defaulting
    // it to `[]` in tests models a brand-new profile and nothing else.
    getUnavailableThreadIds: () => new Set(unavailableThreadIds),
  });
  return { store, controller };
}


const location = (store) => store.getState().location;

test("returning to Sessions from Tasks shows the session you left", async () => {
  const { store, controller } = harness();
  await controller.openThread("thread-a");
  assert.equal(location(store).threadId, "thread-a", "precondition: a session is on screen");

  await openTasksDestination(controller);
  assert.equal(location(store).context.kind, "tasks");
  assert.equal(
    location(store).threadId,
    null,
    "the Task screen is full-area, so no conversation is routed while it shows"
  );

  await openSessionsDestination(controller);
  assert.equal(location(store).context.kind, "sessions");
  // The regression: landing here with a null threadId renders the empty
  // "Relay console home" placeholder, and — because local derives the session
  // drawer's open state from "am I viewing a conversation" — collapses the sidebar
  // list to its bare "N folders · N sessions" summary. The session was never lost;
  // only the route to it was.
  assert.equal(
    location(store).threadId,
    "thread-a",
    "Sessions must restore the workspace's remembered focus, not blank it"
  );
});

test("Usage blanks the selection the same way Tasks does", async () => {
  const { store, controller } = harness();
  await controller.openThread("thread-a");

  await openUsageDestination(controller);
  assert.equal(location(store).context.kind, "usage");
  assert.equal(
    location(store).threadId,
    null,
    "the Usage screen is full-area, so no conversation is routed while it shows"
  );

  await openSessionsDestination(controller);
  assert.equal(location(store).threadId, "thread-a");
});

test("Teams blanks the selection and remembers which team is open", async () => {
  const { store, controller } = harness();
  await controller.openThread("thread-a");

  await openTeamsDestination(controller, "builtin");
  assert.equal(location(store).context.kind, "teams");
  assert.equal(location(store).context.teamId, "builtin");
  assert.equal(location(store).threadId, null);
});

test("Tasks opens its list rather than reopening a task", async () => {
  const { store, controller } = harness();

  await openTasksDestination(controller);

  // `teamRunId: null` is load-bearing: opening a specific task is what discharges its
  // "needs you" badge, so nav must never do it on the user's behalf.
  assert.deepEqual(location(store).context, { kind: "tasks", teamRunId: null });
});

test("a round trip through Tasks keeps the Sessions tab set intact", async () => {
  const { store, controller } = harness();
  await controller.openThread("thread-a", { preview: false });
  await controller.openThread("thread-b", { preview: false });

  await openTasksDestination(controller);
  await openSessionsDestination(controller);

  const workspace = store.getState().workspaces[
    Object.keys(store.getState().workspaces).find((key) => key !== "tasks")
  ];
  assert.equal(
    (workspace?.tabs || []).length,
    2,
    "both open sessions survive the trip to Tasks and back"
  );
  assert.equal(location(store).threadId, "thread-b", "the last-focused one is restored");
});

test("returning to Sessions restores the PROJECT you left, not just the default workspace", async () => {
  const { store, controller } = harness();
  const project = { kind: "project", projectId: "project-1" };
  await controller.openThread("thread-in-project", { context: project });
  assert.deepEqual(location(store).context, project, "precondition: inside a project");
  assert.equal(location(store).threadId, "thread-in-project");

  await openTasksDestination(controller);
  await openSessionsDestination(controller);

  // Restoring only `{kind:"sessions"}` would silently move the user to the default
  // workspace — a different tab set — which reads as "my project's sessions are gone".
  assert.deepEqual(location(store).context, project, "the project context comes back");
  assert.equal(
    location(store).threadId,
    "thread-in-project",
    "and with it the exact tab that was focused there"
  );
});

test("the remembered return context tracks the LAST tab surface, not the first", async () => {
  const { store, controller } = harness();
  await controller.openThread("thread-a");
  await controller.openThread("thread-in-project", {
    context: { kind: "project", projectId: "project-1" },
  });
  // Then back to the default workspace by hand — that is now the place to return to.
  await controller.switchContext({ kind: "sessions" });

  await openTasksDestination(controller);
  await openSessionsDestination(controller);

  assert.deepEqual(location(store).context, { kind: "sessions" });
  assert.equal(location(store).threadId, "thread-a");
});

test("Tasks is never itself the place Sessions returns to", async () => {
  const { store, controller } = harness();
  await controller.openThread("thread-a");

  // Two hops within Tasks (list -> a task) must not overwrite the memory with a
  // tasks context, which can hold no tabs and would strand the Sessions button.
  await openTasksDestination(controller);
  await controller.showOverview({ kind: "tasks", teamRunId: "run-7" });
  await openSessionsDestination(controller);

  assert.deepEqual(location(store).context, { kind: "sessions" });
  assert.equal(location(store).threadId, "thread-a");
});

test("a project deleted while you were on Tasks does not strand the Sessions button", async () => {
  // Deleted here or by a remote peer, while the Task screen was up. The existing
  // stale-selection sweep cannot help: it returns early unless the CURRENT context is
  // the dead project, and while Tasks is showing it never is.
  const { store, controller } = persistedHarness({ projectIds: [] });
  await controller.openThread("thread-in-project", {
    context: { kind: "project", projectId: "project-1" },
  });
  await openTasksDestination(controller);

  await openSessionsDestination(controller);

  assert.deepEqual(
    location(store).context,
    { kind: "sessions" },
    "falls back to the default workspace rather than a project that is gone"
  );
});

// ---- the configuration the app actually ships in ---------------------------------

test("[persisted] a project survives the trip through Tasks", async () => {
  const project = { kind: "project", projectId: "project-1" };
  const { store, controller } = persistedHarness({ projectIds: ["project-1"] });
  await controller.openThread("thread-in-project", { context: project });

  await openTasksDestination(controller);
  await openSessionsDestination(controller);

  assert.deepEqual(location(store).context, project);
  assert.equal(location(store).threadId, "thread-in-project");
});

test("[persisted] a project survives Tasks list -> task detail -> Sessions", async () => {
  const project = { kind: "project", projectId: "project-1" };
  const { store, controller } = persistedHarness({ projectIds: ["project-1"] });
  await controller.openThread("thread-in-project", { context: project });

  await openTasksDestination(controller);
  // Every extra hop is another persisted rebuild, and each one is a chance to drop
  // the memory. Opening a task is the ordinary thing to do once you are on Tasks.
  await controller.showOverview({ kind: "tasks", teamRunId: "run-7" });
  await openSessionsDestination(controller);

  assert.deepEqual(location(store).context, project, "the project is still remembered");
  assert.equal(location(store).threadId, "thread-in-project");
});

test("[persisted] Back/Forward while on Tasks does not erase the remembered project", async () => {
  const project = { kind: "project", projectId: "project-1" };
  const { store, controller } = persistedHarness({ projectIds: ["project-1"] });
  await controller.openThread("thread-in-project", { context: project });
  await openTasksDestination(controller);

  // The history restore that Back/Forward and the projects reconciliation both send.
  await controller.restoreHistory(
    { version: 1, context: { kind: "tasks", teamRunId: null } },
    null
  );
  await openSessionsDestination(controller);

  assert.deepEqual(location(store).context, project);
  assert.equal(location(store).threadId, "thread-in-project");
});

test("[persisted] an unloaded project catalogue is not evidence of deletion", async () => {
  const project = { kind: "project", projectId: "project-1" };
  // `null` is app.js's "the Projects payload has not arrived yet" signal. Treating the
  // resulting empty list as authoritative would discard a perfectly live project.
  const { store, controller } = persistedHarness({ projectIds: null });
  await controller.openThread("thread-in-project", { context: project });

  await openTasksDestination(controller);
  await openSessionsDestination(controller);

  assert.deepEqual(location(store).context, project, "kept while the catalogue is unknown");
});

test("[persisted] a genuinely deleted project still falls back once the catalogue is known", async () => {
  const project = { kind: "project", projectId: "project-1" };
  const { store, controller } = persistedHarness({ projectIds: ["project-2"] });
  await controller.openThread("thread-in-project", { context: project });

  await openTasksDestination(controller);
  await openSessionsDestination(controller);

  assert.deepEqual(location(store).context, { kind: "sessions" });
});

test("[persisted] Sessions resolves against the newest selection, not a stale read", async () => {
  const { store, controller } = persistedHarness({
    projectIds: ["project-a", "project-b"],
  });
  await controller.openThread("thread-a", {
    context: { kind: "project", projectId: "project-a" },
  });
  await controller.openThread("thread-b", {
    context: { kind: "project", projectId: "project-b" },
  });
  await openTasksDestination(controller);

  // Remembered: project-b. Select A and click Sessions in the same tick — A's persisted
  // transaction cannot have settled yet, which is the ordinary case for a fast click,
  // not a contrived one.
  const selecting = controller.switchContext({ kind: "project", projectId: "project-a" });
  const returning = openSessionsDestination(controller);
  await Promise.all([selecting, returning]);

  // Reading the remembered context OUTSIDE the controller queue captures whatever was
  // there before `project-a` committed — so Sessions would sail past the newer
  // selection and land on project-b.
  assert.deepEqual(location(store).context, { kind: "project", projectId: "project-a" });
  assert.equal(location(store).threadId, "thread-a");
});

test("[persisted] one unrelated deleted session does not erase the remembered project", async () => {
  const project = { kind: "project", projectId: "project-1" };
  // A single tombstone for a session that is not open anywhere. The sweep that runs
  // before every action still rebuilds state for it, and a rebuild that forgets the
  // memory is indistinguishable from never having had one.
  const { store, controller } = persistedHarness({
    projectIds: ["project-1"],
    unavailableThreadIds: ["some-old-deleted-thread"],
  });
  await controller.openThread("thread-in-project", { context: project });

  await openTasksDestination(controller);
  await openSessionsDestination(controller);

  assert.deepEqual(location(store).context, project);
  assert.equal(location(store).threadId, "thread-in-project");
});

test("[persisted] a tombstone for a thread open in ANOTHER workspace still preserves the project", async () => {
  const project = { kind: "project", projectId: "project-1" };
  const { store, controller } = persistedHarness({
    projectIds: ["project-1"],
    unavailableThreadIds: ["doomed-thread"],
  });
  // Open the doomed thread in the default workspace first, so the sweep has real work
  // to do — it closes a tab and rewrites that workspace, not just no-ops.
  await controller.openThread("doomed-thread", { context: { kind: "sessions" } });
  await controller.openThread("thread-in-project", { context: project });

  await openTasksDestination(controller);
  await openSessionsDestination(controller);

  assert.deepEqual(location(store).context, project);
  assert.equal(location(store).threadId, "thread-in-project");
});

test("[persisted] many tombstones do not erase the remembered project", async () => {
  const project = { kind: "project", projectId: "project-1" };
  const { store, controller } = persistedHarness({
    projectIds: ["project-1"],
    unavailableThreadIds: ["gone-1", "gone-2", "gone-3"],
  });
  await controller.openThread("thread-in-project", { context: project });

  await openTasksDestination(controller);
  await controller.showOverview({ kind: "tasks", teamRunId: "run-7" });
  await openSessionsDestination(controller);

  assert.deepEqual(location(store).context, project);
  assert.equal(location(store).threadId, "thread-in-project");
});

test("Sessions is a no-op you can repeat without losing the session", async () => {
  const { store, controller } = harness();
  await controller.openThread("thread-a");

  await openSessionsDestination(controller);
  await openSessionsDestination(controller);

  // Clicking the destination you are already on must not blank the pane either —
  // that was the same defect reachable without ever visiting Tasks.
  assert.equal(location(store).threadId, "thread-a");
});
