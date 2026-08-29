import assert from "node:assert/strict";
import test from "node:test";

import {
  createTabWorkspace,
  layoutThreadIds,
  openThreadTab,
  tabIdForThread,
} from "./tab-layout.js";
import { SESSIONS_KEY } from "./tab-workspace-store.js";
import { selectContextAfterProjectDelete } from "./session-view-state.js";
import {
  createBrowserSessionViewHistoryAdapter,
  createSessionViewController,
  createSessionViewStore,
} from "./session-view-controller.js";

const sessions = () => ({ kind: "sessions" });
const project = (projectId) => ({ kind: "project", projectId });

function threadIds(workspace) {
  return (workspace?.tabs || []).flatMap((tab) => layoutThreadIds(tab.layout));
}

function fakePersistence(initial = {}, { fail = false } = {}) {
  const values = new Map(
    Object.entries(initial).map(([key, workspace]) => [
      key,
      createTabWorkspace(workspace),
    ])
  );
  const loads = [];
  const saves = [];
  const deletes = [];
  let queue = Promise.resolve();
  let shouldFail = fail;
  const persistence = {
    loads,
    saves,
    deletes,
    values,
    setFail(value) {
      shouldFail = Boolean(value);
    },
    transact(operation) {
      const run = () => {
        const snapshot = Object.fromEntries(
          [...values.entries()].map(([key, workspace]) => [
            key,
            createTabWorkspace(workspace),
          ])
        );
        loads.push(...Object.keys(snapshot));
        const plan = operation(snapshot);
        if (shouldFail) {
          throw new Error("transaction failed");
        }
        for (const key of new Set(plan?.deletes || [])) {
          deletes.push(key);
          values.delete(key);
        }
        for (const [key, workspace] of Object.entries(plan?.writes || {})) {
          const normalized = createTabWorkspace(workspace);
          saves.push({ key, workspace: normalized });
          values.set(key, normalized);
        }
        return plan?.value;
      };
      const result = queue.then(run, run);
      queue = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  };
  return persistence;
}

test("the store hydrates a target context before reducing and persists only changed tab sets", async () => {
  const persistence = fakePersistence({
    "project-1": openThreadTab(createTabWorkspace(), "persisted-project-thread"),
  });
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence,
  });

  const switched = await store.dispatch({
    type: "SWITCH_CONTEXT",
    context: project("project-1"),
  });
  assert.equal(switched.next.location.threadId, "persisted-project-thread");
  assert.deepEqual(
    new Set(persistence.loads),
    new Set(["project-1"])
  );
  assert.deepEqual(persistence.saves, [], "hydration and focus restoration do not rewrite storage");

  const opened = await store.dispatch({
    type: "OPEN_THREAD",
    threadId: "new-project-thread",
  });
  assert.deepEqual(threadIds(opened.next.workspaces["project-1"]), [
    "persisted-project-thread",
    "new-project-thread",
  ]);
  assert.deepEqual(
    persistence.saves.map((entry) => entry.key),
    ["project-1"],
    "only the mutated project tab set is persisted"
  );
});

test("global removal hydrates cold persisted tab sets before sweeping them", async () => {
  const persistence = fakePersistence({
    "project-1": openThreadTab(createTabWorkspace(), "removed-thread"),
    "project-2": openThreadTab(createTabWorkspace(), "removed-thread"),
  });
  const store = createSessionViewStore({
    initialLocation: {
      context: sessions(),
      threadId: "removed-thread",
    },
    persistence,
  });

  const result = await store.dispatch({
    type: "REMOVE_THREAD",
    threadId: "removed-thread",
  });

  assert.equal(result.next.location.threadId, null);
  assert.deepEqual(threadIds(result.next.workspaces["project-1"]), []);
  assert.deepEqual(threadIds(result.next.workspaces["project-2"]), []);
  assert.deepEqual(
    new Set(persistence.loads),
    new Set(["project-1", "project-2"])
  );
  assert.deepEqual(
    new Set(persistence.saves.map((entry) => entry.key)),
    new Set(["project-1", "project-2"])
  );
});

