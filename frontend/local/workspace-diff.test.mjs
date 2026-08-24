import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  computeChangeStats,
  createWorkspaceDiffStore,
  WorkspaceChangesPanel,
} from "./workspace-diff.js";

// Minimal external store for useSyncExternalStore: never notifies, just serves state.
function fakeStore(state, methods = {}) {
  return { subscribe: () => () => {}, getState: () => state, ...methods };
}

// A promise whose resolution we control, to force out-of-order refresh completion.
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// #10: with no active session the diff panel reads as "the current agent's output",
// but it is always the workspace git working tree (path-scoped, never session-scoped).
// The row must name that subject — matching the modal's existing "Workspace diff" title —
// instead of a bare "Changes" that implies ownership by whatever session is (not) running.
test("workspace changes row names its subject ('Workspace changes', not a bare 'Changes')", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore({ status: "loaded", data: { file_changes: [] }, expanded: false }),
    })
  );
  assert.match(html, /Workspace changes/);
  assert.doesNotMatch(html, />Changes</);
});

test("computeChangeStats returns zero stats for null data", () => {
  const stats = computeChangeStats(null);
  assert.equal(stats.fileCount, 0);
  assert.equal(stats.added, 0);
  assert.equal(stats.removed, 0);
});

test("computeChangeStats counts +/- lines per file change, ignoring file headers", () => {
  const stats = computeChangeStats({
    file_changes: [
      {
        path: "a.txt",
        change_type: "update",
        diff: [
          "diff --git a/a.txt b/a.txt",
          "--- a/a.txt",
          "+++ b/a.txt",
          "@@ -1,2 +1,3 @@",
          "-old",
          "+new",
          "+extra",
        ].join("\n"),
      },
      {
        path: "b.txt",
        change_type: "add",
        diff: [
          "diff --git a/b.txt b/b.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/b.txt",
          "@@ -0,0 +1,1 @@",
          "+hello",
        ].join("\n"),
      },
    ],
  });
  assert.equal(stats.fileCount, 2);
  assert.equal(stats.added, 3);
  assert.equal(stats.removed, 1);
});

test("computeChangeStats handles file changes with empty diff strings", () => {
  const stats = computeChangeStats({
    file_changes: [
      { path: "x.bin", change_type: "add", diff: "" },
    ],
  });
  assert.equal(stats.fileCount, 1);
  assert.equal(stats.added, 0);
  assert.equal(stats.removed, 0);
});

// The workspace read rides alongside the diff on the local surface, so tests about the
// DIFF request say so rather than counting every call.
const diffCalls = (calls) => calls.filter((path) => path.startsWith("/api/workspace/diff"));
// Silences the workspace read for tests that are only about the diff transport.
const NO_WORKSPACE = async () => null;

// Part A: the diff request must carry the *viewed* session id so the panel shows
// that session's workspace (not the process-global/active one).
test("workspace diff request carries ?thread_id= for the viewed session", async () => {
  const calls = [];
  const apiFetch = async (path) => {
    calls.push(path);
    return { ok: true, json: async () => ({ ok: true, data: { file_changes: [] } }) };
  };
  const store = createWorkspaceDiffStore({
    apiFetch,
    surface: "local",
    getThreadId: () => "thread-xyz",
  });
  await store.refresh();
  assert.deepEqual(diffCalls(calls), ["/api/workspace/diff?thread_id=thread-xyz"]);
  // …and the tree is asked for by the SAME session id, over the route that owns it.
  assert.ok(calls.includes("/api/thread/workspace?thread_id=thread-xyz"));
});

// The relay DELETED `root` / `auto_root` and now parses-and-ignores them, so a client
// still sending them is not a 400 — it is a pin that silently does nothing. Nothing but
// this assertion would catch that, which is exactly why it is here.
test("the diff request carries no root selector — the relay decides the tree", async () => {
  const calls = [];
  const store = createWorkspaceDiffStore({
    apiFetch: async (path) => {
      calls.push(path);
      return { ok: true, json: async () => ({ ok: true, data: { file_changes: [] } }) };
    },
    getThreadId: () => "thread-xyz",
  });
  await store.refresh();
  await store.refresh();
  for (const path of diffCalls(calls)) {
    assert.doesNotMatch(path, /\broot=/, `${path} must not carry a root override`);
    assert.doesNotMatch(path, /auto_root/, `${path} must not negotiate auto-resolve`);
  }
});

