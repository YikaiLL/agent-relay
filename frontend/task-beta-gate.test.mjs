// The beta gate for the Task screen: fail closed, and render NO real run data
// while locked. Blur is cosmetic (devtools strips it), so the invariant worth
// testing is that real titles never reach the DOM at all.

import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { betaFeaturesEnabled, tasksLocked } from "./shared/beta-gate.js";
import { TaskSidebarList, TaskTeamScreen } from "./shared/task-team-react.js";

const SECRET_TITLE = "Rewrite the parser";

function runs() {
  return [
    {
      team_run_id: "team-1",
      title: SECRET_TITLE,
      status: "running",
      phase: "build",
      target_ref: "main",
      branch: "task/rewrite-the-parser",
      sub_tasks: [],
      unresolved: [],
      seats: {},
    },
  ];
}

test("the gate fails closed on anything that does not explicitly enable beta", () => {
  assert.equal(betaFeaturesEnabled({ beta_features_enabled: true }), true);
  assert.equal(betaFeaturesEnabled({ beta_features_enabled: false }), false);
  // A snapshot predating the field must read as locked.
  assert.equal(betaFeaturesEnabled({}), false);
  assert.equal(betaFeaturesEnabled(null), false);
  assert.equal(betaFeaturesEnabled(undefined), false);
  // Truthy-but-not-true must not unlock it: this is JSON off a wire.
  assert.equal(betaFeaturesEnabled({ beta_features_enabled: "1" }), false);
  assert.equal(betaFeaturesEnabled({ beta_features_enabled: 1 }), false);

  assert.equal(tasksLocked({ beta_features_enabled: true }), false);
  assert.equal(tasksLocked({}), true);
  assert.equal(tasksLocked(null), true);
});

test("a locked Task screen shows the in-development notice, not the real run", () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskTeamScreen, {
      locked: true,
      runs: runs(),
      selectedRunId: "team-1",
    })
  );
  assert.ok(
    html.includes("task-locked"),
    "the locked screen should render the locked preview wrapper"
  );
  assert.match(html, /in development|building this/i);
  assert.ok(
    !html.includes(SECRET_TITLE),
    "a locked screen must not render real run titles — blur is cosmetic, absence is the gate"
  );
});

test("a locked Task screen hides the placeholder from assistive tech", () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskTeamScreen, { locked: true, runs: [], selectedRunId: null })
  );
  // A screen reader announcing the fake titles would be a lie, not a preview.
  assert.match(html, /aria-hidden="true"/);
});

test("an unlocked Task screen is untouched by the gate", () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskTeamScreen, {
      locked: false,
      runs: runs(),
      selectedRunId: "team-1",
    })
  );
  assert.ok(html.includes(SECRET_TITLE));
  assert.ok(!html.includes("task-locked"));
});

test("the locked sidebar list offers no way to start a task", () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskSidebarList, {
      locked: true,
      runs: runs(),
      selectedRunId: null,
    })
  );
  assert.ok(
    !html.includes("New task"),
    "a locked build must not offer an action the server will refuse"
  );
  assert.ok(!html.includes(SECRET_TITLE));
  assert.ok(html.includes("task-locked"));
});

test("the unlocked sidebar list still offers the start action", () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskSidebarList, {
      locked: false,
      runs: runs(),
      selectedRunId: null,
    })
  );
  assert.ok(html.includes("New task"));
  assert.ok(html.includes(SECRET_TITLE));
});
