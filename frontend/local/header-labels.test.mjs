import test from "node:test";
import assert from "node:assert/strict";

import { selectHeaderLabels } from "./header-labels.js";

// THE RULE THIS FILE ENCODES
//
// The header title used to be the THREAD you were viewing. That duplicated the
// session tab strip sitting directly beneath it — the same string twice, one
// above the other. The header now names the CONTAINER instead, so the two lines
// answer different questions: the header says "where am I", the tab says "which
// session".
//
// Which container depends on how you are browsing:
//   Projects mode -> the selected project, plus a New agent button, since that
//                    is the action that belongs to a project
//   Sessions mode -> the folder the session lives in; sessions are grouped by
//                    working directory there, so the folder IS the container
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

test("projects mode with no project selected falls back to the folder", () => {
  const { title, newAgentProjectId } = selectHeaderLabels({
    ...CONVERSATION,
    sidebarMode: "projects",
    projectId: null,
    projectName: "",
  });
  assert.equal(title, "agent-relay");
  assert.equal(newAgentProjectId, null, "no project means no project action");
});

// --- Sessions mode ----------------------------------------------------------

test("sessions mode names the folder the session lives in", () => {
  const { title, titleTooltip, newAgentProjectId } = selectHeaderLabels({
    ...CONVERSATION,
    sidebarMode: "sessions",
  });
  assert.equal(title, "agent-relay");
  // The basename is what stays readable at title size; the full path is the
  // tooltip, so nothing is actually lost.
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
  assert.equal(title, "agent-relay");
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

test("outside a conversation, with nothing to name, the product name stands in", () => {
  assert.equal(
    selectHeaderLabels({ hasWorkspace: true, activeThreadId: null }).title,
    "Relay console"
  );
  assert.equal(
    selectHeaderLabels({ ...CONVERSATION, viewingConversation: false, workspaceName: "" }).title,
    "Relay console"
  );
});

// --- subtitle rules (unchanged) ---------------------------------------------

test("read-only stays a warning, and does not repeat the title", () => {
  const { title, subtitle } = selectHeaderLabels({
    ...CONVERSATION,
    sidebarMode: "sessions",
    viewOnly: true,
  });
  assert.equal(title, "agent-relay");
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
  assert.equal(title, "Relay console");
  assert.equal(subtitle, "session · background job");
  assert.ok(!subtitle.includes("live"));
});

test("standby / no-workspace subtitles are unchanged", () => {
  assert.equal(selectHeaderLabels({ hasWorkspace: true }).subtitle, "standby");
  assert.equal(selectHeaderLabels({ hasWorkspace: false }).subtitle, "no workspace selected");
});