test("workspace diff request omits thread_id when no session is viewed (back-compat)", async () => {
  const calls = [];
  const apiFetch = async (path) => {
    calls.push(path);
    return { ok: true, json: async () => ({ ok: true, data: { file_changes: [] } }) };
  };
  const store = createWorkspaceDiffStore({
    apiFetch,
    surface: "local",
    getThreadId: () => null,
  });
  await store.refresh();
  assert.equal(calls[0], "/api/workspace/diff");
});

// Race guard (local apiFetch path): switching A → B fires a B refresh while A is
// still in flight. If A resolves *after* B, it must NOT overwrite B's data — else
// the Changes panel shows A's workspace while B is viewed.
test("stale local refresh cannot overwrite a newer view's diff", async () => {
  const gates = { A: deferred(), B: deferred() };
  let currentThread = "A";
  const apiFetch = (path) =>
    path.includes("thread_id=B") ? gates.B.promise : gates.A.promise;
  const store = createWorkspaceDiffStore({
    apiFetch,
    surface: "local",
    getThreadId: () => currentThread,
  });

  const pA = store.refresh(); // seq 1, thread A, in flight
  currentThread = "B";
  const pB = store.refresh(); // seq 2, thread B, in flight

  // B resolves first (newest), then the stale A resolves.
  gates.B.resolve({
    ok: true,
    json: async () => ({ ok: true, data: { cwd: "/B", file_changes: [] } }),
  });
  await pB;
  gates.A.resolve({
    ok: true,
    json: async () => ({ ok: true, data: { cwd: "/A", file_changes: [] } }),
  });
  await pA;

  assert.equal(
    store.getState().data.cwd,
    "/B",
    "a stale in-flight A response must not overwrite the newer B diff"
  );
});

// Same race, remote fetchDiff path (bypasses fetchViaApi but shares the store state).
test("stale remote refresh cannot overwrite a newer view's diff", async () => {
  const gates = [deferred(), deferred()];
  let i = 0;
  const store = createWorkspaceDiffStore({
    apiFetch: null,
    surface: "remote",
    fetchDiff: () => gates[i++].promise,
  });

  const pA = store.refresh(); // seq 1 → gates[0]
  const pB = store.refresh(); // seq 2 → gates[1]

  gates[1].resolve({ cwd: "/B", file_changes: [] });
  await pB;
  gates[0].resolve({ cwd: "/A", file_changes: [] });
  await pA;

  assert.equal(
    store.getState().data.cwd,
    "/B",
    "a stale in-flight A response must not overwrite the newer B diff (remote)"
  );
});

// Switching viewed session must not leave the previous workspace's diff on screen
// during the load window (the transient-flash invariant).
test("switching viewed session clears the previous workspace's diff during loading", async () => {
  const gates = { A: deferred(), B: deferred() };
  let currentThread = "A";
  const apiFetch = (path) =>
    path.includes("thread_id=B") ? gates.B.promise : gates.A.promise;
  const store = createWorkspaceDiffStore({
    apiFetch,
    surface: "local",
    getThreadId: () => currentThread,
  });

  // Fully load A (with a file so we can detect it in the rendered panel).
  const pA = store.refresh();
  gates.A.resolve({
    ok: true,
    json: async () => ({
      ok: true,
      data: {
        cwd: "/A",
        file_changes: [
          { path: "a.txt", change_type: "update", diff: "@@ -1 +1 @@\n-x\n+y\n" },
        ],
      },
    }),
  });
  await pA;
  assert.equal(store.getState().data.cwd, "/A");

  // Switch to B and start its refresh WITHOUT resolving it yet.
  currentThread = "B";
  const pB = store.refresh();
  const mid = store.getState();
  assert.equal(mid.status, "loading");
  assert.equal(
    mid.data,
    null,
    "A's workspace data must be cleared the moment B starts loading"
  );
  // Even expanded, the panel must not render A's file during B's load window.
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore({ ...mid, expanded: true }),
    })
  );
  assert.doesNotMatch(html, /a\.txt/);

  gates.B.resolve({
    ok: true,
    json: async () => ({ ok: true, data: { cwd: "/B", file_changes: [] } }),
  });
  await pB;
  assert.equal(store.getState().data.cwd, "/B");
});

