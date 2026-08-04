import test from "node:test";
import assert from "node:assert/strict";

import { selectThreadDot, selectThreadState } from "./thread-dot.js";
import {
  EMPTY_THREAD_FILTER,
  buildThreadStateGroups,
  isThreadFilterActive,
  nextRetainedStates,
  selectThreadFilterView,
  summarizeThreadStates,
} from "./thread-filter.js";

// Two cwd groups, the shape the sidebar normally renders.
const GROUPS = [
  {
    key: "/repos/relay",
    cwd: "/repos/relay",
    label: "relay",
    threads: [
      { id: "needs", updated_at: 5 },
      { id: "work", updated_at: 4 },
      { id: "idle", updated_at: 3 },
    ],
  },
  {
    key: "/repos/web",
    cwd: "/repos/web",
    label: "web",
    threads: [
      { id: "review", updated_at: 2 },
      { id: "done", updated_at: 1 },
    ],
  },
];

const STATE_BY_ID = {
  needs: "needs_input",
  work: "working",
  review: "reviewing",
  done: "completed",
  idle: null,
};
const stateOf = (thread) => STATE_BY_ID[thread.id] ?? null;

const ON = { ...EMPTY_THREAD_FILTER, on: true };

test("off → the list passes straight through", () => {
  const view = selectThreadFilterView({ groups: GROUPS, filter: EMPTY_THREAD_FILTER, stateOf });
  assert.equal(view.filtering, false);
  assert.equal(view.groups, GROUPS);
  assert.equal(isThreadFilterActive(EMPTY_THREAD_FILTER), false);
});

// The bell's default is every state, i.e. "everything that is not idle" — not a
// four-way choice. This is what keeps a thread from vanishing when it moves between
// states while you watch.
test("on with the default selection → everything except idle, bucketed by state", () => {
  const view = selectThreadFilterView({ groups: GROUPS, filter: ON, stateOf });
  assert.equal(view.filtering, true);
  assert.deepEqual(
    view.groups.map((g) => g.label),
    ["Needs input", "Working", "Reviewing", "Done"]
  );
  assert.deepEqual(view.groups.flatMap((g) => g.threads.map((t) => t.id)), [
    "needs",
    "work",
    "review",
    "done",
  ]);
  assert.equal(view.countLabel, "4 sessions");
});

// Ladder order IS urgency order. Sorting buckets by recency instead would move the
// first bucket around and the list would stop being scannable at a glance.
test("buckets keep ladder order regardless of recency", () => {
  const reversed = [
    { key: "x", cwd: "x", label: "x", threads: [{ id: "done", updated_at: 999 }, { id: "needs", updated_at: 1 }] },
  ];
  const view = selectThreadFilterView({ groups: reversed, filter: ON, stateOf });
  assert.deepEqual(view.groups.map((g) => g.state), ["needs_input", "completed"]);
});

test("narrowing to one state drops the rest", () => {
  const view = selectThreadFilterView({
    groups: GROUPS,
    filter: { ...ON, states: ["needs_input"] },
    stateOf,
  });
  assert.deepEqual(view.groups.map((g) => g.state), ["needs_input"]);
  assert.equal(view.countLabel, "1 session");
});

test("an idle thread is never bucketed", () => {
  const view = selectThreadFilterView({ groups: GROUPS, filter: ON, stateOf });
  assert.ok(!view.groups.some((g) => g.threads.some((t) => t.id === "idle")));
});

// State buckets are not directories. `ThreadGroupHeader` only makes a header clickable
// when it carries a real cwd, so an empty cwd is what stops "state:needs_input" being
// written into the workspace input and sent to the relay as a path.
test("state buckets carry no cwd, so their headers stay inert", () => {
  const view = selectThreadFilterView({ groups: GROUPS, filter: ON, stateOf });
  for (const group of view.groups) {
    assert.equal(group.cwd, "");
    assert.match(group.key, /^state:/);
  }
});

test("counts describe the whole list, not the current selection", () => {
  const counts = summarizeThreadStates(GROUPS, stateOf);
  assert.deepEqual(counts, {
    needs_input: 1,
    working: 1,
    reviewing: 1,
    completed: 1,
    total: 4,
  });

  // Narrowed to one state, the pills must still report what the others hold.
  const view = selectThreadFilterView({
    groups: GROUPS,
    filter: { ...ON, states: ["needs_input"] },
    stateOf,
  });
  assert.equal(view.counts.working, 1);
});

// The retention rule: a row must not disappear from under the pointer because the
// agent answered while you were reaching for it.
test("a thread that has matched stays listed after it leaves the selection", () => {
  const filter = { ...ON, states: ["needs_input"] };
  const sticky = nextRetainedStates({}, GROUPS, filter, stateOf);
  assert.deepEqual(sticky, { needs: "needs_input" });

  // The user answers it: needs_input → working. It must still be on screen.
  const answered = (thread) => (thread.id === "needs" ? "working" : stateOf(thread));
  const view = selectThreadFilterView({
    groups: GROUPS,
    filter: { ...filter, retained: sticky },
    stateOf: answered,
  });
  assert.ok(
    view.groups.flatMap((g) => g.threads.map((t) => t.id)).includes("needs"),
    "a row must not vanish because its state changed while the filter was open"
  );
  // ...and it is shown under its NEW state, not frozen in the old bucket.
  assert.equal(view.groups.find((g) => g.threads.some((t) => t.id === "needs")).state, "working");
});

