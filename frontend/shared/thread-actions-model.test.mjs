import test from "node:test";
import assert from "node:assert/strict";

import { buildThreadSheetSections, threadSheetHasActions } from "./thread-actions-model.js";

const READY = { projectsLoaded: true, projectsError: null, projectsLoading: false };
const projects = [
  { id: "p2", name: "Beta" },
  { id: "p1", name: "Alpha" },
];

const kinds = (sections) => sections.map((section) => section.kind);
const labels = (sections, kind) =>
  (sections.find((section) => section.kind === kind)?.items || []).map((item) => item.label);

test("a forkable session in a fresh projects payload offers both sections", () => {
  const sections = buildThreadSheetSections({ canFork: true, projects, ...READY });
  assert.deepEqual(kinds(sections), ["session", "projects"]);
  assert.deepEqual(labels(sections, "session"), ["Fork session"]);
});

// Nothing to fork from — offering the action would open a dialog that cannot submit.
test("fork is withheld when the session cannot be forked", () => {
  const sections = buildThreadSheetSections({ canFork: false, projects, ...READY });
  assert.deepEqual(kinds(sections), ["projects"]);
});

// Fail closed, exactly as the sidebar does: a stale payload must not present
// membership controls, because "current" could point at the wrong project.
test("the projects section is withheld while the payload is not fresh", () => {
  for (const stale of [
    { projectsLoaded: false, projectsError: null, projectsLoading: false },
    { projectsLoaded: true, projectsError: "boom", projectsLoading: false },
    { projectsLoaded: true, projectsError: null, projectsLoading: true },
  ]) {
    const sections = buildThreadSheetSections({ canFork: true, projects, ...stale });
    assert.deepEqual(kinds(sections), ["session"], JSON.stringify(stale));
  }
});

test("an assigned session can be moved, removed, or filed under a new project", () => {
  const sections = buildThreadSheetSections({
    canFork: true,
    projects,
    currentProjectId: "p1",
    ...READY,
  });
  // Current project first so membership is readable without scanning.
  assert.deepEqual(labels(sections, "projects"), [
    "Alpha",
    "Beta",
    "Remove from project",
    "New project…",
  ]);
});

test("an unassigned session is offered no 'remove from project'", () => {
  const sections = buildThreadSheetSections({ canFork: true, projects, ...READY });
  assert.deepEqual(labels(sections, "projects"), ["Alpha", "Beta", "New project…"]);
});

// The empty case is the one that must never reach the screen.
test("threadSheetHasActions is false when every section is empty", () => {
  assert.equal(threadSheetHasActions([]), false);
  assert.equal(threadSheetHasActions([{ kind: "projects", items: [] }]), false);
  assert.equal(threadSheetHasActions(null), false);
  assert.equal(threadSheetHasActions([{ kind: "session", items: [{ kind: "fork" }] }]), true);
});

test("a session with no fork and no fresh projects yields nothing to open", () => {
  const sections = buildThreadSheetSections({ canFork: false, projects });
  assert.deepEqual(sections, []);
  assert.equal(threadSheetHasActions(sections), false);
});
