import test from "node:test";
import assert from "node:assert/strict";

// `state.js` (reached via client-log.js) touches localStorage at import time.
globalThis.window = {
  localStorage: {
    getItem() {
      return null;
    },
    removeItem() {},
    setItem() {},
  },
  matchMedia() {
    return { matches: false, addEventListener() {}, removeEventListener() {} };
  },
};
globalThis.document = { body: { dataset: {} }, querySelector: () => null };

const {
  UNPAIRED_RELAY_SCOPE,
  createRemoteSessionTabsHost,
  getRemoteSessionTabsHost,
  remoteSessionViewContext,
  resetRemoteSessionTabsHost,
  sessionViewDbNameForRelay,
} = await import("./session-tabs-host.js");
const { sessionViewContextKey } = await import("../shared/session-view-state.js");
const { layoutThreadIds } = await import("../shared/tab-layout.js");
const { SESSIONS_KEY } = await import("../shared/tab-workspace-store.js");

// An IndexedDB that records the database names asked for and then refuses. Refusing is
// enough: every assertion here is about which database a host reaches for, and the
// adapter's transaction behaviour already has its own tests.
function recordingIndexedDb() {
  const opened = [];
  return {
    opened,
    open(name) {
      opened.push(name);
      const request = { result: null, error: new Error("refused"), onsuccess: null, onerror: null };
      queueMicrotask(() => request.onerror?.());
      return request;
    },
  };
}

function projectsStore(state) {
  return { getState: () => state };
}

test("no project selected keys the same workspace local calls Sessions", () => {
  assert.equal(sessionViewContextKey(remoteSessionViewContext(null)), SESSIONS_KEY);
  assert.equal(sessionViewContextKey(remoteSessionViewContext("")), SESSIONS_KEY);
  assert.equal(sessionViewContextKey(remoteSessionViewContext(undefined)), SESSIONS_KEY);
});

test("a selected project keys its own workspace", () => {
  const context = remoteSessionViewContext("project-a");
  assert.deepEqual(context, { kind: "project", projectId: "project-a" });
  assert.equal(sessionViewContextKey(context), "project-a");
  assert.notEqual(
    sessionViewContextKey(remoteSessionViewContext("project-b")),
    sessionViewContextKey(context)
  );
});

// The core relay-scoping property. Thread and project ids are unique only within one
// relay, so two relays must never read each other's workspaces.
test("each relay gets its own database, and unpaired gets its own too", () => {
  assert.equal(sessionViewDbNameForRelay("relay-a"), "sealwire-session-view-remote-relay-a");
  assert.notEqual(sessionViewDbNameForRelay("relay-a"), sessionViewDbNameForRelay("relay-b"));
  assert.equal(
    sessionViewDbNameForRelay(null),
    `sealwire-session-view-remote-${UNPAIRED_RELAY_SCOPE}`
  );
  assert.equal(sessionViewDbNameForRelay(""), sessionViewDbNameForRelay(null));
  // And never the local surface's database.
  for (const relayId of ["relay-a", null, ""]) {
    assert.notEqual(sessionViewDbNameForRelay(relayId), "sealwire-session-view");
  }
});

test("the host opens the database its relay names", async () => {
  const indexedDb = recordingIndexedDb();
  const host = createRemoteSessionTabsHost({
    relayId: "relay-a",
    indexedDb,
    projectsStore: projectsStore({ loaded: true, projects: [] }),
    log() {},
  });

  await host.controller.openThread("thread-1").catch(() => {});

  assert.deepEqual(indexedDb.opened, ["sealwire-session-view-remote-relay-a"]);
});

