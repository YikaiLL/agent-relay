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