test("new matches join a live filter immediately", () => {
  const filter = { ...ON, states: ["working"] };
  const first = nextRetainedStates({}, GROUPS, filter, stateOf);
  assert.deepEqual(first, { work: "working" });
  const promoted = (thread) => (thread.id === "idle" ? "working" : stateOf(thread));
  const second = nextRetainedStates(first, GROUPS, filter, promoted);
  assert.deepEqual(second, { work: "working", idle: "working" });
});

test("retention never resurrects a thread that never matched", () => {
  const view = selectThreadFilterView({
    groups: GROUPS,
    filter: { ...ON, states: ["needs_input"], retained: { idle: null } },
    stateOf,
  });
  assert.ok(!view.groups.some((g) => g.threads.some((t) => t.id === "idle")));
});

// The gap the retention rule left open. A thread that finishes while you are LOOKING
// at it gets no `completed` badge at all (thread-attention.js drops the badge for the
// viewed foreground thread), so it goes working → stateless. Dropping stateless rows
// meant the row still vanished from under the pointer — exactly what retention exists
// to prevent, in the one case the user is most likely to be watching.
test("a retained thread that goes fully idle keeps its last bucket", () => {
  const filter = { ...ON, states: ["working"] };
  const retained = nextRetainedStates({}, GROUPS, filter, stateOf);
  assert.deepEqual(retained, { work: "working" });

  const wentIdle = (thread) => (thread.id === "work" ? null : stateOf(thread));
  const view = selectThreadFilterView({
    groups: GROUPS,
    filter: { ...filter, retained },
    stateOf: wentIdle,
  });
  const shown = view.groups.flatMap((g) => g.threads.map((t) => t.id));
  assert.ok(shown.includes("work"), "a row must not vanish just because it went idle");
  assert.equal(
    view.groups.find((g) => g.threads.some((t) => t.id === "work")).state,
    "working",
    "with no live state left, it stays in the bucket it was last seen in"
  );
});

test("a live state always wins over the remembered one", () => {
  const promoted = (thread) => (thread.id === "work" ? "needs_input" : stateOf(thread));
  const view = selectThreadFilterView({
    groups: GROUPS,
    filter: { ...ON, states: ["working"], retained: { work: "working" } },
    stateOf: promoted,
  });
  assert.equal(
    view.groups.find((g) => g.threads.some((t) => t.id === "work")).state,
    "needs_input"
  );
});

test("turning the filter off clears retention", () => {
  assert.deepEqual(nextRetainedStates({ needs: "needs_input" }, GROUPS, EMPTY_THREAD_FILTER, stateOf), {});
});

// The bell's buckets and the row's dot read the same session; if they could disagree,
// a row with an amber dot could land under "Working".
test("every bucket agrees with the dot the row renders", () => {
  const cases = [
    { activity: null, attentionKind: "needs_input", reviewing: false },
    { activity: { tool: "bash" }, attentionKind: null, reviewing: false },
    { activity: null, attentionKind: null, reviewing: true },
    { activity: null, attentionKind: "completed", reviewing: false },
    { activity: null, attentionKind: null, reviewing: false },
  ];
  for (const input of cases) {
    const state = selectThreadState(input);
    const dot = selectThreadDot(input);
    assert.equal(Boolean(state), Boolean(dot), `dot/bucket disagree for ${JSON.stringify(input)}`);
  }
  // And the ladder's precedence is the dot's precedence.
  assert.equal(
    selectThreadState({ activity: { tool: "bash" }, attentionKind: "needs_input" }),
    "needs_input"
  );
  assert.equal(selectThreadState({ activity: { tool: "bash" }, reviewing: true }), "working");
  assert.equal(selectThreadState({ reviewing: true, attentionKind: "completed" }), "reviewing");
});

test("empty copy distinguishes 'nothing going on' from 'nothing in this selection'", () => {
  const all = selectThreadFilterView({ groups: [], filter: ON, stateOf });
  assert.match(all.emptyMessage, /Nothing is running/);
  const narrowed = selectThreadFilterView({
    groups: [],
    filter: { ...ON, states: ["reviewing"] },
    stateOf,
  });
  assert.match(narrowed.emptyMessage, /selected states/);
});

test("an unknown state in the selection falls back to every state", () => {
  const view = selectThreadFilterView({
    groups: GROUPS,
    filter: { ...ON, states: ["nonsense"] },
    stateOf,
  });
  assert.equal(view.groups.length, 4);
});

test("buildThreadStateGroups tolerates missing threads arrays", () => {
  assert.deepEqual(buildThreadStateGroups([{ key: "a", cwd: "a" }], { stateOf }), []);
  assert.deepEqual(buildThreadStateGroups(null, { stateOf }), []);
});