// Workspace identity is (thread id, cwd): a same-thread cwd change (/A → /B) must
// also clear the old diff during loading, not just a thread switch.
test("changing a session's cwd clears the previous workspace's diff during loading", async () => {
  const gates = { A: deferred(), B: deferred() };
  let currentCwd = "/A";
  const apiFetch = () => (currentCwd === "/B" ? gates.B.promise : gates.A.promise);
  const store = createWorkspaceDiffStore({
    apiFetch,
    surface: "local",
    getThreadId: () => "thread-1", // same thread throughout
    getWorkspaceKey: () => JSON.stringify(["thread-1", currentCwd]),
  });

  const pA = store.refresh();
  gates.A.resolve({
    ok: true,
    json: async () => ({
      ok: true,
      data: {
        cwd: "/A",
        file_changes: [
          { path: "a.txt", change_type: "update", diff: "@@ -1 +1 @@\n-x\n+y\n" },
        ],
      },
    }),
  });
  await pA;
  assert.equal(store.getState().data.cwd, "/A");

  // Same thread, cwd moves /A → /B.
  currentCwd = "/B";
  const pB = store.refresh();
  const mid = store.getState();
  assert.equal(mid.status, "loading");
  assert.equal(
    mid.data,
    null,
    "a same-thread cwd change must clear /A's data during /B's load window"
  );

  gates.B.resolve({
    ok: true,
    json: async () => ({ ok: true, data: { cwd: "/B", file_changes: [] } }),
  });
  await pB;
  assert.equal(store.getState().data.cwd, "/B");
});

// Guard against over-clearing: a refresh at the SAME workspace identity (same thread
// AND same cwd — turnDiff / manual) must keep its data visible during load, no flicker.
test("refreshing the same viewed session keeps its diff visible during loading", async () => {
  const gates = [deferred(), deferred()];
  let i = 0;
  const apiFetch = () => gates[i++].promise;
  const store = createWorkspaceDiffStore({
    apiFetch,
    surface: "local",
    getThreadId: () => "A",
    getWorkspaceKey: () => JSON.stringify(["A", "/same-cwd"]),
    // This test gates apiFetch call-by-call; the workspace read is a separate concern.
    fetchWorkspace: NO_WORKSPACE,
  });

  const p1 = store.refresh();
  gates[0].resolve({
    ok: true,
    json: async () => ({ ok: true, data: { cwd: "/A", file_changes: [] } }),
  });
  await p1;

  const p2 = store.refresh(); // same thread — must NOT clear prior data
  assert.equal(store.getState().status, "loading");
  assert.equal(
    store.getState().data?.cwd,
    "/A",
    "same-workspace refresh must keep prior data during load (no flicker)"
  );
  gates[1].resolve({
    ok: true,
    json: async () => ({ ok: true, data: { cwd: "/A", file_changes: [] } }),
  });
  await p2;
});

// Fail-closed: an unavailable workspace must read as *unavailable*, never as a
// clean tree or a non-git repo (which would hide the fact that we failed closed).
test("unavailable workspace renders as unavailable, not clean or non-git", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore({
        status: "loaded",
        data: { unavailable: true, file_changes: [] },
        expanded: true,
      }),
    })
  );
  assert.match(html, /unavailable/i);
  assert.doesNotMatch(html, /Working tree is clean/);
  assert.doesNotMatch(html, /not a git repository/);
});

// ---- which working tree, decided by the relay ---------------------------------
//
// This browser used to hold the answer itself: a `rootByThread` pin plus an
// `autoRootByThread` one-shot negotiation, both sent on every diff request. That state
// died on reload, local and remote each kept their own copy, and a review could see
// neither — which is how three reviews ran against a tree the work had left. It is gone.
// The relay resolves the tree, this store reads it, and a user's choice is a WRITE to the
// relay, so it is durable and shared.

