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
const oneThread = [{ id: "t1", cwd: "/work/a", updated_at: 1 }];

test("sessions mode groups by cwd (default, pre-Projects behavior)", () => {
  const model = selectThreadsRenderModel({ ...base, threads: oneThread });
  assert.equal(model.viewMode, "sessions");
  assert.ok(model.groups.length >= 1, "cwd grouping still produces groups");
});

test("projects mode fails closed until the payload is loaded/valid", () => {
  const notLoaded = selectThreadsRenderModel({
    ...base,
    viewMode: "projects",
    threads: oneThread,
    projectsLoaded: false,
  });
  assert.deepEqual(notLoaded.groups, [], "no grouping before the first successful load");
  assert.match(notLoaded.countLabel, /Loading projects/);

  const errored = selectThreadsRenderModel({
    ...base,
    viewMode: "projects",
    threads: oneThread,
    projectsLoaded: true,
    projectsError: "boom",
  });
  assert.deepEqual(errored.groups, [], "no grouping on fetch error");
  assert.equal(errored.countLabel, "Projects unavailable");
  assert.match(errored.emptyMessage, /Failed to load projects/);

  const refreshing = selectThreadsRenderModel({
    ...base,
    viewMode: "projects",
    threads: oneThread,
    projectsLoaded: true,
    projectsLoading: true,
  });
  assert.deepEqual(refreshing.groups, [], "no grouping while a newer-revision refresh is pending");
  assert.match(refreshing.countLabel, /Loading projects/);
});

test("projects mode groups by project once the payload is loaded", () => {
  const model = selectThreadsRenderModel({
    ...base,
    viewMode: "projects",
    threads: oneThread,
    projects: [{ id: "p1", name: "VerifyProj" }],
    threadProjectId: { t1: "p1" },
    projectsLoaded: true,
  });
  assert.equal(model.viewMode, "projects");
  const labels = model.groups.map((group) => group.label);
  assert.ok(labels.includes("VerifyProj"), `expected a VerifyProj group, got ${JSON.stringify(labels)}`);
});

// Parity with the local Projects sidebar, which lists one row per project and
// deliberately does NOT surface the "Unassigned" bucket (see
// shared/project-overview-react.js:54 and the local render path's comment at
// local/render-session.js:1445). Remote still routed Projects mode through
// buildNavigationThreadGroups(groupBy:"project"), whose shared grouping always
// creates an Unassigned bucket (shared/thread-groups.js:124-126) — so the phone
// flooded the Projects view with every unassigned session. Commit a49ce53 named
// the remote surface as a follow-up and it was never done.
//
// The invariant asserted here is representation-independent: whether Projects
// mode ends up emitting thread groups or project rows, an unassigned session must
// never be surfaced, and a real project must still be represented.
test("projects mode never surfaces the Unassigned bucket (parity with local)", () => {
  const model = selectThreadsRenderModel({
    ...base,
    viewMode: "projects",
    threads: [
      { id: "t1", cwd: "/work/a", updated_at: 1 },
      // Deliberately has no entry in threadProjectId — this is the session that
      // must stay hidden in Projects mode.
      { id: "t2", cwd: "/work/b", updated_at: 2 },
    ],
    projects: [{ id: "p1", name: "VerifyProj" }],
    threadProjectId: { t1: "p1" },
    projectsLoaded: true,
  });

  const groups = model.groups || [];
  const labels = groups.map((group) => String(group.label ?? ""));
  assert.ok(
    !labels.some((label) => /unassigned/i.test(label)),
    `no Unassigned group may be surfaced, got ${JSON.stringify(labels)}`
  );

  const surfacedThreadIds = groups.flatMap((group) =>
    (group.threads || []).map((thread) => thread.id)
  );
  assert.ok(
    !surfacedThreadIds.includes("t2"),
    `the unassigned session t2 must not be surfaced, got ${JSON.stringify(surfacedThreadIds)}`
  );

  // Positive half: keep this test honest — an implementation that simply emits
  // nothing in Projects mode must not pass. The assigned session must also still
  // be reachable, so dropping the bucket can't turn Projects mode into a dead end.
  assert.ok(
    labels.includes("VerifyProj"),
    `the real project must still be represented, got ${JSON.stringify(labels)}`
  );
  assert.ok(
    surfacedThreadIds.includes("t1"),
    "the assigned session must still be reachable in Projects mode"
  );
});