import test from "node:test";
import assert from "node:assert/strict";

import {
  selectProjectAgents,
  projectCardStatus,
  sortProjectCards,
  summarizeProjectActivity,
  attachProjectSummaries,
  reorderCardIds,
} from "./shared/project-overview-model.js";
import {
  createThreadListStore,
  readActiveProjectId,
} from "./shared/thread-list-store.js";

const threads = [
  { id: "t1", updated_at: 10 },
  { id: "t2", updated_at: 30 },
  { id: "t3", updated_at: 20 },
  { id: "u1", updated_at: 99 }, // unassigned
];
const membership = { t1: "p1", t2: "p1", t3: "p1" };

test("selectProjectAgents returns only that project's threads, recency-sorted", () => {
  const agents = selectProjectAgents({ projectId: "p1", threads, threadProjectId: membership });
  assert.deepEqual(agents.map((a) => a.id), ["t2", "t3", "t1"]);
});

test("selectProjectAgents excludes unassigned threads and unknown projects", () => {
  assert.deepEqual(selectProjectAgents({ projectId: "p2", threads, threadProjectId: membership }), []);
  // u1 has no membership entry — never surfaces in any project.
  const agents = selectProjectAgents({ projectId: "p1", threads, threadProjectId: membership });
  assert.ok(!agents.some((a) => a.id === "u1"));
});

test("selectProjectAgents with no projectId returns empty", () => {
  assert.deepEqual(selectProjectAgents({ projectId: null, threads, threadProjectId: membership }), []);
});

test("projectCardStatus follows needs_input > working > reviewing > completed priority", () => {
  assert.equal(
    projectCardStatus({ attentionKind: "needs_input", activity: { tool: "x" }, reviewing: true }).key,
    "needs_input",
  );
  assert.equal(projectCardStatus({ activity: { tool: "grep" }, reviewing: true }).key, "working");
  assert.equal(projectCardStatus({ activity: { tool: "grep" } }).tool, "grep");
  assert.equal(projectCardStatus({ reviewing: true }).key, "reviewing");
  assert.equal(projectCardStatus({ attentionKind: "completed" }).key, "done");
  assert.equal(projectCardStatus({}).key, "idle");
});

test("sortProjectCards floats pinned to top, then manual order, then recency", () => {
  const list = [
    { id: "a", updated_at: 1 },
    { id: "b", updated_at: 5 },
    { id: "c", updated_at: 3 },
    { id: "d", updated_at: 9 },
  ];
  // No prefs -> pure recency.
  assert.deepEqual(sortProjectCards(list).map((t) => t.id), ["d", "b", "c", "a"]);

  // Pin "a" -> it floats above everything even though it is the oldest.
  assert.deepEqual(
    sortProjectCards(list, { pinned: ["a"] }).map((t) => t.id),
    ["a", "d", "b", "c"],
  );

  // Manual order among the unpinned band; recency fills the rest.
  assert.deepEqual(
    sortProjectCards(list, { pinned: ["a"], order: ["c", "b"] }).map((t) => t.id),
    ["a", "c", "b", "d"],
  );
});

test("sortProjectCards does not mutate its input", () => {
  const list = [{ id: "a", updated_at: 1 }, { id: "b", updated_at: 2 }];
  const snapshot = list.map((t) => t.id);
  sortProjectCards(list, { pinned: ["a"] });
  assert.deepEqual(list.map((t) => t.id), snapshot);
});

test("summarizeProjectActivity counts working / needs-input / reviewing", () => {
  const agents = [{ id: "t1" }, { id: "t2" }, { id: "t3" }, { id: "t4" }];
  const summary = summarizeProjectActivity({
    agents,
    threadActivity: new Map([["t1", { tool: null }]]),
    threadAttention: new Map([["t2", "needs_input"], ["t4", "completed"]]),
    threadReviewing: new Set(["t3"]),
  });
  assert.deepEqual(summary, { working: 1, needsInput: 1, reviewing: 1, total: 4 });
});

test("reorderCardIds moves the dragged id before the target, without mutating input", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(reorderCardIds(ids, "d", "b"), ["a", "d", "b", "c"]);
  assert.deepEqual(reorderCardIds(ids, "a", "c"), ["b", "a", "c", "d"]);
  // Drop on self / unknown target / missing dragged -> stable.
  assert.deepEqual(reorderCardIds(ids, "b", "b"), ["a", "b", "c", "d"]);
  assert.deepEqual(reorderCardIds(ids, "b", "zzz"), ["a", "c", "d", "b"]);
  assert.deepEqual(reorderCardIds(ids, "zzz", "a"), ["a", "b", "c", "d"]);
  assert.deepEqual(ids, ["a", "b", "c", "d"]); // input untouched
});

test("thread-list store tracks a display-only activeProjectId", () => {
  const store = createThreadListStore();
  assert.equal(readActiveProjectId(store), null);
  store.getState().setActiveProject("p1");
  assert.equal(readActiveProjectId(store), "p1");
  // Falsy / non-string clears it (never holds a sentinel).
  store.getState().setActiveProject("");
  assert.equal(readActiveProjectId(store), null);
});

// --- attachProjectSummaries ---------------------------------------------------
//
// Guards the wiring that gives remote's project headers the same activity roll-up
// local shows. The DOM tests cover how a `summary` renders; these cover whether a
// group gets one at all, which is the part remote actually changed.

const summaryMaps = () => ({
  threadActivity: new Map([["t1", { state: "working" }]]),
  threadAttention: new Map([["t2", "needs_input"]]),
  threadReviewing: new Set(),
});

test("attachProjectSummaries rolls up each project group's own threads", () => {
  const [group] = attachProjectSummaries(
    [{ key: "p1", projectId: "p1", threads: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] }],
    summaryMaps()
  );
  assert.equal(group.summary.working, 1);
  assert.equal(group.summary.needsInput, 1);
  assert.equal(group.summary.total, 3);
});

// A cwd group is not a project; the header never takes the project branch, so
// handing it a summary would be dead data.
test("attachProjectSummaries leaves non-project groups untouched", () => {
  const cwdGroup = { key: "/work/a", cwd: "/work/a", threads: [{ id: "t1" }] };
  const [out] = attachProjectSummaries([cwdGroup], summaryMaps());
  assert.equal(out, cwdGroup, "returned by identity, not copied");
  assert.equal(out.summary, undefined);
});

// The counts are the group's own, never the whole board's — this is what breaks if
// someone rolls up `threads` from the wrong scope.
test("attachProjectSummaries scopes counts per group", () => {
  const [a, b] = attachProjectSummaries(
    [
      { key: "p1", projectId: "p1", threads: [{ id: "t1" }] },
      { key: "p2", projectId: "p2", threads: [{ id: "t2" }] },
    ],
    summaryMaps()
  );
  assert.deepEqual([a.summary.working, a.summary.needsInput], [1, 0]);
  assert.deepEqual([b.summary.working, b.summary.needsInput], [0, 1]);
});

test("attachProjectSummaries tolerates a missing group list and missing threads", () => {
  assert.deepEqual(attachProjectSummaries(null, summaryMaps()), []);
  const [group] = attachProjectSummaries([{ key: "p1", projectId: "p1" }], summaryMaps());
  assert.equal(group.summary.total, 0);
});