// A stand-in relay: resolves to `cwd`, accepts a pin only for a listed root.
function fakeRelayWorkspace({ cwd = "/repo/main", roots = ["/repo/main", "/repo/wt"] } = {}) {
  let pinned = null;
  const calls = { reads: [], writes: [] };
  const resolve = () => ({
    cwd: pinned || cwd,
    origin: pinned ? { kind: "pinned" } : { kind: "proven" },
    git: { cwd: pinned || cwd, is_repo: true, branch: "main", detached: false, dirty: false },
    roots: roots.map((path) => ({ path, branch: "main", is_main: path === "/repo/main" })),
    birth_cwd: "/repo/main",
    birth_cwd_exists: true,
  });
  return {
    calls,
    fetchWorkspace: async (threadId) => {
      calls.reads.push(threadId);
      return resolve();
    },
    setWorkspace: async (threadId, requested) => {
      calls.writes.push([threadId, requested]);
      if (requested && !roots.includes(requested)) {
        throw new Error(
          `${requested} is not one of this session's working trees; pick one of the trees the relay listed for it`
        );
      }
      pinned = requested || null;
      return resolve();
    },
  };
}

function storeWithRelay(relay, getThreadId = () => "thread-a") {
  return createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId,
    fetchWorkspace: relay.fetchWorkspace,
    setWorkspace: relay.setWorkspace,
  });
}

test("a refresh reads the relay's resolved working tree for the viewed thread", async () => {
  const relay = fakeRelayWorkspace();
  const store = storeWithRelay(relay);

  await store.refresh();

  assert.deepEqual(relay.calls.reads, ["thread-a"]);
  const { workspace } = store.getState();
  assert.equal(workspace.cwd, "/repo/main");
  assert.equal(workspace.origin.kind, "proven");
  assert.equal(store.getState().workspaceStatus, "loaded");
});

// Looking at another tree in Changes is a view, not a session pin.
test("choosing a tree in Changes must not pin the session workspace", async () => {
  const relay = fakeRelayWorkspace();
  const store = storeWithRelay(relay);
  await store.refresh();
  assert.equal(store.getState().workspace.origin.kind, "proven");

  await store.setViewRoot("/repo/wt");

  assert.deepEqual(
    relay.calls.writes,
    [],
    "a Diff preview must never POST a session pin — viewing is not relocating"
  );
  assert.equal(
    store.getState().workspace.origin.kind,
    "proven",
    "the relay's session answer is unchanged"
  );
  assert.equal(store.getState().viewRoot, "/repo/wt");
});

test("choosing a tree in Changes asks the diff for that view_root only", async () => {
  const relay = fakeRelayWorkspace();
  const diffCalls = [];
  const store = createWorkspaceDiffStore({
    apiFetch: async (path) => {
      diffCalls.push(path);
      return {
        ok: true,
        json: async () => ({ ok: true, data: { cwd: "/repo/wt", file_changes: [] } }),
      };
    },
    getThreadId: () => "thread-a",
    fetchWorkspace: relay.fetchWorkspace,
    setWorkspace: relay.setWorkspace,
  });
  await store.refresh();
  diffCalls.length = 0;

  await store.setViewRoot("/repo/wt");

  assert.equal(diffCalls.length, 1, "previewing another tree must refetch the diff");
  assert.match(
    String(diffCalls[0]),
    /view_root=.*%2Frepo%2Fwt/,
    "the override is request-scoped on the diff URL, not durable session state"
  );
  assert.deepEqual(relay.calls.writes, []);
});

test("pinning a tree writes it to the relay, never to browser memory", async () => {
  const relay = fakeRelayWorkspace();
  const store = storeWithRelay(relay);
  await store.refresh();

  await store.pinWorkspace("/repo/wt");

  assert.deepEqual(
    relay.calls.writes,
    [["thread-a", "/repo/wt"]],
    "the pin must go over the wire — that is what makes it survive a reload"
  );
  assert.equal(store.getState().workspace.cwd, "/repo/wt");
  assert.equal(store.getState().workspace.origin.kind, "pinned");
});

