import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProjectMenuItems,
  pickNewProjectId,
  normalizeProjectName,
  projectsMenuReady,
  projectMenuActionAllowed,
} from "./project-menu.js";

test("buildProjectMenuItems: unassigned thread → assign options + create, no unassign", () => {
  const items = buildProjectMenuItems({
    projects: [
      { id: "b", name: "Beta" },
      { id: "a", name: "Alpha" },
    ],
    currentProjectId: null,
  });
  assert.deepEqual(
    items.map((i) => [i.kind, i.label, i.isCurrent ?? null]),
    [
      ["assign", "Alpha", false], // sorted by name
      ["assign", "Beta", false],
      ["create", "New project…", null],
    ]
  );
});

test("buildProjectMenuItems: assigned thread → leading unassign + current marked", () => {
  const items = buildProjectMenuItems({
    projects: [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ],
    currentProjectId: "b",
  });
  assert.equal(items[0].kind, "unassign", "unassign is offered first when assigned");
  const beta = items.find((i) => i.projectId === "b");
  const alpha = items.find((i) => i.projectId === "a");
  assert.equal(beta.isCurrent, true, "the current project is marked");
  assert.equal(alpha.isCurrent, false);
  assert.equal(items[items.length - 1].kind, "create");
});

test("buildProjectMenuItems: tolerates missing/empty inputs", () => {
  assert.deepEqual(
    buildProjectMenuItems().map((i) => i.kind),
    ["create"],
    "no projects → just the create action"
  );
  const items = buildProjectMenuItems({ projects: [{ name: "no-id" }, null, { id: "x", name: "X" }] });
  assert.deepEqual(items.filter((i) => i.kind === "assign").map((i) => i.projectId), ["x"], "id-less/null entries are dropped");
});

test("pickNewProjectId: returns the single new id after a create (set-diff, not by name)", () => {
  const before = [{ id: "a", name: "Dup" }];
  const after = [
    { id: "a", name: "Dup" },
    { id: "b", name: "Dup" }, // same name, different id — find-by-name would be ambiguous
  ];
  assert.equal(pickNewProjectId(before, after), "b");
});

test("pickNewProjectId: null when zero or more-than-one new ids", () => {
  assert.equal(pickNewProjectId([{ id: "a" }], [{ id: "a" }]), null, "nothing new");
  assert.equal(
    pickNewProjectId([{ id: "a" }], [{ id: "a" }, { id: "b" }, { id: "c" }]),
    null,
    "ambiguous — more than one new id"
  );
  assert.equal(pickNewProjectId(null, [{ id: "b" }]), "b", "empty before → the one new id");
});

test("normalizeProjectName: trims, rejects blank/null", () => {
  assert.equal(normalizeProjectName("  Sealwire  "), "Sealwire");
  assert.equal(normalizeProjectName("   "), null);
  assert.equal(normalizeProjectName(""), null);
  assert.equal(normalizeProjectName(null), null);
  assert.equal(normalizeProjectName(undefined), null);
});

test("projectsMenuReady: only fresh Projects state enables mutation controls (fail closed)", () => {
  assert.equal(
    projectsMenuReady({ projectsLoaded: true, projectsError: null, projectsLoading: false }),
    true,
    "loaded, no error, settled → controls enabled"
  );
  assert.equal(
    projectsMenuReady({ projectsLoaded: false, projectsError: null, projectsLoading: false }),
    false,
    "before the first successful load"
  );
  assert.equal(
    projectsMenuReady({ projectsLoaded: true, projectsError: "boom", projectsLoading: false }),
    false,
    "after an error (even if previously loaded)"
  );
  assert.equal(
    projectsMenuReady({ projectsLoaded: true, projectsError: null, projectsLoading: true }),
    false,
    "while a newer-revision refresh is pending"
  );
  assert.equal(projectsMenuReady(), false, "missing state → fail closed");
});

test("projectMenuActionAllowed: a button built from stale Project state cannot execute", () => {
  const fresh = { projectsLoaded: true, projectsError: null, projectsLoading: false };
  assert.equal(
    projectMenuActionAllowed({ builtSeq: 5, currentSeq: 5, ...fresh }),
    true,
    "same seq + fresh → allowed"
  );
  assert.equal(
    projectMenuActionAllowed({ builtSeq: 5, currentSeq: 6, ...fresh }),
    false,
    "the state changed since the button was built (newer revision) → refused"
  );
  assert.equal(
    projectMenuActionAllowed({ builtSeq: 5, currentSeq: 5, projectsLoaded: true, projectsError: "boom", projectsLoading: false }),
    false,
    "same seq but state no longer trustworthy → refused"
  );
  assert.equal(
    projectMenuActionAllowed({ builtSeq: 5, currentSeq: 5, projectsLoaded: true, projectsError: null, projectsLoading: true }),
    false,
    "same seq but a refresh is pending → refused"
  );
});
