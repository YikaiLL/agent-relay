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

test("valid move and background-context pin/move do not disturb the visible location", () => {
  let state = createSessionViewState();
  for (const threadId of ["a", "b", "c"]) {
    state = transition(state, { type: "OPEN_THREAD", threadId });
  }
  state = transition(state, {
    type: "SWITCH_CONTEXT",
    context: project("project-1"),
  });
  state = transition(state, {
    type: "OPEN_THREAD",
    threadId: "project-visible",
  });

  state = transition(state, {
    type: "MOVE_TAB",
    tabId: tabIdForThread("c"),
    toIndex: 0,
    context: sessions(),
  });
  state = transition(state, {
    type: "PIN_TAB",
    tabId: tabIdForThread("a"),
    pinned: true,
    context: sessions(),
  });
  state = transition(state, {
    type: "MOVE_TAB",
    tabId: tabIdForThread("b"),
    toIndex: 1,
    context: sessions(),
  });

  assert.deepEqual(state.location, {
    context: project("project-1"),
    threadId: "project-visible",
  });
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["a", "b", "c"]);
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

test("history preserves project context while project ids are not authoritative yet", () => {
  let state = createSessionViewState();
  state = transition(
    state,
    {
      type: "RESTORE_HISTORY",
      entry: {
        version: 1,
        context: project("project-loading"),
      },
      urlThreadId: "project-session",
    },
    {
      projectIds: [],
      projectIdsComplete: false,
    }
  );

  assert.deepEqual(state.location, {
    context: project("project-loading"),
    threadId: "project-session",
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

// ── Preview opens ───────────────────────────────────────────────────────────
// The sidebar's browse gesture must not accumulate tabs. `preview: true` peeks,
// `preview: false` is the deliberate open that keeps the session, and an
// unqualified OPEN_THREAD (boot, a new session, a fallback) keeps by default
// without ever demoting or promoting a tab behind the user's back.

const previewIds = (state, key) =>
  (state.workspaces[key]?.tabs || []).filter((tab) => tab.preview).flatMap((tab) => layoutThreadIds(tab.layout));

test("browsing sessions with preview opens reuses one tab", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "a", preview: true });
  state = transition(state, { type: "OPEN_THREAD", threadId: "b", preview: true });
  state = transition(state, { type: "OPEN_THREAD", threadId: "c", preview: true });

  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["c"]);
  assert.equal(state.location.threadId, "c", "the peeked session is still on screen");
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["c"]);
});

test("a deliberate open keeps the session and promotes its preview tab", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "a", preview: true });
  state = transition(state, { type: "OPEN_THREAD", threadId: "a", preview: false });
  state = transition(state, { type: "OPEN_THREAD", threadId: "b", preview: true });

  assert.deepEqual(
    workspaceThreadIds(state, SESSIONS_KEY),
    ["a", "b"],
    "the promoted session survived the next peek"
  );
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["b"]);
});

test("an unqualified open keeps a new tab but never re-flags an open one", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "a" });
  assert.deepEqual(previewIds(state, SESSIONS_KEY), [], "a plain open is a kept tab");

  // Focusing a previewed session from the tab strip or the URL must leave it
  // previewed, otherwise the slot is consumed by ordinary navigation.
  state = transition(state, { type: "OPEN_THREAD", threadId: "b", preview: true });
  state = transition(state, { type: "OPEN_THREAD", threadId: "a" });
  state = transition(state, { type: "OPEN_THREAD", threadId: "b" });
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["b"]);
});

test("PROMOTE_TAB keeps a previewed session by thread or by tab id", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "a", preview: true });
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["a"]);
  state = transition(state, { type: "PROMOTE_TAB", threadId: "a" });
  assert.deepEqual(previewIds(state, SESSIONS_KEY), []);

  state = transition(state, { type: "OPEN_THREAD", threadId: "b", preview: true });
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["b"]);
  state = transition(state, { type: "PROMOTE_TAB", tabId: tabIdForThread("b") });
  assert.deepEqual(previewIds(state, SESSIONS_KEY), []);
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["a", "b"]);

  // Unknown targets must not throw or disturb the location.
  const before = state;
  state = transition(state, { type: "PROMOTE_TAB", threadId: "missing" });
  assert.deepEqual(state.location, before.location);
});

test("each context owns its own preview slot", () => {
  let state = createSessionViewState();
  state = transition(state, {
    type: "OPEN_THREAD",
    threadId: "a",
    preview: true,
    context: project("p1"),
  });
  state = transition(state, {
    type: "OPEN_THREAD",
    threadId: "b",
    preview: true,
    context: project("p2"),
  });

  assert.deepEqual(workspaceThreadIds(state, "p1"), ["a"], "p1 keeps its own peek");
  assert.deepEqual(workspaceThreadIds(state, "p2"), ["b"]);
  assert.deepEqual(previewIds(state, "p1"), ["a"], "p2's peek must not consume p1's slot");
  assert.deepEqual(previewIds(state, "p2"), ["b"]);
});

// Restoring a route is not a browse gesture: a shared/reloaded `?thread=` is a
// session the user asked for by name.
test("history restore opens a kept tab", () => {
  let state = createSessionViewState();
  state = transition(state, {
    type: "RESTORE_HISTORY",
    entry: { version: 1, context: sessions() },
    urlThreadId: "a",
  });
  assert.deepEqual(previewIds(state, SESSIONS_KEY), []);
});

// Retracing your steps is still browsing. Back/Forward walks the peeks you just
// made, so restoring one must reuse the preview slot exactly as the original
// click did — otherwise walking back through a browse deposits one permanent tab
// per step, which is the accumulation the preview tab exists to stop.
test("stepping back through a browse reuses the preview slot", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "a", preview: true });
  state = transition(state, { type: "OPEN_THREAD", threadId: "b", preview: true });
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["b"]);

  // Back onto "a": its tab was replaced by "b", so this reopens it.
  state = transition(state, {
    type: "RESTORE_HISTORY",
    entry: { version: 1, context: sessions() },
    urlThreadId: "a",
    preview: true,
  });
  assert.deepEqual(
    workspaceThreadIds(state, SESSIONS_KEY),
    ["a"],
    "back replaced the peek instead of stacking on it"
  );
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["a"]);
  assert.equal(state.location.threadId, "a");
});

// The other half of the contract: a session you kept must survive being stepped
// over, and stepping back onto it must not make it disposable again.
test("stepping back onto a kept session leaves it kept", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "a", preview: false });
  state = transition(state, { type: "OPEN_THREAD", threadId: "b", preview: true });
  state = transition(state, {
    type: "RESTORE_HISTORY",
    entry: { version: 1, context: sessions() },
    urlThreadId: "a",
    preview: true,
  });

  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["a", "b"]);
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["b"], "the kept session was not demoted");
});