test("un-pinning sends an explicit null rather than omitting the field", async () => {
  const relay = fakeRelayWorkspace();
  const store = storeWithRelay(relay);
  await store.refresh();
  await store.pinWorkspace("/repo/wt");

  await store.pinWorkspace(null);

  assert.deepEqual(relay.calls.writes.at(-1), ["thread-a", null]);
  assert.equal(store.getState().workspace.origin.kind, "proven");
});

// The point of moving the pin server-side: it is not a per-tab, per-session-of-the-browser
// preference any more. Leaving the thread and coming back must show the same tree because
// the RELAY still says so, not because this store remembered.
test("a pin survives leaving the thread and returning, because the relay holds it", async () => {
  const relay = fakeRelayWorkspace();
  let viewed = "thread-a";
  const store = storeWithRelay(relay, () => viewed);

  await store.refresh();
  await store.pinWorkspace("/repo/wt");
  assert.equal(store.getState().workspace.cwd, "/repo/wt");

  viewed = "thread-b";
  await store.refresh();
  viewed = "thread-a";
  await store.refresh();

  assert.equal(store.getState().workspace.cwd, "/repo/wt");
  assert.equal(
    relay.calls.writes.length,
    1,
    "returning must re-READ the tree, not re-write a remembered pin"
  );
});

// Fail loud, not silent: the relay refuses a tree that is not one of the session's, and
// the picker is where that has to be said.
test("a refused pin surfaces the relay's reason and leaves the tree alone", async () => {
  const relay = fakeRelayWorkspace();
  const store = storeWithRelay(relay);
  await store.refresh();

  await store.pinWorkspace("/somewhere/else");

  assert.match(store.getState().workspaceError, /not one of this session's working trees/);
  assert.equal(store.getState().workspace.cwd, "/repo/main", "the settled tree is unchanged");
  assert.equal(store.getState().workspacePinning, false, "the control must not stay busy");
});

// A tree label belongs to ONE session. Carrying the previous session's over into the load
// window would put a wrong — and plausible — answer under the new session's diff.
test("switching threads drops the previous session's tree while the new one loads", async () => {
  const gate = deferred();
  let viewed = "thread-a";
  let first = true;
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) }),
    getThreadId: () => viewed,
    fetchWorkspace: async () => {
      if (first) {
        first = false;
        return { cwd: "/repo/main", origin: { kind: "birth" }, roots: [], birth_cwd: "/repo/main", birth_cwd_exists: true };
      }
      return gate.promise;
    },
  });

  await store.refresh();
  assert.equal(store.getState().workspace.cwd, "/repo/main");

  viewed = "thread-b";
  const pending = store.refresh();
  assert.equal(store.getState().workspace, null, "thread A's tree must not label thread B");
  assert.equal(store.getState().workspaceStatus, "loading");

  gate.resolve({ cwd: "/repo/wt", origin: { kind: "proven" }, roots: [], birth_cwd: "/repo/wt", birth_cwd_exists: true });
  await pending;
  assert.equal(store.getState().workspace.cwd, "/repo/wt");
});

// The tree is a LABEL on the diff. Failing to fetch it must not take the diff down.
test("a failed workspace read leaves the diff loaded and reports itself separately", async () => {
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => "thread-a",
    fetchWorkspace: async () => {
      throw new Error("relay said no");
    },
  });

  await store.refresh();

  assert.equal(store.getState().status, "loaded");
  assert.equal(store.getState().data.cwd, "/repo/main");
  assert.equal(store.getState().workspaceStatus, "error");
  assert.match(store.getState().workspaceError, /relay said no/);
});

// ---- the tree, on screen ------------------------------------------------------

const RESOLVED = {
  cwd: "/repo/wt",
  origin: { kind: "pinned" },
  git: { cwd: "/repo/wt", is_repo: true, branch: "feature", detached: false, dirty: true },
  roots: [
    { path: "/repo/main", branch: "main", is_main: true },
    { path: "/repo/wt", branch: "feature", is_main: false },
  ],
  birth_cwd: "/repo/main",
  birth_cwd_exists: true,
};

