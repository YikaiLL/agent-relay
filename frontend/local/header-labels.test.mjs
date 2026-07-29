import test from "node:test";
import assert from "node:assert/strict";

import { selectHeaderLabels } from "./header-labels.js";

test("live conversation: label becomes the title, no 'live', no subtitle", () => {
  const { title, subtitle } = selectHeaderLabels({
    hasWorkspace: true,
    activeThreadId: "t-1",
    viewingConversation: true,
    viewOnly: false,
    threadLabel: "Dry run git rewrite",
  });
  assert.equal(title, "Dry run git rewrite");
  assert.equal(subtitle, "");
});

test("read-only conversation: warning kept, label NOT repeated (it's the title)", () => {
  const { title, subtitle } = selectHeaderLabels({
    hasWorkspace: true,
    activeThreadId: "t-1",
    viewingConversation: true,
    viewOnly: true,
    threadLabel: "card-overview redesign",
  });
  assert.equal(title, "card-overview redesign");
  assert.equal(subtitle, "read-only · saved session");
});

test("read-only + review in progress keeps its distinct wording", () => {
  const { subtitle } = selectHeaderLabels({
    activeThreadId: "t-1",
    viewingConversation: true,
    viewOnly: true,
    reviewInProgress: true,
    threadLabel: "x",
  });
  assert.equal(subtitle, "read-only · review in progress");
});

test("never surfaces the workspace basename as the title", () => {
  // No conversation open → product name, not the workspace folder ("agent-relay").
  const { title } = selectHeaderLabels({ hasWorkspace: true, activeThreadId: null });
  assert.equal(title, "Relay console");
  assert.notEqual(title, "agent-relay");
});

test("console home with a session running elsewhere names it without 'live'", () => {
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

test("standby vs no workspace", () => {
  assert.equal(selectHeaderLabels({ hasWorkspace: true }).subtitle, "standby");
  assert.equal(selectHeaderLabels({ hasWorkspace: false }).subtitle, "no workspace selected");
});
