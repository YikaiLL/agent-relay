import assert from "node:assert/strict";
import test from "node:test";

import { layoutThreadIds, setTabPinned, tabIdForThread } from "../shared/tab-layout.js";
import { NO_PROJECT_KEY, SESSIONS_KEY } from "../shared/tab-workspace-store.js";
import {
  createSessionViewState,
  reduceSessionView,
  sessionViewContextKey,
  sessionViewHistoryEntry,
  sessionViewInvariantErrors,
} from "./session-view-state.js";

const sessions = () => ({ kind: "sessions" });
const project = (projectId) => ({ kind: "project", projectId });
const projectsHome = () => ({ kind: "projects-home" });

function transition(state, action, facts = {}) {
  const next = reduceSessionView(state, action, facts);
  assert.deepEqual(
    sessionViewInvariantErrors(next),
    [],
    `invariant failed after ${action.type}`
  );
  return next;
}

function workspaceThreadIds(state, key) {
  return (state.workspaces[key]?.tabs || []).flatMap((tab) => layoutThreadIds(tab.layout));
}

test("opening and switching contexts keep one canonical visible location", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "session-a" });
  state = transition(state, { type: "OPEN_THREAD", threadId: "session-b" });

  assert.deepEqual(state.location, {
    context: sessions(),
    threadId: "session-b",
  });
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["session-a", "session-b"]);

  state = transition(state, {
    type: "SWITCH_CONTEXT",
    context: project("project-1"),
  });
  assert.deepEqual(state.location, {
    context: project("project-1"),
    threadId: null,
  });
  assert.deepEqual(workspaceThreadIds(state, "project-1"), []);

  state = transition(state, { type: "OPEN_THREAD", threadId: "project-session" });
  assert.deepEqual(workspaceThreadIds(state, "project-1"), ["project-session"]);
  assert.deepEqual(
    workspaceThreadIds(state, SESSIONS_KEY),
    ["session-a", "session-b"],
    "opening in a project never leaks into Sessions"
  );

  state = transition(state, {
    type: "SWITCH_CONTEXT",
    context: sessions(),
  });
  assert.deepEqual(
    state.location,
    { context: sessions(), threadId: "session-b" },
    "switching back restores that context's remembered focus"
  );
});

test("showing home or a project overview preserves remembered tabs without routing one", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "session-a" });
  state = transition(state, {
    type: "SHOW_OVERVIEW",
    context: sessions(),
  });

  assert.deepEqual(state.location, { context: sessions(), threadId: null });
  assert.equal(state.workspaces[SESSIONS_KEY].focusedTabId, tabIdForThread("session-a"));
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["session-a"]);

  state = transition(state, { type: "SWITCH_CONTEXT", context: sessions() });
  assert.equal(state.location.threadId, "session-a");
});

test("closing the visible tab chooses the layout neighbour; closing another leaves location alone", () => {
  let state = createSessionViewState();
  for (const threadId of ["a", "b", "c"]) {
    state = transition(state, { type: "OPEN_THREAD", threadId });
  }
  state = transition(state, { type: "OPEN_THREAD", threadId: "b" });

  state = transition(state, {
    type: "CLOSE_TAB",
    tabId: tabIdForThread("a"),
  });
  assert.equal(state.location.threadId, "b", "closing a background tab changes no route");

  state = transition(state, {
    type: "CLOSE_TAB",
    tabId: tabIdForThread("b"),
  });
  assert.equal(state.location.threadId, "c", "the right neighbour becomes visible");
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["c"]);

  state = transition(state, {
    type: "CLOSE_TAB",
    tabId: tabIdForThread("c"),
  });
  assert.deepEqual(state.location, { context: sessions(), threadId: null });
});

test("removing a thread sweeps every context and settles the visible location", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "shared" });
  state = transition(state, {
    type: "SWITCH_CONTEXT",
    context: project("project-1"),
  });
  state = transition(state, { type: "OPEN_THREAD", threadId: "project-fallback" });
  state = transition(state, { type: "OPEN_THREAD", threadId: "shared" });

  state = transition(state, { type: "REMOVE_THREAD", threadId: "shared" });

  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), []);
  assert.deepEqual(workspaceThreadIds(state, "project-1"), ["project-fallback"]);
  assert.deepEqual(state.location, {
    context: project("project-1"),
    threadId: "project-fallback",
  });
});