test("every workspace-diff surface names the tree it is showing, and can re-point the preview", async () => {
  const { WorkspaceDiffSheetBody } = await import("./workspace-diff.js");
  const state = {
    status: "loaded",
    expanded: true,
    data: { cwd: "/repo/wt", file_changes: [] },
    workspace: { ...RESOLVED, origin: { kind: "proven" } },
    viewRoot: "/repo/wt",
  };

  for (const [name, Component] of [
    ["desktop rail (local + remote)", WorkspaceChangesPanel],
    ["phone sheet / remote modal", WorkspaceDiffSheetBody],
  ]) {
    const html = renderToStaticMarkup(
      React.createElement(Component, {
        store: fakeStore(state, { setViewRoot() {} }),
      })
    );
    assert.match(html, /workspace-picker-trigger/, `${name} offers the picker`);
    assert.match(html, /\/repo\/wt/, `${name} names the tree in view`);
    assert.doesNotMatch(
      html,
      />Unpin</,
      `${name} must not offer session Unpin from a Diff preview`
    );
  }
});

test("a Diff preview of another tree says viewing is not relocating, and can follow the session", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore(
        {
          status: "loaded",
          data: { cwd: "/repo/wt", file_changes: [] },
          workspace: {
            ...RESOLVED,
            cwd: "/repo/main",
            origin: { kind: "proven" },
          },
          viewRoot: "/repo/wt",
        },
        { setViewRoot() {} }
      ),
    })
  );
  assert.match(html, /does not move the session/);
  assert.match(html, /Follow session/);
});

// The single-worktree repo used to hide the picker entirely. That made the panel's own
// subject invisible in exactly the moment a session is about to acquire a second tree.
test("the working tree is named even when the repo has only one", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore({
        status: "loaded",
        data: { cwd: "/repo/main", file_changes: [] },
        workspace: {
          ...RESOLVED,
          cwd: "/repo/main",
          origin: { kind: "birth" },
          roots: [{ path: "/repo/main", branch: "main", is_main: true }],
        },
      }),
    })
  );
  assert.match(html, /\/repo\/main/);
});


// The per-file +/- counts are the densest signal this panel carries, and every
// byte needed to compute them already ships in `file_changes[].diff`. They were
// nevertheless computed only for a file the user had ALREADY opened
// (`opened ? diffStats(...) : {added: 0, removed: 0}`), so the collapsed list —
// which is what you actually scan — showed a blank stats column and forced a
// click per file just to learn how big each change was. Collapsed rows must
// report their own size.
//
// Two files with DIFFERENT counts, asserted against the per-file list only: the
// panel's aggregate badge (+7/-4 here) would otherwise satisfy a naive
// "does +2 appear anywhere" check and let the regression pass.
function fileChange(path, added, removed) {
  return {
    path,
    change_type: "update",
    diff: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,9 +1,9 @@",
      ...Array.from({ length: removed }, (_, i) => `-old${i}`),
      ...Array.from({ length: added }, (_, i) => `+new${i}`),
    ].join("\n"),
  };
}

test("collapsed file rows still show their own +/- counts", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore({
        status: "loaded",
        expanded: true,
        data: {
          cwd: "/repo",
          file_changes: [fileChange("src/a.txt", 2, 1), fileChange("src/b.txt", 5, 3)],
        },
      }),
    })
  );

  // Scope to the per-file list; the aggregate badge above it sums to +7/-4 and
  // must not be what satisfies these assertions.
  const listStart = html.indexOf("diff-file-sections");
  assert.ok(listStart > -1, "the per-file list should render");
  const list = html.slice(listStart);

  // Nothing is opened, so this is the collapsed-list rendering.
  assert.doesNotMatch(list, /<details[^>]*\sopen/);
  assert.ok(list.includes("a.txt") && list.includes("b.txt"), "both files should be listed");
  assert.match(list, /\+2/, "a.txt's collapsed row must show its added-line count");
  assert.match(list, /\+5/, "b.txt's collapsed row must show its added-line count");
  assert.match(list, /[-−]1\b/, "a.txt's collapsed row must show its removed-line count");
  assert.match(list, /[-−]3\b/, "b.txt's collapsed row must show its removed-line count");
});