test("overlapping stores sharing one transaction preserve both windows' tabs", async () => {
  const persistence = fakePersistence();
  const storeA = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence,
  });
  const storeB = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence,
  });
  const controllerA = createSessionViewController({ store: storeA });
  const controllerB = createSessionViewController({ store: storeB });

  // Start both before either transaction callback runs. The persistence boundary,
  // rather than call ordering in this test, must serialize their read/modify/write.
  await Promise.all([
    controllerA.openThread("window-a"),
    controllerB.openThread("window-b"),
  ]);

  assert.deepEqual(threadIds(persistence.values.get(SESSIONS_KEY)), [
    "window-a",
    "window-b",
  ]);
  assert.deepEqual(threadIds(storeB.getState().workspaces[SESSIONS_KEY]), [
    "window-a",
    "window-b",
  ]);
});

test("failed transactions retain every later in-memory tab edit and replay on recovery", async () => {
  const persistence = fakePersistence({}, { fail: true });
  const errors = [];
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence,
    onError(error) {
      errors.push(error.message);
    },
  });
  const controller = createSessionViewController({ store });

  await controller.openThread("a");
  await controller.openThread("b");
  await controller.openThread("c");
  await controller.pinTab(tabIdForThread("b"), true);
  await controller.moveTab(tabIdForThread("c"), 1);

  let workspace = store.getState().workspaces[SESSIONS_KEY];
  assert.deepEqual(threadIds(workspace), ["b", "c", "a"]);
  assert.equal(workspace.tabs[0].pinned, true);
  assert.equal(workspace.focusedTabId, tabIdForThread("c"));
  assert.equal(persistence.values.size, 0);
  assert.equal(errors.length, 5);

  // Simulate a remote window committing while this window is dirty. Recovery must
  // rebase the local journal onto that fresh shared state, preserving both sides.
  persistence.values.set(
    SESSIONS_KEY,
    openThreadTab(createTabWorkspace(), "remote")
  );
  persistence.setFail(false);
  await controller.openThread("d");

  workspace = store.getState().workspaces[SESSIONS_KEY];
  assert.deepEqual(threadIds(workspace), ["b", "c", "remote", "a", "d"]);
  assert.equal(workspace.tabs[0].pinned, true);
  assert.equal(workspace.focusedTabId, tabIdForThread("d"));
  assert.deepEqual(
    threadIds(persistence.values.get(SESSIONS_KEY)),
    ["b", "c", "remote", "a", "d"]
  );
});

test("the controller store rejects a non-transactional persistence adapter", () => {
  assert.throws(
    () =>
      createSessionViewStore({
        persistence: {
          load() {},
          save() {},
        },
      }),
    /atomic transact/
  );
});

test("history recovery drops a now-deleted project reintroduced by the dirty journal", async () => {
  const persistence = fakePersistence({}, { fail: true });
  let projectIds = ["deleted-project"];
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence,
  });
  const controller = createSessionViewController({
    store,
    getProjectIds: () => projectIds,
  });

  await controller.switchContext(project("deleted-project"));
  await controller.openThread("stale-thread");
  assert.deepEqual(
    threadIds(store.getState().workspaces["deleted-project"]),
    ["stale-thread"]
  );

  projectIds = [];
  persistence.setFail(false);
  await controller.restoreHistory(
    { version: 1, context: project("deleted-project") },
    null
  );

  assert.deepEqual(store.getState().location, {
    context: { kind: "sessions" },
    threadId: null,
  });
  assert.equal(store.getState().workspaces["deleted-project"], undefined);
  assert.equal(persistence.values.get("deleted-project"), undefined);
});

test("a failed history cleanup remains durable when a normal command recovers persistence", async () => {
  const persistence = fakePersistence(
    {
      "deleted-project": openThreadTab(
        createTabWorkspace(),
        "stale-thread"
      ),
    },
    { fail: true }
  );
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence,
  });
  const controller = createSessionViewController({
    store,
    getProjectIds: () => [],
  });

  await controller.restoreHistory(
    { version: 1, context: project("deleted-project") },
    "stale-thread"
  );
  assert.equal(store.getState().workspaces["deleted-project"], undefined);
  assert.ok(
    persistence.values.has("deleted-project"),
    "the failed transaction has not cleaned storage yet"
  );

  persistence.setFail(false);
  await controller.openThread("next");

  assert.equal(store.getState().workspaces["deleted-project"], undefined);
  assert.equal(persistence.values.has("deleted-project"), false);
  assert.deepEqual(persistence.deletes, ["deleted-project"]);
  assert.equal(store.getState().location.threadId, "next");
});