// `null` means "not authoritative yet". Returning `[]` while the broker fetch is still
// in flight would look like "every project was deleted" and sweep the cold tab sets —
// a wider window on remote than on local, because Projects arrive over the broker.
test("an unloaded projects payload is reported as not-yet-authoritative", async () => {
  const state = { loaded: false, projects: [] };
  const host = createRemoteSessionTabsHost({
    relayId: "relay-a",
    indexedDb: recordingIndexedDb(),
    projectsStore: projectsStore(state),
    log() {},
  });

  // Reach the seam the controller samples on every command.
  const facts = [];
  const original = host.store.dispatch;
  host.store.dispatch = (action, sampled) => {
    facts.push(sampled);
    return original(action, sampled);
  };

  await host.controller.openThread("thread-1").catch(() => {});
  assert.equal(facts.at(-1).projectIdsComplete, false);

  state.loaded = true;
  state.projects = [{ id: "project-a" }];
  await host.controller.openThread("thread-2").catch(() => {});
  assert.equal(facts.at(-1).projectIdsComplete, true);
  assert.deepEqual(facts.at(-1).projectIds, ["project-a"]);
});

test("the cached host is reused per relay and rebuilt on a switch", () => {
  resetRemoteSessionTabsHost();
  const first = getRemoteSessionTabsHost("relay-a");
  assert.equal(getRemoteSessionTabsHost("relay-a"), first, "same relay must not rebuild");

  const second = getRemoteSessionTabsHost("relay-b");
  assert.notEqual(second, first);

  resetRemoteSessionTabsHost();
  assert.notEqual(getRemoteSessionTabsHost("relay-a"), first);
});

test("an unpaired surface shares no host with a real relay", () => {
  resetRemoteSessionTabsHost();
  const unpaired = getRemoteSessionTabsHost(null);
  assert.equal(getRemoteSessionTabsHost(null), unpaired);
  assert.notEqual(getRemoteSessionTabsHost("relay-a"), unpaired);
});

// F6's invariant. The host must be built ONCE per relay: a rebuild abandons whatever
// transaction the previous controller had in flight and comes back with an empty
// snapshot, which reads as the strip flashing empty just after boot.
test("re-reading the host never rebuilds it for the same relay", async () => {
  resetRemoteSessionTabsHost();
  const first = getRemoteSessionTabsHost("relay-a");
  await first.openThread({ threadId: "S", threadProjectId: {} });

  for (let render = 0; render < 5; render += 1) {
    assert.equal(getRemoteSessionTabsHost("relay-a"), first, `render ${render} rebuilt it`);
  }
  assert.equal(getRemoteSessionTabsHost("relay-a").controller.getState().location.threadId, "S");
});

// ...and a switch is the ONLY thing that yields a different one. Note the cache holds a
// SINGLE host, so switching evicts rather than parking: coming back builds a fresh host
// whose in-memory location is empty until `hydrate()` reads its database. That is why
// boot hydration is not optional.
test("a relay switch selects a different host that inherits nothing", async () => {
  resetRemoteSessionTabsHost();
  const a = getRemoteSessionTabsHost("relay-a");
  await a.openThread({ threadId: "S", threadProjectId: {} });

  const b = getRemoteSessionTabsHost("relay-b");
  assert.notEqual(b, a);
  assert.equal(
    b.controller.getState().location.threadId,
    null,
    "relay B must not inherit relay A's thread"
  );
});

// The storage half of the claim, which the module-level getter cannot show (it builds
// real IndexedDB adapters, and node has none — they degrade to in-memory). Two hosts on
// two stores must not see each other's tabs, and each must read its own back.
test("two relays keep separate stored tab sets, and each reads its own back", async () => {
  const storeA = memoryPersistence();
  const storeB = memoryPersistence();

  await hostWith({ relayId: "relay-a", persistence: storeA })
    .openThread({ threadId: "S", threadProjectId: {} });
  await hostWith({ relayId: "relay-b", persistence: storeB })
    .openThread({ threadId: "T", threadProjectId: {} });

  const backToA = hostWith({ relayId: "relay-a", persistence: storeA });
  await backToA.hydrate();
  assert.deepEqual(
    tabThreadIds(backToA, { kind: "sessions" }),
    ["S"],
    "relay A must find its own tabs, and only its own"
  );

  const backToB = hostWith({ relayId: "relay-b", persistence: storeB });
  await backToB.hydrate();
  assert.deepEqual(tabThreadIds(backToB, { kind: "sessions" }), ["T"]);
});