// The rail's compact row and the transcript's card share one component, so the
// only thing keeping this restyle out of the conversation is the `variant` prop.
// Lock both sides: the rail must get the new structure, and the transcript must
// keep the exact markup it had before (name in a <strong>, no status glyph).
test("the compact row is opt-in — the transcript keeps its original card markup", async () => {
  const { FileChangeDiff } = await import("../shared/transcript-react.js");
  const tool = {
    item_type: "workspaceDiff",
    file_changes: [
      {
        path: "src/deep/a.txt",
        change_type: "add",
        diff: ["--- /dev/null", "+++ b/src/deep/a.txt", "@@ -0,0 +1 @@", "+hello"].join("\n"),
      },
    ],
  };

  const rail = renderToStaticMarkup(React.createElement(FileChangeDiff, { tool, variant: "rail" }));
  assert.match(rail, /diff-file-glyph/, "the rail row carries a status glyph");
  assert.match(rail, />A</, "an added file is glyphed A, like git status --short");
  // Directory and basename are separate elements so the directory can be the
  // half that truncates.
  assert.match(rail, /diff-file-dir[^>]*>src\/deep\/</);
  assert.match(rail, /diff-file-base[^>]*>a\.txt</);
  assert.doesNotMatch(rail, /<strong/, "the rail row drops the bold full-path treatment");

  const transcript = renderToStaticMarkup(React.createElement(FileChangeDiff, { tool }));
  assert.doesNotMatch(transcript, /diff-file-glyph/, "the transcript card gains no glyph column");
  // This assertion used to be the opposite — "the transcript card keeps one
  // whole path". That was a real decision, and it was right for the surface it
  // was made on: a 760px desktop column shows these paths in full, so splitting
  // them bought nothing. It stopped being right on remote, where the column
  // relaxes to the viewport and `.diff-file-section-name` ellipsised from the
  // END, dropping the basename first. Both surfaces now use the rail's split.
  // The glyph column above stays rail-only: that one IS just for the rail.
  assert.match(transcript, /diff-file-dir[^>]*>src\/deep\/</);
  assert.match(transcript, /diff-file-base[^>]*>a\.txt</);
});

// Which half of the path survives a narrow rail is a design decision, not an
// accident: the directory is split off so IT can be the part that truncates.
// An earlier attempt truncated the whole string from the left instead, which ate
// the front of long dirless names ("…EMOTE_PENDING_MESSAGE_VISIBILITY.md") —
// exactly the characters you read first.
test("splitDisplayPath separates the directory so it can truncate independently", async () => {
  const { splitDisplayPath } = await import("../shared/transcript-react.js");
  assert.deepEqual(splitDisplayPath("frontend/local/workspace-diff.js"), [
    "frontend/local/",
    "workspace-diff.js",
  ]);
  // No directory: the whole thing is the basename, so nothing is styled faint.
  assert.deepEqual(splitDisplayPath("MESSAGE_DROP_TODO.md"), ["", "MESSAGE_DROP_TODO.md"]);
  assert.deepEqual(splitDisplayPath(""), ["", ""]);
  assert.deepEqual(splitDisplayPath(undefined), ["", ""]);
  // A trailing slash means there is no basename left to protect.
  assert.deepEqual(splitDisplayPath("design/"), ["design/", ""]);
});

test("changeGlyph speaks git's A/M/D, defaulting unknown kinds to modified", async () => {
  const { changeGlyph } = await import("../shared/transcript-react.js");
  assert.equal(changeGlyph("add").letter, "A");
  assert.equal(changeGlyph("create").letter, "A");
  assert.equal(changeGlyph("delete").letter, "D");
  assert.equal(changeGlyph("remove").letter, "D");
  assert.equal(changeGlyph("update").letter, "M");
  assert.equal(changeGlyph("modify").letter, "M");
  // Unknown / absent kinds must still render a glyph rather than a blank column.
  assert.equal(changeGlyph("").letter, "M");
  assert.equal(changeGlyph(undefined).letter, "M");
  assert.equal(changeGlyph("ADD").letter, "A", "provider casing must not matter");
});

