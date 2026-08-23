// Creating a project from inside a launch/fork dialog has to end with that project
// SELECTED, and must refuse to guess when it cannot tell which one is new.
import test from "node:test";
import assert from "node:assert/strict";

const { createProjectAndSelect } = await import("../../shared/project-create.js");

function fakeStore(projects) {
  let current = projects;
  return {
    getState: () => ({ projects: current }),
    refresh: async () => {
      current = fakeStore.next ?? current;
    },
    setNext(next) {
      fakeStore.next = next;
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
  const store = {
    getState: () => ({ projects: order.includes("refresh") ? [{ id: "p2" }] : [] }),
    refresh: async () => {
      order.push("refresh");
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
