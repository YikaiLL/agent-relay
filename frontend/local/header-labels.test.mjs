import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_WORKSPACE_LABEL, selectHeaderLabels } from "./header-labels.js";

// THE RULE THIS FILE ENCODES
//
// The header title used to be the THREAD you were viewing. That duplicated the
// session tab strip sitting directly beneath it — the same string twice, one
// above the other. The header now names the CONTAINER instead, so the two lines
// answer different questions: the header says "where am I", the tab says "which
// session".
//
// The title is now also the Project switcher's TRIGGER, which tightened the rule.
// It has to name something the switcher can switch to:
//   a project is selected -> that project, plus a New agent button, since that
//                            is the action belonging to a project
//   otherwise             -> "Default Workspace", where project-less sessions live
//
// The working directory lost the title and kept the tooltip. It used to be the
// title in Sessions mode, but the switcher cannot select a directory, so a folder
// name there would have left the trigger's text disagreeing with the option marked
// active in its own menu.
//
// Neither collapses to empty — a blank title bar would just trade the
// duplication for a layout jump.

const CONVERSATION = {
  hasWorkspace: true,
  activeThreadId: "t-1",
  viewingConversation: true,
  threadLabel: "Dry run git rewrite",
  workspaceName: "agent-relay",
  workspacePath: "/Users/luchi/git/agent-relay",
};

// --- Projects mode ----------------------------------------------------------

test("projects mode names the selected project", () => {
  const { title, newAgentProjectId } = selectHeaderLabels({
    ...CONVERSATION,
    sidebarMode: "projects",
    projectId: "proj-1",
    projectName: "Alpha",
  });
  assert.equal(title, "Alpha");
  // The button is the project's own action, so it rides on the same decision.
  assert.equal(newAgentProjectId, "proj-1");
});

test("projects mode with no project selected is the default workspace", () => {
  const { title, newAgentProjectId } = selectHeaderLabels({
    ...CONVERSATION,
    sidebarMode: "projects",
    projectId: null,
    projectName: "",
  });
  assert.equal(title, DEFAULT_WORKSPACE_LABEL);
  assert.equal(newAgentProjectId, null, "no project means no project action");
});

// --- Sessions mode ----------------------------------------------------------

test("sessions mode is the default workspace, and keeps the folder as the tooltip", () => {
  const { title, titleTooltip, newAgentProjectId } = selectHeaderLabels({
    ...CONVERSATION,
    sidebarMode: "sessions",
  });
  assert.equal(title, DEFAULT_WORKSPACE_LABEL);
  // The folder is not lost, it is demoted: the title has to name what the
  // switcher selects, and the full path was never readable at title size anyway.
  assert.equal(titleTooltip, "/Users/luchi/git/agent-relay");
  assert.equal(newAgentProjectId, null);
});

// A selected project must not leak into Sessions mode: there, sessions are
// grouped by folder, and a project name would name the wrong container.
test("sessions mode ignores a selected project", () => {
  const { title, newAgentProjectId } = selectHeaderLabels({
    ...CONVERSATION,
    sidebarMode: "sessions",
    projectId: "proj-1",
    projectName: "Alpha",
  });
  assert.equal(title, DEFAULT_WORKSPACE_LABEL);
  assert.equal(newAgentProjectId, null);
});

// --- the thread label is gone from the title --------------------------------

test("the thread label never becomes the title (that is the tab's job)", () => {
  for (const sidebarMode of ["sessions", "projects"]) {
    const { title } = selectHeaderLabels({ ...CONVERSATION, sidebarMode });
    assert.notEqual(title, "Dry run git rewrite");
  }
});

// --- fallbacks --------------------------------------------------------------

// "Relay console" is gone from the title. A product name is not a place, and this
// element is now a control you click to go somewhere — so it names a destination
// in every state, including the empty one.
test("with nothing selected the title is the default workspace, never a product name", () => {
  for (const args of [
    { hasWorkspace: true, activeThreadId: null },
    { ...CONVERSATION, viewingConversation: false, workspaceName: "" },
    {},
  ]) {
    assert.equal(selectHeaderLabels(args).title, DEFAULT_WORKSPACE_LABEL);
  }
});

// The trigger's text must match the option marked active in its own menu. That is
// only true if "no project selected" produces exactly one string, whatever else
// is going on.
test("every project-less state produces the SAME title", () => {
  const titles = new Set(
    [
      { hasWorkspace: true, activeThreadId: null },
      { ...CONVERSATION, sidebarMode: "sessions" },
      { ...CONVERSATION, sidebarMode: "projects", projectName: "" },
      { ...CONVERSATION, sidebarMode: "sessions", projectId: "p", projectName: "Alpha" },
    ].map((args) => selectHeaderLabels(args).title)
  );
  assert.deepEqual([...titles], [DEFAULT_WORKSPACE_LABEL]);
});

// --- subtitle rules (unchanged) ---------------------------------------------

test("read-only stays a warning, and does not repeat the title", () => {
  const { title, subtitle } = selectHeaderLabels({
    ...CONVERSATION,
    sidebarMode: "sessions",
    viewOnly: true,
  });
  assert.equal(title, DEFAULT_WORKSPACE_LABEL);
  assert.equal(subtitle, "", "a plain read-only session needs no header subtitle");
});

test("read-only + review in progress keeps its distinct wording", () => {
  const { subtitle } = selectHeaderLabels({
    ...CONVERSATION,
    viewOnly: true,
    reviewInProgress: true,
  });
  assert.equal(subtitle, "read-only · review in progress");
});

test("a live conversation has no subtitle", () => {
  assert.equal(selectHeaderLabels({ ...CONVERSATION, sidebarMode: "sessions" }).subtitle, "");
});

test("console home names the running session in the subtitle, without 'live'", () => {
  const { title, subtitle } = selectHeaderLabels({
    hasWorkspace: true,
    activeThreadId: "t-9",
    viewingConversation: false,
    threadLabel: "background job",
  });
  assert.equal(title, DEFAULT_WORKSPACE_LABEL);
  assert.equal(subtitle, "session · background job");
  assert.ok(!subtitle.includes("live"));
});

test("standby / no-workspace subtitles are unchanged", () => {
  assert.equal(selectHeaderLabels({ hasWorkspace: true }).subtitle, "standby");
  assert.equal(selectHeaderLabels({ hasWorkspace: false }).subtitle, "no workspace selected");
});