test("the controller commits canonical state before writing one versioned history entry", async () => {
  const persistence = fakePersistence();
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence,
  });
  const historyWrites = [];
  const commits = [];
  const controller = createSessionViewController({
    store,
    historyAdapter: {
      write(payload) {
        historyWrites.push({
          ...payload,
          observedLocation: store.getState().location,
        });
      },
    },
    onCommit(change) {
      commits.push(change);
    },
  });

  const result = await controller.openThread("session-a");

  assert.deepEqual(result.next.location, {
    context: sessions(),
    threadId: "session-a",
  });
  assert.deepEqual(historyWrites, [
    {
      threadId: "session-a",
      entry: {
        version: 1,
        context: sessions(),
      },
      replace: false,
      observedLocation: {
        context: sessions(),
        threadId: "session-a",
      },
    },
  ]);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].locationChanged, true);
  assert.deepEqual(commits[0].changedWorkspaceKeys, [SESSIONS_KEY]);
});

test("listener-triggered navigation queues after state and history finish committing", async () => {
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
  });
  const historyThreads = [];
  const controller = createSessionViewController({
    store,
    historyAdapter: {
      write({ threadId }) {
        historyThreads.push(threadId);
      },
    },
  });
  controller.subscribe((change) => {
    if (change.next.location.threadId === "a") {
      void controller.openThread("b");
    }
  });

  await controller.openThread("a");
  await controller.whenIdle();

  assert.equal(store.getState().location.threadId, "b");
  assert.deepEqual(historyThreads, ["a", "b"]);
});

test("history restoration captures fresh facts and replaces a tombstoned route", async () => {
  const removed = new Set(["deleted-thread"]);
  const store = createSessionViewStore({
    initialLocation: {
      context: project("project-1"),
      threadId: "project-fallback",
    },
  });
  const historyWrites = [];
  const controller = createSessionViewController({
    store,
    historyAdapter: {
      write(payload) {
        historyWrites.push(payload);
      },
    },
    getProjectIds: () => ["project-1"],
    getUnavailableThreadIds: () => removed,
  });

  const result = await controller.restoreHistory(
    {
      version: 1,
      context: project("project-1"),
    },
    "deleted-thread"
  );

  assert.equal(result.next.location.threadId, "project-fallback");
  assert.deepEqual(historyWrites, [
    {
      threadId: "project-fallback",
      entry: {
        version: 1,
        context: project("project-1"),
      },
      replace: true,
    },
  ]);
});

test("history restoration sweeps tombstones from every valid cold persisted workspace", async () => {
  let projectOne = openThreadTab(createTabWorkspace(), "project-fallback");
  projectOne = openThreadTab(projectOne, "deleted-thread");
  const persistence = fakePersistence({
    "project-1": projectOne,
    "project-2": openThreadTab(createTabWorkspace(), "deleted-thread"),
  });
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence,
  });
  const controller = createSessionViewController({
    store,
    getProjectIds: () => ["project-1", "project-2"],
    getUnavailableThreadIds: () => ["deleted-thread"],
  });

  const result = await controller.restoreHistory(
    {
      version: 1,
      context: project("project-1"),
    },
    "deleted-thread"
  );

  assert.equal(result.next.location.threadId, "project-fallback");
  assert.deepEqual(threadIds(persistence.values.get("project-1")), [
    "project-fallback",
  ]);
  assert.deepEqual(threadIds(persistence.values.get("project-2")), []);
});

test("restoring a deleted project never hydrates that cold persisted tab set", async () => {
  const persistence = fakePersistence({
    "deleted-project": openThreadTab(createTabWorkspace(), "stale-thread"),
  });
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence,
  });
  const controller = createSessionViewController({
    store,
    getProjectIds: () => ["live-project"],
  });

  const result = await controller.restoreHistory(
    {
      version: 1,
      context: project("deleted-project"),
    },
    null
  );

  assert.deepEqual(result.next.location, {
    context: { kind: "sessions" },
    threadId: null,
  });
  assert.equal(result.next.workspaces["deleted-project"], undefined);
  assert.equal(persistence.values.get("deleted-project"), undefined);
  assert.deepEqual(persistence.deletes, ["deleted-project"]);
});

test("an unloaded project catalog preserves history context and persisted buckets", async () => {
  const persistence = fakePersistence({
    "project-loading": openThreadTab(
      createTabWorkspace(),
      "project-session"
    ),
  });
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence,
  });
  const controller = createSessionViewController({
    store,
    getProjectIds: () => null,
  });

  const result = await controller.restoreHistory(
    {
      version: 1,
      context: project("project-loading"),
    },
    "project-session"
  );

  assert.deepEqual(result.next.location, {
    context: project("project-loading"),
    threadId: "project-session",
  });
  assert.deepEqual(
    threadIds(persistence.values.get("project-loading")),
    ["project-session"]
  );
  assert.deepEqual(persistence.deletes, []);
});

