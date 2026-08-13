import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TaskDetail } from "./shared/task-team-react.js";

// A sub-task finishing and a sub-task being FOLDED INTO THE RUN are two
// different events, and only the first one is visible today.
//
// `teamRunProgress` counts a sub-task as done when its status is terminal
// (task-team-model.js:194-203 — done / escalated / failed / skipped). But the
// run only advances out of the sub-task phase when every sub-task is
// `digested` (state/app/team.rs:2488-2492: the TL is told how it went, and
// `sub_tasks.iter().all(|t| t.digested)` flips the phase to MrGate).
//
// So a run can legitimately sit showing "3/3 sub-tasks" while nothing appears
// to happen, because it is waiting on the team lead to read the results. The
// row for a finished-but-undigested sub-task is currently pixel-identical to
// one that is fully folded in, so there is nothing on screen that explains the
// wait. `digested` reaches the client (protocol.rs:2621) and the frontend
// ignores it completely.
//
// This surfaces exactly that state and nothing more: no invented progress
// fraction (there is no max_rounds anywhere in the team views — the three
// `max_rounds` fields in protocol.rs belong to RequestReviewInput,
// StartWorkflowInput and ReviewJobView), and no elapsed time (TeamSubTaskView
// carries no timestamps at all).

function subTask(overrides = {}) {
  return {
    id: "s1",
    title: "Write the parser",
    status: "implementing",
    rounds_used: 0,
    digested: false,
    result_summary: null,
    dev_thread_id: "dev-1",
    reviewer_thread_id: "rev-1",
    ...overrides,
  };
}

function run(subTasks) {
  return {
    team_run_id: "run-1",
    title: "Bridge Cursor over ACP",
    status: "running",
    phase: "sub_tasks",
    branch: "task/cursor-acp",
    sub_tasks: subTasks,
    awaiting: null,
    unresolved: [],
  };
}

function render(subTasks) {
  return renderToStaticMarkup(
    React.createElement(TaskDetail, { run: run(subTasks), onOpenThread: () => {} })
  );
}

test("a finished sub-task the run has not folded in yet says so", () => {
  const markup = render([subTask({ status: "done", digested: false })]);
  assert.match(
    markup,
    /task-subtask-digest/,
    "a terminal-but-undigested sub-task must show why the run has not moved on"
  );
});

test("the marker does not blame the team lead", () => {
  // `digested` flips only after BOTH the lead read-out AND the worktree
  // checkpoint commit (team.rs:2451-2492), and skipped sub-tasks never involve
  // the lead at all. An earlier version of this label said "awaiting lead",
  // which is wrong for a skipped task and wrong for any task whose lead turn
  // has finished but whose commit is still running.
  const markup = render([subTask({ status: "done", digested: false })]);
  // Scoped to the chip itself. A bare /lead/i over the whole markup matches the
  // team diagram's "Team lead" seat card and would pass regardless of what this
  // label says.
  const chip = markup.match(/<span class="task-subtask-digest"[^>]*>[^<]*<\/span>/);
  assert.ok(chip, "expected the digest chip to render");
  assert.doesNotMatch(
    chip[0],
    /lead/i,
    "the label must describe the run's state, not attribute the wait to a role"
  );
});

test("a fully absorbed sub-task carries no pending marker", () => {
  const markup = render([subTask({ status: "done", digested: true })]);
  assert.doesNotMatch(markup, /task-subtask-digest/);
});

test("a sub-task still being worked on carries no marker", () => {
  // `digested` is false for the whole of a sub-task's working life. Keying the
  // marker off that flag alone would put "waiting for the lead" on every row
  // from the moment the run starts, which is both wrong and noisy.
  const markup = render([subTask({ status: "implementing", digested: false })]);
  assert.doesNotMatch(markup, /task-subtask-digest/);
});

test("every terminal status can hold the run open, including skipped", () => {
  // The MrGate transition needs `all(|t| t.digested)`, and the checkpoint
  // commit that sets `digested` runs for EVERY terminal sub-task — including
  // skipped ones, which take the commit path while skipping the lead turn
  // (team.rs:2459-2482). So all four terminal statuses can be the one holding
  // an apparently-finished run in place.
  for (const status of ["done", "escalated", "failed", "skipped"]) {
    const markup = render([subTask({ id: `s-${status}`, status, digested: false })]);
    assert.match(markup, /task-subtask-digest/, `${status} should be able to hold the run`);
  }
});
