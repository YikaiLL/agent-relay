import test from "node:test";
import assert from "node:assert/strict";

import { runThreadSheetAction } from "./thread-sheet-action.js";

function harness(overrides = {}) {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
  };
  const deps = {
    assign: async (...a) => calls.push(["assign", ...a]),
    unassign: async (...a) => calls.push(["unassign", ...a]),
    create: async (...a) => calls.push(["create", ...a]),
    fetchProjects: async () => ({ projects: [] }),
    promptName: () => "Gamma",
    openFork: record("openFork"),
    refresh: record("refresh"),
    log: record("log"),
    ...overrides,
  };
  return { calls, deps, names: () => calls.map((c) => c[0]) };
}

const run = (item, h, extra = {}) =>
  runThreadSheetAction({ item, threadId: "t1", deps: h.deps, ...extra });

test("fork opens the dialog and touches nothing else", async () => {
  const h = harness();
  await run({ kind: "fork" }, h);
  assert.deepEqual(h.calls, [["openFork", "t1"]]);
});

test("assign moves the session and refreshes", async () => {
  const h = harness();
  await run({ kind: "assign", projectId: "p2", label: "Beta" }, h);
  assert.deepEqual(h.names(), ["assign", "log", "refresh"]);
  assert.deepEqual(h.calls[0], ["assign", "t1", "p2"]);
});

// Picking the project it already lives in should not hit the network at all.
test("re-picking the current project is a no-op", async () => {
  const h = harness();
  await run({ kind: "assign", projectId: "p1", label: "Alpha", isCurrent: true }, h);
  assert.deepEqual(h.calls, []);
});

test("unassign removes membership and refreshes", async () => {
  const h = harness();
  await run({ kind: "unassign" }, h);
  assert.deepEqual(h.names(), ["unassign", "log", "refresh"]);
});

// The branch that broke first time round: the broker discards the create receipt, so the
// new id can only come from an awaited refetch. A fire-and-forget refresh resolves to
// undefined and would silently leave the session unassigned.
test("create diffs a refetch to find the new id, then assigns", async () => {
  const h = harness({
    fetchProjects: async () => ({ projects: [{ id: "p1" }, { id: "pNEW" }] }),
  });
  await run({ kind: "create" }, h, { projects: [{ id: "p1" }] });
  assert.deepEqual(h.names(), ["create", "assign", "log", "refresh"]);
  assert.deepEqual(h.calls[1], ["assign", "t1", "pNEW"]);
});

test("create aborts cleanly when the name prompt is dismissed", async () => {
  const h = harness({ promptName: () => null });
  await run({ kind: "create" }, h);
  assert.deepEqual(h.calls, []);
});

// Two new projects (or none) means the id is ambiguous — assigning would be a guess at
// the user's membership, so the session is left where it is.
test("create leaves the session put when the new id is ambiguous", async () => {
  const h = harness({
    fetchProjects: async () => ({ projects: [{ id: "p1" }, { id: "pA" }, { id: "pB" }] }),
  });
  await run({ kind: "create" }, h, { projects: [{ id: "p1" }] });
  assert.deepEqual(h.names(), ["create", "log", "refresh"]);
  assert.match(h.calls[1][1], /move the session from its menu/);
});

test("a refetch that yields nothing does not throw or assign", async () => {
  const h = harness({ fetchProjects: async () => undefined });
  await run({ kind: "create" }, h, { projects: [{ id: "p1" }] });
  assert.deepEqual(h.names(), ["create", "log", "refresh"]);
});

// A failed action must surface, not vanish — the sheet has already closed by then, so a
// silent failure would look like the action succeeded.
test("a transport failure is reported instead of swallowed", async () => {
  const h = harness({
    assign: async () => {
      throw new Error("relay offline");
    },
  });
  await run({ kind: "assign", projectId: "p2", label: "Beta" }, h);
  assert.deepEqual(h.names(), ["log"]);
  assert.match(h.calls[0][1], /Session action failed: relay offline/);
});

test("an unknown descriptor does nothing at all", async () => {
  const h = harness();
  await run({ kind: "nope" }, h);
  assert.deepEqual(h.calls, []);
});

test("a missing thread id is refused", async () => {
  const h = harness();
  await runThreadSheetAction({ item: { kind: "unassign" }, threadId: "", deps: h.deps });
  assert.deepEqual(h.calls, []);
});
