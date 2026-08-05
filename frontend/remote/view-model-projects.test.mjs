// Remote's session list under the Project switcher.
//
// Projects MODE is gone here: remote no longer swaps the grouping axis, it PINS.
// Selecting a project lifts that project's sessions into one group at the top and
// leaves every other session exactly where it was, so the list is the full list in
// every state.
//
// Read the inversion in `every session stays listed…` carefully. The test this file
// used to carry asserted the opposite — that an unassigned session must NEVER be
// surfaced — because Projects mode showed only project members and the shared
// grouper's "Unassigned" bucket had flooded the phone with everything else. Under a
// pin there is no bucket to leak and nothing is hidden, so the same session that had
// to be absent now has to be present. Anyone reading the old assertion as still-true
// would "fix" the list back into a filter.
import test from "node:test";
import assert from "node:assert/strict";

import { selectThreadsRenderModel } from "./view-model.js";

const base = {
  remoteAuth: { relayId: "r" },
  activeThreadId: null,
  error: null,
  loading: false,
  relayDirectory: [],
  session: null,
};

const PROJECT = { id: "proj_a", name: "VerifyProj" };
// t1 and t3 are in the project but in DIFFERENT directories — the case that proves
// the pin groups by membership rather than by cwd. t2 is in no project at all.
const THREADS = [
  { id: "t1", cwd: "/work/a", updated_at: 10 },
  { id: "t2", cwd: "/work/a", updated_at: 20 },
  { id: "t3", cwd: "/work/b", updated_at: 30 },
];
const MEMBERSHIP = { t1: PROJECT.id, t3: PROJECT.id };

function listedThreadIds(model) {
  return (model.groups || []).flatMap((group) => (group.threads || []).map((thread) => thread.id));
}

// Every assertion below about "what a pin does to the rest of the list" is worthless
// unless a pin actually happened: with the feature absent the model falls through to
// plain cwd grouping, which satisfies completeness, fail-open, no-blanking AND the
// folder count all by itself. Four of these tests were green against an
// unimplemented `pinnedProjectId` on their first run. This is the positive control
// that makes them mean something.
function assertPinIsInEffect(model) {
  const first = (model.groups || [])[0];
  assert.equal(
    first?.projectId,
    PROJECT.id,
    "precondition: the pinned group must lead the list, or this test is not testing a pin"
  );
}

test("with nothing pinned it groups by cwd", () => {
  const model = selectThreadsRenderModel({ ...base, threads: THREADS });

  const labels = (model.groups || []).map((group) => group.label);
  assert.deepEqual(labels.slice().sort(), ["a", "b"]);
  assert.deepEqual(listedThreadIds(model).sort(), ["t1", "t2", "t3"]);
});

test("a pinned project lifts its sessions into one group at the top, across cwds", () => {
  const model = selectThreadsRenderModel({
    ...base,
    threads: THREADS,
    pinnedProjectId: PROJECT.id,
    projects: [PROJECT],
    threadProjectId: MEMBERSHIP,
  });

  const [first, ...rest] = model.groups;
  assert.equal(first.label, "VerifyProj", "the pinned project leads the list");
  assert.equal(first.projectId, PROJECT.id);
  assert.deepEqual(
    first.threads.map((thread) => thread.id).sort(),
    ["t1", "t3"],
    "both members lift, even though they live in different directories"
  );
  assert.ok(
    rest.every((group) => !group.projectId),
    "every other group is still a plain cwd group"
  );
});

// The invariant that makes a pin safe to get wrong. A duplicated row reads as a
// refresh glitch and a dropped one reads as a deletion, so neither shows up as a
// crash — only as a list quietly disagreeing with the relay.
test("every session stays listed exactly once, including one in no project", () => {
  const model = selectThreadsRenderModel({
    ...base,
    threads: THREADS,
    pinnedProjectId: PROJECT.id,
    projects: [PROJECT],
    threadProjectId: MEMBERSHIP,
  });

  assertPinIsInEffect(model);
  const ids = listedThreadIds(model);
  assert.deepEqual(ids.slice().sort(), ["t1", "t2", "t3"], "the list is complete");
  assert.equal(new Set(ids).size, ids.length, "and carries no duplicates");

  // Named explicitly because this is the assertion that used to say the opposite.
  assert.ok(ids.includes("t2"), "a session in NO project must remain visible under a pin");
});