test("pin and move persist tab state without creating browser history", async () => {
  const persistence = fakePersistence();
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence,
  });
  const historyWrites = [];
  const controller = createSessionViewController({
    store,
    historyAdapter: {
      write(payload) {
        historyWrites.push(payload);
      },
    },
  });

  await controller.openThread("a");
  await controller.openThread("b");
  historyWrites.length = 0;
  persistence.saves.length = 0;

  await controller.pinTab(tabIdForThread("b"), true);
  await controller.moveTab(tabIdForThread("a"), 0);

  const workspace = store.getState().workspaces[SESSIONS_KEY];
  assert.equal(workspace.tabs[0].id, tabIdForThread("b"));
  assert.equal(workspace.tabs[0].pinned, true);
  assert.deepEqual(historyWrites, []);
  assert.deepEqual(
    persistence.saves.map((entry) => entry.key),
    [SESSIONS_KEY],
    "the invalid cross-partition move is a no-op and is not persisted"
  );
});

test("valid moves and background-context pin/move preserve the visible project", async () => {
  const persistence = fakePersistence();
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence,
  });
  const historyWrites = [];
  const controller = createSessionViewController({
    store,
    historyAdapter: {
      write(payload) {
        historyWrites.push(payload);
      },
    },
  });
  for (const threadId of ["a", "b", "c"]) {
    await controller.openThread(threadId);
  }
  await controller.moveTab(tabIdForThread("c"), 0);
  assert.deepEqual(threadIds(store.getState().workspaces[SESSIONS_KEY]), [
    "c",
    "a",
    "b",
  ]);

  await controller.switchContext(project("project-1"));
  await controller.openThread("project-visible");
  const historyCount = historyWrites.length;
  await controller.pinTab(tabIdForThread("a"), true, {
    context: sessions(),
  });
  await controller.moveTab(tabIdForThread("b"), 1, {
    context: sessions(),
  });

  assert.deepEqual(store.getState().location, {
    context: project("project-1"),
    threadId: "project-visible",
  });
  const sessionsWorkspace = store.getState().workspaces[SESSIONS_KEY];
  assert.equal(sessionsWorkspace.tabs[0].id, tabIdForThread("a"));
  assert.equal(sessionsWorkspace.tabs[0].pinned, true);
  assert.deepEqual(threadIds(sessionsWorkspace), ["a", "b", "c"]);
  assert.equal(historyWrites.length, historyCount);
});

test("persistence and history failures do not roll back the canonical transition", async () => {
  const errors = [];
  const persistence = fakePersistence({}, { fail: true });
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence,
    onError(error) {
      errors.push(error.message);
    },
  });
  const controller = createSessionViewController({
    store,
    historyAdapter: {
      write() {
        throw new Error("history failed");
      },
    },
    onError(error) {
      errors.push(error.message);
    },
  });

  await controller.openThread("still-visible");

  assert.equal(store.getState().location.threadId, "still-visible");
  assert.deepEqual(errors, [
    "transaction failed",
    "history failed",
  ]);
});

test("the browser adapter owns URL serialization without duplicating the thread in history state", () => {
  const writes = [];
  const browserWindow = {
    location: {
      href: "http://127.0.0.1:9000/local?keep=yes#composer",
    },
    history: {
      state: null,
      pushState(entry, _unused, next) {
        this.state = entry;
        writes.push({ method: "push", entry, next });
        browserWindow.location.href = `http://127.0.0.1:9000${next}`;
      },
      replaceState(entry, _unused, next) {
        this.state = entry;
        writes.push({ method: "replace", entry, next });
        browserWindow.location.href = `http://127.0.0.1:9000${next}`;
      },
    },
  };
  const adapter = createBrowserSessionViewHistoryAdapter(browserWindow);
  const entry = { version: 1, context: sessions() };

  adapter.write({ threadId: "session-a", entry, replace: false });
  assert.deepEqual(writes, [
    {
      method: "push",
      entry,
      next: "/local?keep=yes&thread=session-a#composer",
    },
  ]);
  assert.deepEqual(adapter.read(), {
    entry,
    threadId: "session-a",
  });

  adapter.write({ threadId: null, entry, replace: true });
  assert.deepEqual(writes[1], {
    method: "replace",
    entry,
    next: "/local?keep=yes#composer",
  });
});