test("promotion rekeys the same visible tab without losing pin or identity invariants", () => {
  let state = createSessionViewState();
  state = transition(state, {
    type: "OPEN_THREAD",
    threadId: "claude-pending-1",
  });
  state = {
    ...state,
    workspaces: {
      ...state.workspaces,
      [SESSIONS_KEY]: setTabPinned(
        state.workspaces[SESSIONS_KEY],
        tabIdForThread("claude-pending-1"),
        true
      ),
    },
  };

  state = transition(state, {
    type: "RETARGET_THREAD",
    fromThreadId: "claude-pending-1",
    toThreadId: "claude-real-1",
  });

  assert.deepEqual(state.location, {
    context: sessions(),
    threadId: "claude-real-1",
  });
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["claude-real-1"]);
  assert.equal(state.workspaces[SESSIONS_KEY].tabs[0].id, tabIdForThread("claude-real-1"));
  assert.equal(state.workspaces[SESSIONS_KEY].tabs[0].pinned, true);
});

test("versioned history restores the exact context while the URL owns the thread id", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "session-a" });
  state = transition(
    state,
    {
      type: "RESTORE_HISTORY",
      entry: {
        version: 1,
        context: project("project-1"),
      },
      urlThreadId: "project-session",
    },
    { projectIds: ["project-1"] }
  );

  assert.deepEqual(state.location, {
    context: project("project-1"),
    threadId: "project-session",
  });
  assert.deepEqual(workspaceThreadIds(state, "project-1"), ["project-session"]);
  assert.deepEqual(sessionViewHistoryEntry(state), {
    version: 1,
    context: project("project-1"),
  });
});

test("legacy empty history keeps the current context", () => {
  let state = createSessionViewState({
    location: {
      context: project("project-1"),
      threadId: "project-session",
    },
  });

  state = transition(
    state,
    {
      type: "RESTORE_HISTORY",
      entry: {},
      urlThreadId: "project-session",
    },
    { projectIds: ["project-1"] }
  );

  assert.deepEqual(state.location.context, project("project-1"));
  assert.equal(state.location.threadId, "project-session");
});

test("history naming a deleted project falls back without creating its tab set", () => {
  const state = transition(
    createSessionViewState(),
    {
      type: "RESTORE_HISTORY",
      entry: {
        viewMode: "projects",
        projectId: "deleted-project",
      },
      urlThreadId: null,
    },
    { projectIds: ["live-project"] }
  );

  assert.deepEqual(state.location, {
    context: projectsHome(),
    threadId: null,
  });
  assert.equal(state.workspaces["deleted-project"], undefined);
  assert.equal(sessionViewContextKey(state.location.context), NO_PROJECT_KEY);
});

test("a tombstoned history thread is swept and falls back inside the restored context", () => {
  let state = createSessionViewState({
    location: {
      context: project("project-1"),
      threadId: "project-fallback",
    },
  });

  state = transition(
    state,
    {
      type: "RESTORE_HISTORY",
      entry: {
        version: 1,
        context: project("project-1"),
      },
      urlThreadId: "deleted-thread",
    },
    {
      projectIds: ["project-1"],
      unavailableThreadIds: ["deleted-thread"],
    }
  );

  assert.equal(state.location.threadId, "project-fallback");
  assert.ok(!workspaceThreadIds(state, "project-1").includes("deleted-thread"));
});

test("state construction repairs a routed thread into its exact context", () => {
  const state = createSessionViewState({
    location: {
      context: project("project-1"),
      threadId: "deep-link",
    },
  });

  assert.deepEqual(sessionViewInvariantErrors(state), []);
  assert.deepEqual(workspaceThreadIds(state, "project-1"), ["deep-link"]);
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), []);
});

test("the invariant diagnostic reports an unowned visible thread without repairing it first", () => {
  const errors = sessionViewInvariantErrors({
    location: {
      context: sessions(),
      threadId: "missing-tab",
    },
    workspaces: {
      [SESSIONS_KEY]: { tabs: [], focusedTabId: null },
    },
  });

  assert.deepEqual(errors, [
    `visible thread missing-tab is not open in ${SESSIONS_KEY}`,
  ]);
});