// Fails OPEN. The project may have been deleted from another device while it was
// selected, and the sessions are all still there — blanking a list that has nothing
// wrong with it is the worse answer once the failure mode is "not yet sorted"
// rather than "wrong".
test("an unresolvable pinned project degrades to plain cwd grouping, not an empty list", () => {
  const shared = {
    ...base,
    threads: THREADS,
    projects: [PROJECT],
    threadProjectId: MEMBERSHIP,
  };

  // Positive control FIRST: the same call shape with a resolvable id must pin.
  // Without it, "no project group appeared" is equally consistent with the pin
  // never having been implemented, and the test proves nothing about degradation.
  assertPinIsInEffect(selectThreadsRenderModel({ ...shared, pinnedProjectId: PROJECT.id }));

  const model = selectThreadsRenderModel({ ...shared, pinnedProjectId: "proj_deleted_elsewhere" });
  assert.deepEqual(listedThreadIds(model).sort(), ["t1", "t2", "t3"], "nothing is lost");
  assert.ok(
    (model.groups || []).every((group) => !group.projectId),
    "and no placeholder project group is invented"
  );
});

// The old Projects mode blanked the list behind "Loading projects…" whenever the
// dedicated payload was stale, because a wrong membership map would have mis-grouped
// EVERYTHING. A pin is additive: the worst a missing payload can do is leave the
// group unlifted, so withholding the whole list is no longer defensible.
test("a pin never blanks the list while the projects payload is in flight", () => {
  // A REFRESH in flight over a payload we already have. The old mode blanked here
  // too, which meant pulling to refresh emptied a list that was entirely correct.
  const refreshing = selectThreadsRenderModel({
    ...base,
    threads: THREADS,
    pinnedProjectId: PROJECT.id,
    projects: [PROJECT],
    threadProjectId: MEMBERSHIP,
    projectsLoading: true,
    projectsLoaded: true,
  });
  assertPinIsInEffect(refreshing);
  assert.deepEqual(listedThreadIds(refreshing).sort(), ["t1", "t2", "t3"]);

  // And the genuinely-absent payload: unlifted, but whole.
  const cold = selectThreadsRenderModel({
    ...base,
    threads: THREADS,
    pinnedProjectId: PROJECT.id,
    projects: [],
    threadProjectId: {},
    projectsLoading: true,
    projectsLoaded: false,
  });
  assert.deepEqual(listedThreadIds(cold).sort(), ["t1", "t2", "t3"]);
  assert.ok(!/Loading projects/.test(cold.countLabel), `got countLabel ${cold.countLabel}`);
});

// The count line sits directly above the list, so it has to agree with it. A pinned
// project is not a folder; counting it as one would make the two disagree by exactly
// one on every pinned render.
test("the count line counts folders, and the pinned project is not one", () => {
  const model = selectThreadsRenderModel({
    ...base,
    threads: THREADS,
    pinnedProjectId: PROJECT.id,
    projects: [PROJECT],
    threadProjectId: MEMBERSHIP,
  });

  assertPinIsInEffect(model);
  // /work/b held exactly one session and the pin lifted it, so that folder has no
  // group left at all: a pin can empty a cwd group out of existence. Two groups
  // remain — the pinned project and /work/a — of which ONE is a folder.
  //
  // Without the precondition above, `2 folders · 3 sessions` (what an UNPINNED
  // render of this fixture produces) would also have satisfied a looser assertion
  // here. That is how a count guard ends up agreeing with a list it never read.
  assert.equal(model.groups.length, 2);
  assert.match(model.countLabel, /^1 folder · 3 sessions$/);
  assert.deepEqual(listedThreadIds(model).sort(), ["t1", "t2", "t3"], "and still complete");
});