// ── Preview tabs ────────────────────────────────────────────────────────────

test("previewing browses without pushing history, and promotion persists silently", async () => {
  const persistence = fakePersistence();
  const entries = [];
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence,
  });
  const controller = createSessionViewController({
    store,
    historyAdapter: {
      write(entry) {
        entries.push(entry);
      },
    },
  });

  await controller.openThread("a", { preview: true });
  await controller.openThread("b", { preview: true });
  assert.deepEqual(
    threadIds(store.getState().workspaces[SESSIONS_KEY]),
    ["b"],
    "browsing reuses the one preview tab"
  );
  // Peeking is still navigation: each peek is a place you can go back from.
  assert.deepEqual(entries.map((entry) => entry.threadId), ["a", "b"]);

  const promoted = await controller.promoteThread("b");
  assert.equal(
    promoted.next.workspaces[SESSIONS_KEY].tabs[0].preview,
    false
  );
  assert.equal(entries.length, 2, "promotion is not a navigation — no history entry");
  assert.deepEqual(
    promoted.changedWorkspaceKeys,
    [SESSIONS_KEY],
    "promotion is a real change, so it reaches persistence"
  );
  assert.equal(
    persistence.values.get(SESSIONS_KEY).tabs[0].preview,
    false,
    "the kept tab survives a reload"
  );

  await controller.openThread("c", { preview: true });
  assert.deepEqual(threadIds(store.getState().workspaces[SESSIONS_KEY]), ["b", "c"]);
});

test("promotion targets the tab's own context, not whatever is selected now", async () => {
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
  });
  const controller = createSessionViewController({ store });

  await controller.openThread("a", { context: project("p1"), preview: true });
  await controller.switchContext(sessions());
  await controller.promoteTab(tabIdForThread("a"), { context: project("p1") });

  assert.equal(store.getState().workspaces.p1.tabs[0].preview, false);
});

test("back through a browse peeks; boot restores a kept tab", async () => {
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
  });
  const controller = createSessionViewController({ store });

  await controller.openThread("a", { preview: true });
  await controller.openThread("b", { preview: true });

  // Back/Forward — the browser replaying peeks the user already made.
  await controller.restoreHistory({ version: 1, context: sessions() }, "a", { preview: true });
  assert.deepEqual(
    threadIds(store.getState().workspaces[SESSIONS_KEY]),
    ["a"],
    "back reuses the preview slot instead of stacking"
  );

  // Boot / a shared link — a session named on purpose, so it is kept.
  await controller.restoreHistory({ version: 1, context: sessions() }, "c");
  const tabs = store.getState().workspaces[SESSIONS_KEY].tabs;
  assert.deepEqual(tabs.map((tab) => tab.preview), [true, false]);
  assert.deepEqual(threadIds(store.getState().workspaces[SESSIONS_KEY]), ["a", "c"]);
});

// The boot path that actually runs in a browser: workspaces arrive by HYDRATION
// inside the transaction, not from an in-memory store, so a persisted preview tab
// has to survive the round trip through storage and normalization before the
// restore even sees it. The empty-store version of this test could not have shown
// that.
test("booting on a persisted preview tab restores it as a peek, not a keep", async () => {
  const persistence = fakePersistence({
    [SESSIONS_KEY]: openThreadTab(createTabWorkspace(), "a", { preview: true }),
  });
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence,
  });
  const controller = createSessionViewController({ store });

  // Reload on ?thread=a — no intent, exactly what app.js's boot call does.
  await controller.restoreHistory({ version: 1, context: sessions() }, "a");
  const restored = store.getState().workspaces[SESSIONS_KEY];
  assert.deepEqual(threadIds(restored), ["a"]);
  assert.equal(
    restored.tabs[0].preview,
    true,
    "a refresh is not a gesture: it must neither keep nor discard the peek"
  );

  // And it is still the slot the next peek takes.
  await controller.openThread("b", { preview: true });
  assert.deepEqual(threadIds(store.getState().workspaces[SESSIONS_KEY]), ["b"]);
});

// --- reconciliation must not read a context the user has already left -------