// Dropping is not clearing: the tabs of the relay being left live in that relay's own
// database, so a rebuilt host reads them back rather than starting empty. (That the
// relay-switch effect actually calls this is asserted in relay-scoped-state.test.mjs,
// which owns the wiring rule.)
test("dropping the host abandons its in-memory location, not its stored tabs", async () => {
  resetRemoteSessionTabsHost();

  const before = getRemoteSessionTabsHost("relay-a");
  await before.controller.openThread("thread-1").catch(() => {});
  assert.equal(before.controller.getState().location.threadId, "thread-1");

  resetRemoteSessionTabsHost();

  const after = getRemoteSessionTabsHost("relay-a");
  assert.notEqual(after, before, "the drop must invalidate the cached host");
  assert.equal(
    after.controller.getState().location.threadId,
    null,
    "a rebuilt host starts from its database, not the previous host's memory"
  );
});

// ---------------------------------------------------------------------------
// Regression tests for the review findings. Each one fails before its fix.
// ---------------------------------------------------------------------------

// A fake IndexedDB good enough to round-trip workspaces, so hydration and
// cross-command persistence are real rather than stubbed.
function memoryPersistence() {
  const records = new Map();
  return {
    records,
    async transact(mutate) {
      const snapshot = Object.fromEntries(records);
      const result = mutate(snapshot);
      for (const key of new Set(result?.deletes || [])) records.delete(key);
      for (const [key, workspace] of Object.entries(result?.writes || {})) {
        records.set(key, workspace);
      }
      return result?.value;
    },
  };
}

function hostWith(overrides = {}) {
  return createRemoteSessionTabsHost({
    relayId: "relay-a",
    persistence: memoryPersistence(),
    projectsStore: { getState: () => ({ loaded: true, projects: [{ id: "P" }, { id: "Q" }] }) },
    log() {},
    ...overrides,
  });
}

function tabThreadIds(host, context) {
  const ws = host.controller.getState().workspaces[sessionViewContextKey(context)];
  return (ws?.tabs || []).flatMap((tab) => layoutThreadIds(tab.layout));
}

// F1: a session must land in ITS project's tab set, not the pinned one.
test("a session opens into its OWNING project, not the selected one", async () => {
  const host = hostWith();
  await host.selectProject("P");
  // S belongs to Q; the sidebar happens to be pinned to P.
  await host.openThread({ threadId: "S", threadProjectId: { S: "Q" } });

  assert.deepEqual(tabThreadIds(host, { kind: "project", projectId: "Q" }), ["S"]);
  assert.deepEqual(tabThreadIds(host, { kind: "project", projectId: "P" }), []);
});

test("an unassigned session opens into the sessions workspace, not the pinned project", async () => {
  const host = hostWith();
  await host.selectProject("P");
  await host.openThread({ threadId: "U", threadProjectId: {} });

  assert.deepEqual(tabThreadIds(host, { kind: "sessions" }), ["U"]);
  assert.deepEqual(tabThreadIds(host, { kind: "project", projectId: "P" }), []);
});

// F4: the location must follow the selection, or the strip contradicts the screen.
test("selecting a project moves the location into that project's workspace", async () => {
  const host = hostWith();
  await host.openThread({ threadId: "T", threadProjectId: {} });
  assert.equal(host.controller.getState().location.threadId, "T");

  await host.selectProject("P");
  const location = host.controller.getState().location;
  assert.deepEqual(location.context, { kind: "project", projectId: "P" });
  assert.equal(location.threadId, null, "P has no remembered tab yet");
});

