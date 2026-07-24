import test from "node:test";
import assert from "node:assert/strict";

import { createProjectsStore } from "./projects-store.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function payload(revision, projects = [], threadProjectId = {}) {
  return { projects_revision: revision, projects, thread_project_id: threadProjectId };
}

test("syncToRevision does an unconditional first fetch and populates state", async () => {
  let calls = 0;
  const store = createProjectsStore({
    fetchProjects: async () => {
      calls += 1;
      return payload(3, [{ id: "p", name: "P" }], { t1: "p" });
    },
  });

  store.syncToRevision(3);
  assert.equal(calls, 1, "fetches on first observation of any revision");
  await flush();
  assert.deepEqual(
    store.getState().projects.map((project) => project.id),
    ["p"]
  );
  assert.equal(store.getState().threadProjectId.t1, "p");
  assert.equal(store.getState().loading, false);
});

test("no refetch when the observed revision is unchanged", async () => {
  let calls = 0;
  const store = createProjectsStore({
    fetchProjects: async () => {
      calls += 1;
      return payload(2);
    },
  });

  store.syncToRevision(2);
  await flush();
  assert.equal(calls, 1);
  store.syncToRevision(2); // same revision → no-op
  await flush();
  assert.equal(calls, 1);
});

test("refetches when the revision changes", async () => {
  let calls = 0;
  const store = createProjectsStore({
    fetchProjects: async () => {
      calls += 1;
      return payload(calls === 1 ? 2 : 3);
    },
  });

  store.syncToRevision(2);
  await flush();
  assert.equal(calls, 1);
  store.syncToRevision(3);
  await flush();
  assert.equal(calls, 2);
});

test("a stale in-flight fetch cannot overwrite newer data", async () => {
  const gates = [deferred(), deferred()];
  let i = 0;
  const store = createProjectsStore({ fetchProjects: () => gates[i++].promise });

  store.syncToRevision(1); // fetch A
  store.syncToRevision(2); // fetch B supersedes

  // B (newest) resolves first, then the stale A.
  gates[1].resolve(payload(2, [{ id: "b", name: "B" }]));
  await flush();
  gates[0].resolve(payload(1, [{ id: "a", name: "A" }]));
  await flush();

  assert.deepEqual(
    store.getState().projects.map((project) => project.id),
    ["b"],
    "the newest fetch wins; a late stale one is dropped"
  );
});

test("refresh() force-fetches even when the revision is unchanged", async () => {
  let calls = 0;
  const store = createProjectsStore({
    fetchProjects: async () => {
      calls += 1;
      return payload(2);
    },
  });

  store.syncToRevision(2);
  await flush();
  assert.equal(calls, 1);
  store.refresh(); // e.g. right after a local mutation
  await flush();
  assert.equal(calls, 2, "refresh bypasses the revision no-op");
});

test("a malformed/null fetch payload is not latched as applied and retries", async () => {
  let calls = 0;
  const store = createProjectsStore({
    fetchProjects: async () => {
      calls += 1;
      // First call is malformed (null); second is valid.
      return calls === 1 ? null : payload(2, [{ id: "p", name: "P" }]);
    },
  });

  store.syncToRevision(2);
  await flush();
  assert.equal(calls, 1);
  assert.notEqual(store.getState().error, null, "malformed payload surfaces an error");
  assert.deepEqual(store.getState().projects, [], "no empty projects latched");

  // The revision was NOT marked applied → a repeat sync refetches and recovers.
  store.syncToRevision(2);
  await flush();
  assert.equal(calls, 2);
  assert.deepEqual(
    store.getState().projects.map((project) => project.id),
    ["p"]
  );
  assert.equal(store.getState().error, null);
});

test("reset() forces a refetch even at the same revision", async () => {
  let calls = 0;
  const store = createProjectsStore({
    fetchProjects: async () => {
      calls += 1;
      return payload(2);
    },
  });

  store.syncToRevision(2);
  await flush();
  assert.equal(calls, 1);
  store.syncToRevision(2); // no-op
  await flush();
  assert.equal(calls, 1);

  store.reset(); // relay/channel identity changed
  store.syncToRevision(2); // same revision, but reset → refetch
  await flush();
  assert.equal(calls, 2);
});

test("the response's revision is latched, not the triggering one", async () => {
  let calls = 0;
  const store = createProjectsStore({
    fetchProjects: async () => {
      calls += 1;
      // The triggering snapshot said 2, but the relay advanced: response carries 5.
      return payload(5, [{ id: "p", name: "P" }]);
    },
  });

  store.syncToRevision(2);
  await flush();
  assert.equal(calls, 1);
  // A later snapshot advertising 5 is a no-op — we already applied the response's 5.
  store.syncToRevision(5);
  await flush();
  assert.equal(calls, 1, "already have the response's revision");
});
