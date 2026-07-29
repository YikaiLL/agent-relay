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
function fakeStore(state) {
  return { subscribe: () => () => {}, getState: () => state };
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "/api/workspace/diff?thread_id=thread-xyz");
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

// ---- L1: worktree root picker ------------------------------------------------

test("selecting a root sends it as ?root= alongside the viewed thread", async () => {
  const calls = [];
  const apiFetch = async (path) => {
    calls.push(path);
    return { ok: true, json: async () => ({ ok: true, data: { cwd: "/wt", roots: [] } }) };
  };
  const store = createWorkspaceDiffStore({
    apiFetch,
    getThreadId: () => "thread-a",
  });

  await store.refresh();
  assert.equal(calls[0], "/api/workspace/diff?thread_id=thread-a");

  store.setRoot("/repo/linked");
  await store.refresh();
  assert.equal(
    calls[1],
    "/api/workspace/diff?thread_id=thread-a&root=%2Frepo%2Flinked",
    "the selected root must be sent, url-encoded"
  );
});

// The whole point of the picker: switching root must not paint the previous root's
// diff into the new root's panel while it loads.
test("switching root clears the previous root's diff during loading", async () => {
  const first = deferred();
  const second = deferred();
  let call = 0;
  const store = createWorkspaceDiffStore({
    apiFetch: async () => {
      call += 1;
      const data = await (call === 1 ? first.promise : second.promise);
      return { ok: true, json: async () => ({ ok: true, data }) };
    },
    getThreadId: () => "thread-a",
  });

  const p1 = store.refresh();
  first.resolve({ cwd: "/repo/main", file_changes: [{ path: "a.txt", diff: "+main" }], roots: [] });
  await p1;
  assert.equal(store.getState().data.cwd, "/repo/main");

  store.setRoot("/repo/linked");
  const p2 = store.refresh();
  assert.equal(
    store.getState().data,
    null,
    "the previous root's diff must be dropped while the new root loads"
  );
  second.resolve({ cwd: "/repo/linked", file_changes: [], roots: [] });
  await p2;
  assert.equal(store.getState().data.cwd, "/repo/linked");
});

// A root picked while viewing thread A must not follow you to thread B, whose repo
// may not even contain that path — the panel would show an unrelated tree.
test("selected root is remembered per thread, not carried across threads", async () => {
  const calls = [];
  let viewed = "thread-a";
  const store = createWorkspaceDiffStore({
    apiFetch: async (path) => {
      calls.push(path);
      return { ok: true, json: async () => ({ ok: true, data: { cwd: "/x", roots: [] } }) };
    },
    getThreadId: () => viewed,
  });

  store.setRoot("/repo/linked");
  await store.refresh();
  assert.ok(calls.at(-1).includes("root=%2Frepo%2Flinked"));

  // Switch to another thread: it has no remembered root, so none is sent.
  viewed = "thread-b";
  await store.refresh();
  assert.equal(
    calls.at(-1),
    "/api/workspace/diff?thread_id=thread-b",
    "thread B must start at its own workspace, not A's picked root"
  );

  // Switching back restores A's pick.
  viewed = "thread-a";
  await store.refresh();
  assert.ok(
    calls.at(-1).includes("root=%2Frepo%2Flinked"),
    "returning to thread A must restore the root it was left on"
  );
});

test("root picker lists every worktree, labelled by branch", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore({
        status: "loaded",
        selectedRoot: "/repo/feature",
        data: {
          cwd: "/repo/feature",
          file_changes: [],
          roots: [
            { path: "/repo/main", branch: "main", is_main: true },
            { path: "/repo/feature", branch: "feature", is_main: false },
          ],
        },
      }),
    })
  );
  assert.match(html, /main/);
  assert.match(html, /feature/);
  assert.match(html, /value="\/repo\/feature"/, "roots are selectable by path");
});

// A single-worktree repo is the common case; a picker with one entry is pure noise.
test("root picker is hidden when the repo has only one worktree", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore({
        status: "loaded",
        data: {
          cwd: "/repo/main",
          file_changes: [],
          roots: [{ path: "/repo/main", branch: "main", is_main: true }],
        },
      }),
    })
  );
  assert.doesNotMatch(html, /workspace-root-select/);
});

// Review finding 2: a pinned root the relay can no longer resolve (worktree removed or
// pruned, thread moved repos) returns `unavailable` with NO roots — so the picker hides
// and there is no UI left to un-pin with. The pin must self-heal instead of wedging the
// panel and re-sending the dead root on every refresh.
test("a root pin the server rejects is cleared and retried against the session workspace", async () => {
  const calls = [];
  const store = createWorkspaceDiffStore({
    apiFetch: async (path) => {
      calls.push(path);
      // The dead root fails closed; the unpinned request succeeds.
      const data = path.includes("root=")
        ? { unavailable: true, file_changes: [], roots: [] }
        : { cwd: "/repo/main", file_changes: [], roots: [] };
      return { ok: true, json: async () => ({ ok: true, data }) };
    },
    getThreadId: () => "thread-a",
  });

  store.setRoot("/repo/deleted");
  await store.refresh();

  assert.ok(calls[0].includes("root=%2Frepo%2Fdeleted"), "first attempt uses the pin");
  assert.equal(
    calls[1],
    "/api/workspace/diff?thread_id=thread-a",
    "a rejected pin must be retried without it"
  );
  assert.equal(store.getSelectedRoot(), null, "the dead pin must be dropped");
  assert.equal(
    store.getState().data.cwd,
    "/repo/main",
    "the panel recovers to the session workspace instead of staying unavailable"
  );

  // And the dead root must not come back on the next refresh.
  await store.refresh();
  assert.equal(calls.at(-1), "/api/workspace/diff?thread_id=thread-a");
});

// Guard the recovery against looping: an unavailable response with no pin set must be
// reported as-is, not retried forever.
test("unavailable with no pin set is reported, not retried", async () => {
  let calls = 0;
  const store = createWorkspaceDiffStore({
    apiFetch: async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ ok: true, data: { unavailable: true, file_changes: [] } }),
      };
    },
    getThreadId: () => "thread-a",
  });

  await store.refresh();
  assert.equal(calls, 1, "no pin → no retry");
  assert.equal(store.getState().data.unavailable, true);
});