test("switching back to a project restores the tab you were on", async () => {
  const host = hostWith();
  await host.openThread({ threadId: "A", threadProjectId: { A: "P" } });
  await host.openThread({ threadId: "B", threadProjectId: {} });
  assert.deepEqual(host.controller.getState().location.context, { kind: "sessions" });

  await host.selectProject("P");
  assert.equal(host.controller.getState().location.threadId, "A");
});

// F2: a Claude pending->real promotion must REKEY the tab, not add a second one.
test("a Claude promotion rekeys the tab in place", async () => {
  const host = hostWith();
  await host.adoptViewedThread({ threadId: "claude-pending-1", threadProjectId: {} });
  assert.deepEqual(tabThreadIds(host, { kind: "sessions" }), ["claude-pending-1"]);

  await host.adoptViewedThread({
    threadId: "real-1",
    promotedFrom: "claude-pending-1",
    threadProjectId: {},
  });

  assert.deepEqual(
    tabThreadIds(host, { kind: "sessions" }),
    ["real-1"],
    "the pending tab must be rekeyed, leaving no ghost"
  );
});

test("an ordinary thread switch away from a pending id is not treated as a promotion", async () => {
  const host = hostWith();
  await host.adoptViewedThread({ threadId: "claude-pending-1", threadProjectId: {} });
  // No lineage field: another device simply moved the relay elsewhere.
  await host.adoptViewedThread({ threadId: "other", threadProjectId: {} });

  assert.deepEqual(tabThreadIds(host, { kind: "sessions" }), ["claude-pending-1", "other"]);
});

// F3: nothing else dispatches when the relay has no active thread, so the
// stored strip would stay invisible until the user happened to click.
test("hydrate() reads stored workspaces without choosing a thread", async () => {
  const persistence = memoryPersistence();
  const first = hostWith({ persistence });
  await first.openThread({ threadId: "S", threadProjectId: {} });

  const second = hostWith({ persistence });
  assert.deepEqual(tabThreadIds(second, { kind: "sessions" }), [], "not yet read");

  await second.hydrate();

  assert.deepEqual(tabThreadIds(second, { kind: "sessions" }), ["S"]);
  assert.equal(
    second.controller.getState().location.threadId,
    null,
    "hydration must not decide what is on screen"
  );
});

// N1: deleting the project you are IN must move the location out of it. Writing only the
// sidebar pin leaves the strip rendering a dead project's workspace, and every strip
// action targeting it — the two-sources-of-truth state the inversion exists to remove.
test("deleting the project you are in moves the location out of it", async () => {
  const host = hostWith();
  await host.openThread({ threadId: "A", threadProjectId: { A: "P" } });
  assert.deepEqual(host.controller.getState().location.context, { kind: "project", projectId: "P" });

  await host.forgetProject("P");

  assert.deepEqual(
    host.controller.getState().location.context,
    { kind: "sessions" },
    "the location must leave a project that no longer exists"
  );
});

// ...and deleting a DIFFERENT project must not yank you out of the one you are in.
test("deleting another project leaves the current location alone", async () => {
  const host = hostWith();
  await host.openThread({ threadId: "A", threadProjectId: { A: "P" } });

  await host.forgetProject("Q");

  assert.deepEqual(host.controller.getState().location.context, {
    kind: "project",
    projectId: "P",
  });
  assert.equal(host.controller.getState().location.threadId, "A");
});

// The queue drain matters: a project click still persisting reports the PREVIOUS context,
// so sweeping without draining would clear a selection the user just made.
test("deleting a project waits for in-flight navigation before deciding", async () => {
  const host = hostWith();
  const pending = host.openThread({ threadId: "A", threadProjectId: { A: "P" } });
  const forgotten = host.forgetProject("Q");
  await Promise.all([pending, forgotten]);

  assert.deepEqual(host.controller.getState().location.context, {
    kind: "project",
    projectId: "P",
  });
});