// Every workspace-diff surface shows the same compact row, so the panel reads
// the same whether you're on the desktop rail or on your phone. Local and remote
// share these two components outright (`RemoteWorkspaceChangesRail` renders
// `WorkspaceChangesPanel`; the remote modal renders `WorkspaceDiffSheetBody`),
// so surface parity is structural rather than something CSS has to keep in sync.
//
// What differs between them is DENSITY, not markup: the rail is a pointer target
// at 26px, the phone sheet a touch target at 44px. That split lives in CSS,
// keyed off the surface wrapper — see `.workspace-diff-sheet-body` in styles.css.
test("every workspace-diff surface uses the same compact row markup", async () => {
  const { WorkspaceDiffSheetBody } = await import("./workspace-diff.js");
  const state = {
    status: "loaded",
    expanded: true,
    data: {
      cwd: "/repo",
      file_changes: [
        {
          path: "/repo/src/a.txt",
          change_type: "update",
          diff: ["--- a/src/a.txt", "+++ b/src/a.txt", "@@ -1 +1 @@", "-old", "+new"].join("\n"),
        },
      ],
    },
  };

  for (const [name, Component] of [
    ["desktop rail (local + remote)", WorkspaceChangesPanel],
    ["phone sheet / remote modal", WorkspaceDiffSheetBody],
  ]) {
    const html = renderToStaticMarkup(
      React.createElement(Component, { store: fakeStore(state) })
    );
    assert.match(html, /file-diff-panel is-rail/, `${name} uses the compact row`);
    assert.match(html, /diff-file-glyph/, `${name} shows the A/M/D column`);
    assert.match(html, /diff-file-dir[^>]*>src\/</, `${name} splits the directory off`);
    assert.doesNotMatch(html, /<strong/, `${name} drops the bold full-path card treatment`);
  }

  // The sheet is the surface that carries the touch-density hook.
  const sheet = renderToStaticMarkup(
    React.createElement(WorkspaceDiffSheetBody, { store: fakeStore(state) })
  );
  assert.match(sheet, /workspace-diff-sheet-body/, "the density hook is present");
});

// A thread born in a `git worktree` keeps that path forever, but agent worktrees get
// removed once their work lands. The server now degrades to the enclosing repo instead
// of erroring (it used to surface a raw `git rev-parse ... (os error 2)`), which makes
// silence the new hazard: the panel would show ANOTHER tree's changes under this
// session's name. Whenever the diff is a fallback, every surface must say so.
test("a fallback workspace is labelled on every surface, not shown silently", async () => {
  const { WorkspaceDiffSheetBody } = await import("./workspace-diff.js");
  const state = {
    status: "loaded",
    expanded: true,
    data: {
      cwd: "/Users/x/repo",
      fallback_from: "/Users/x/repo/.claude/worktrees/wt-gone",
      file_changes: [],
    },
  };

  for (const [name, Component] of [
    ["desktop rail (local + remote)", WorkspaceChangesPanel],
    ["phone sheet / remote modal", WorkspaceDiffSheetBody],
  ]) {
    const html = renderToStaticMarkup(
      React.createElement(Component, { store: fakeStore(state) })
    );
    assert.match(html, /workspace-changes-fallback-note/, `${name} renders the notice`);
    assert.match(html, /wt-gone/, `${name} names the workspace that vanished`);
    assert.match(html, /no longer exists/, `${name} says what happened`);
    assert.match(html, /repo/, `${name} names the workspace being shown instead`);
  }

  // The common case must stay quiet: no fallback, no notice.
  const normal = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore({ status: "loaded", expanded: true, data: { cwd: "/Users/x/repo", file_changes: [] } }),
    })
  );
  assert.doesNotMatch(normal, /workspace-changes-fallback-note/);
});
