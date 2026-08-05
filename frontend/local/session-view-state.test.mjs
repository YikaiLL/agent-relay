import assert from "node:assert/strict";
import test from "node:test";

import { layoutThreadIds, setTabPinned, tabIdForThread } from "../shared/tab-layout.js";
import { SESSIONS_KEY } from "../shared/tab-workspace-store.js";
import {
  createSessionViewState,
  reduceSessionView,
  selectContextAfterProjectDelete,
  selectOwningContext,
  sessionViewContextKey,
  sessionViewHistoryEntry,
  sessionViewInvariantErrors,
} from "./session-view-state.js";

const sessions = () => ({ kind: "sessions" });
const project = (projectId) => ({ kind: "project", projectId });
// `projects-home` is gone: it meant "in Projects mode with nothing selected", and the
// toggle that could put you there no longer exists. Everything that used to land there
// lands in the sessions context, which the switcher calls Default Workspace. The
// invariant these tests guard is unchanged — a deleted project must not hydrate its
// cold tab set — only where the fallback lands.
const projectsHome = () => ({ kind: "sessions" });

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
  // SESSIONS_KEY, not the old NO_PROJECT_KEY: the fallback context IS the sessions
  // context now, so it keys the sessions tab set rather than a third one of its own.
  assert.equal(sessionViewContextKey(state.location.context), SESSIONS_KEY);
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

// Reload is not a gesture. A session you were only peeking at stays a peek
// across a refresh: preview-ness is persisted state and must round-trip
// faithfully, or refreshing the page would quietly pin whatever you happened to
// be looking at. (The other half — a link to a session you are NOT already
// holding open — is covered by "history restore opens a kept tab": there is no
// existing tab there, so the new one is kept.)
test("boot does not re-flag a session that is already open", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "a", preview: true });

  // Reloading on ?thread=a, with a's preview tab restored from storage.
  state = transition(state, {
    type: "RESTORE_HISTORY",
    entry: { version: 1, context: sessions() },
    urlThreadId: "a",
  });
  assert.deepEqual(
    previewIds(state, SESSIONS_KEY),
    ["a"],
    "a refresh neither keeps nor discards; it restores what was there"
  );
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["a"]);

  // ...and it is still the slot the next peek takes.
  state = transition(state, { type: "OPEN_THREAD", threadId: "b", preview: true });
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["b"]);

  // The same restore onto a KEPT session leaves it kept, symmetrically.
  state = transition(state, { type: "OPEN_THREAD", threadId: "c", preview: false });
  state = transition(state, {
    type: "RESTORE_HISTORY",
    entry: { version: 1, context: sessions() },
    urlThreadId: "c",
  });
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["b"], "the kept session stayed kept");
});

// Closing a tab discards it, and that includes discarding the fact that it was
// kept — the tab and its state go together. So stepping Back onto a session you
// had kept and then closed reopens it the way any other back step does: as a
// peek. Keeping it again is one double click away.
test("back onto a kept-then-closed session reopens it as a peek", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "a", preview: false });
  state = transition(state, { type: "CLOSE_TAB", tabId: tabIdForThread("a") });
  state = transition(state, { type: "OPEN_THREAD", threadId: "b", preview: true });

  state = transition(state, {
    type: "RESTORE_HISTORY",
    entry: { version: 1, context: sessions() },
    urlThreadId: "a",
    preview: true,
  });
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["a"]);
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["a"]);
});

// --- The owning context of a session row -------------------------------------
//
// Regression guard for a state bug the Project switcher introduced. Under the old
// Projects mode the sidebar showed ONLY the selected project's sessions, so "open
// this row" and "open it in the selected project" were the same thing. Pinning
// changed that: the list keeps every session, so a row for an UNASSIGNED session
// sits on screen right next to a pinned project's group.
//
// Opening one has to land in the Sessions context. Expressing that as `null` does
// not work — `setThreadRoute` reads a null context as "use the current one", so
// the unassigned session was being filed into the selected project's tab
// workspace, and the switcher went on claiming that project. The context must be
// stated, never defaulted.
test("selectOwningContext puts an unassigned session in the sessions context", () => {
  assert.deepEqual(
    selectOwningContext({ threadId: "t1", threadProjectId: {} }),
    { kind: "sessions" }
  );
});

test("selectOwningContext follows membership into the owning project", () => {
  assert.deepEqual(
    selectOwningContext({ threadId: "t1", threadProjectId: { t1: "proj_a" } }),
    { kind: "project", projectId: "proj_a" }
  );
});

test("selectOwningContext ignores which project is currently selected", () => {
  // The whole point: the answer depends on the ROW, never on the selection.
  assert.deepEqual(
    selectOwningContext({ threadId: "t_unassigned", threadProjectId: { t_other: "proj_a" } }),
    { kind: "sessions" }
  );
});

test("selectOwningContext never returns null, so no caller can fall back to current", () => {
  for (const args of [
    { threadId: "t1", threadProjectId: null },
    { threadId: "t1" },
    { threadId: null, threadProjectId: { t1: "proj_a" } },
    {},
    undefined,
  ]) {
    const context = selectOwningContext(args);
    assert.ok(context && typeof context.kind === "string", `null-ish context for ${JSON.stringify(args)}`);
  }
});

// --- where deleting a project leaves you ------------------------------------

test("deleting the project you are IN returns you to the default workspace", () => {
  assert.deepEqual(
    selectContextAfterProjectDelete({
      context: { kind: "project", projectId: "proj_a" },
      deletedProjectId: "proj_a",
    }),
    { kind: "sessions" }
  );
});

// The receipt lists every surviving project, and the old inline branch navigated to
// the first of them. Nothing here can consult that list, which is the point: there is
// no number of survivors — zero, one, many — that changes the answer.
test("deleting the project you are in ignores how many projects survive", () => {
  const answer = selectContextAfterProjectDelete({
    context: { kind: "project", projectId: "proj_a" },
    deletedProjectId: "proj_a",
  });
  assert.deepEqual(answer, { kind: "sessions" });
  assert.equal(
    selectContextAfterProjectDelete.length <= 1,
    true,
    "it takes one options object and no survivor list — a list it cannot see is a list it cannot follow"
  );
});

// Null, not `{kind:"sessions"}`: the caller reads null as "do not navigate". Returning
// the sessions context here would make deleting some OTHER project from a menu throw
// you out of the project you are working in.
test("deleting a different project does not move you", () => {
  assert.equal(
    selectContextAfterProjectDelete({
      context: { kind: "project", projectId: "proj_a" },
      deletedProjectId: "proj_b",
    }),
    null
  );
});

test("deleting a project while in the default workspace does not move you", () => {
  assert.equal(
    selectContextAfterProjectDelete({ context: { kind: "sessions" }, deletedProjectId: "proj_a" }),
    null
  );
});

test("a missing project id is never treated as a match", () => {
  for (const deletedProjectId of ["", null, undefined, 0]) {
    assert.equal(
      selectContextAfterProjectDelete({ context: { kind: "project", projectId: "proj_a" }, deletedProjectId }),
      null,
      `${JSON.stringify(deletedProjectId)} must not match a real selection`
    );
  }
});
