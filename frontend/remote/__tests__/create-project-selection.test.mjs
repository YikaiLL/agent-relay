// Creating a project from inside a launch/fork dialog has to end with that project
// SELECTED, and must refuse to guess when it cannot tell which one is new.
import test from "node:test";
import assert from "node:assert/strict";

const { createProjectAndSelect } = await import("../../shared/project-create.js");

// Minimal observable store: the helper waits for a CHANGE, so a fake without
// subscribe would hang rather than fail.
function fakeStore(projects) {
  let current = projects;
  let next = null;
  const listeners = new Set();
  return {
    getState: () => ({ projects: current }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: async () => {
      if (next) current = next;
      listeners.forEach((listener) => listener());
    },
    setNext(value) {
      next = value;
    },
  };
}

test("selects the project when exactly one new id appeared", async () => {
  const store = fakeStore([{ id: "p1", name: "A" }]);
  store.setNext([{ id: "p1", name: "A" }, { id: "p2", name: "B" }]);
  const applied = [];

  const id = await createProjectAndSelect({
    apply: (projectId) => applied.push(projectId),
    create: async () => {},
    name: "B",
    store,
  });

  assert.equal(id, "p2");
  assert.deepEqual(applied, ["p2"]);
});

test("refuses to guess when two new ids appeared", async () => {
  // Another device creating a project concurrently. The server sorts by NAME, so
  // "first unknown id" can easily be the other device's.
  const store = fakeStore([{ id: "p1", name: "A" }]);
  store.setNext([
    { id: "p1", name: "A" },
    { id: "p2", name: "B" },
    { id: "p3", name: "C" },
  ]);
  const applied = [];

  const id = await createProjectAndSelect({
    apply: (projectId) => applied.push(projectId),
    create: async () => {},
    name: "B",
    store,
  });

  assert.equal(id, null);
  assert.deepEqual(applied, [], "the draft is left alone rather than filed wrongly");
});

test("the list is refreshed BEFORE the id is applied", async () => {
  // Otherwise the chip renders an id the picker cannot resolve yet and briefly
  // reads "Default Workspace" while the draft already carries the new project.
  const order = [];
  const listeners = new Set();
  const store = {
    getState: () => ({ projects: order.includes("refresh") ? [{ id: "p2" }] : [] }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: async () => {
      order.push("refresh");
      listeners.forEach((listener) => listener());
    },
  };

  await createProjectAndSelect({
    apply: () => order.push("apply"),
    create: async () => {},
    name: "B",
    store,
  });

  assert.deepEqual(order, ["refresh", "apply"]);
});

test("a late result does not touch a dialog that has moved on", async () => {
  const store = fakeStore([]);
  store.setNext([{ id: "p2" }]);
  const applied = [];

  const id = await createProjectAndSelect({
    apply: (projectId) => applied.push(projectId),
    create: async () => {},
    isCurrent: () => false,
    name: "B",
    store,
  });

  assert.equal(id, null);
  assert.deepEqual(applied, []);
});

const { createProjectsStore } = await import("../../shared/projects-store.js");

test("a refresh superseded by a revision fetch still ends up selecting the project", async () => {
  // Creating a project bumps projects_revision, so refresh() being superseded —
  // and resolving without writing — is the normal case, not a rarity.
  const OLD = [{ id: "p1", name: "A" }];
  const NEW = [{ id: "p1", name: "A" }, { id: "p2", name: "B" }];
  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  let call = 0;
  let store;
  store = createProjectsStore({
    fetchProjects: async () => {
      call += 1;
      if (call === 2) {
        // The refresh, superseded mid-flight by a snapshot revision bump...
        store.syncToRevision(9);
        return { projects: OLD, projects_revision: 1, thread_project_id: {} };
      }
      if (call === 3) {
        // ...and the winning fetch lands AFTER it.
        await gate;
        return { projects: NEW, projects_revision: 9, thread_project_id: {} };
      }
      return { projects: OLD, projects_revision: 1, thread_project_id: {} };
    },
  });

  await store.refresh();
  const applied = [];
  const pending = createProjectAndSelect({
    apply: (id) => applied.push(id),
    create: async () => {},
    name: "B",
    store,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(store.getState().projects, OLD, "precondition: the store is still stale");
  openGate();

  assert.equal(await pending, "p2", "the helper must wait for the winning fetch");
  assert.deepEqual(applied, ["p2"]);
});

test("the helper gives up rather than hanging when no project ever appears", async () => {
  const store = createProjectsStore({
    fetchProjects: async () => ({ projects: [], projects_revision: 1, thread_project_id: {} }),
  });
  await store.refresh();

  const id = await createProjectAndSelect({
    apply: () => {},
    create: async () => {},
    name: "B",
    settleMs: 20,
    store,
  });

  assert.equal(id, null);
});