// `performDispatch` assigns `state` only AFTER its persistence transaction resolves,
// so between clicking a project and that transaction landing, `getState()` still
// reports the previous context. Anything that reconciles against "where am I" — the
// project-delete handler, the stale-selection sweep — would decide on the stale answer
// and then queue its own navigation BEHIND the user's, overwriting it.
//
// The browser test for this cannot reach the window: it has to wait for the new
// project's header before releasing the delete, which means waiting for exactly the
// commit that closes the gap. Dropping the `whenIdle()` drain leaves that e2e green.
// This is where the ordering is observable.
test("a switch that is still persisting reports as the OLD context until it commits", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const inner = fakePersistence();
  const persistence = {
    ...inner,
    async transact(operation) {
      await gate;
      return inner.transact(operation);
    },
  };
  const store = createSessionViewStore({
    initialLocation: { context: project("project-a"), threadId: null },
    persistence,
  });
  const controller = createSessionViewController({
    store,
    getProjectIds: () => ["project-a", "project-b"],
  });

  // The user clicks project B. Do not await it — this is the pending window.
  const switching = controller.switchContext(project("project-b"));
  // Let the dispatch actually BEGIN before reading. Reading in the same synchronous
  // turn observes a state nothing has touched yet, which passes whether or not the
  // controller assigns eagerly — the read has to happen while the transaction is in
  // flight, which is the window the bug lives in.
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(
    controller.getState().location.context,
    project("project-a"),
    "precondition: the pending switch is invisible to getState()"
  );

  // What a reconciliation deciding on that stale read would conclude: project A is the
  // one being deleted, it looks like the current context, so navigate away — straight
  // over the top of the switch the user just made.
  assert.deepEqual(
    selectContextAfterProjectDelete({
      context: controller.getState().location.context,
      deletedProjectId: "project-a",
    }),
    sessions(),
    "reading without draining decides to navigate, which would overwrite the user"
  );

  release();
  await switching;
  await controller.whenIdle();

  assert.deepEqual(
    controller.getState().location.context,
    project("project-b"),
    "after the drain the committed context is the one the user chose"
  );
  assert.equal(
    selectContextAfterProjectDelete({
      context: controller.getState().location.context,
      deletedProjectId: "project-a",
    }),
    null,
    "and the same decision now leaves them where they went"
  );
});

// The loop in `whenIdle` is load-bearing: a dispatch that arrives while it is already
// waiting must be waited for too, or draining just moves the window rather than
// closing it.
test("whenIdle keeps waiting for work queued while it is already waiting", async () => {
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence: fakePersistence(),
  });
  const controller = createSessionViewController({
    store,
    getProjectIds: () => ["project-a", "project-b"],
  });

  const first = controller.switchContext(project("project-a"));
  const idle = controller.whenIdle();
  const second = controller.switchContext(project("project-b"));

  // Assert straight off `idle`, WITHOUT awaiting `second`. Awaiting it first would
  // make this pass against a `whenIdle` that returns after a single queue tick, which
  // is precisely the version that leaves the window open.
  await idle;
  assert.deepEqual(
    controller.getState().location.context,
    project("project-b"),
    "whenIdle resolved no earlier than the dispatch queued while it was waiting"
  );
  await Promise.all([first, second]);
});

test("restoring history keeps a Task screen workspace that no project list can vouch for", async () => {
  // `validHistoryWorkspaces` is an ALLOWLIST, and its output is diffed against
  // what is on disk — every key it omits becomes a delete. A project id can be
  // vouched for by `getProjectIds`; a task key cannot, because the controller has
  // no equivalent fact. Recognising it by shape is what stops every restore from
  // silently dropping the Task screen's stored state.
  const persistence = fakePersistence({
    "__tasks__:team-1": openThreadTab(createTabWorkspace(), "kept-thread"),
    "deleted-project": openThreadTab(createTabWorkspace(), "stale-thread"),
  });
  const store = createSessionViewStore({
    initialLocation: { context: sessions(), threadId: null },
    persistence,
  });
  const controller = createSessionViewController({
    store,
    getProjectIds: () => [],
  });

  await controller.restoreHistory({ version: 1, context: sessions() }, null);

  assert.deepEqual(
    persistence.deletes,
    ["deleted-project"],
    "a project the list disowns is still collected"
  );
  assert.ok(
    persistence.values.has("__tasks__:team-1"),
    "a task workspace must survive a restore it cannot be vouched for"
  );
  assert.ok(store.getState().workspaces["__tasks__:team-1"]);
});
