import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TaskDetail,
  TaskSidebarList,
  TaskTeamScreen,
  TaskWelcome,
  TeamDiagram,
} from "./task-team-react.js";

const h = React.createElement;

function run(overrides = {}) {
  return {
    team_run_id: "team-1",
    title: "Add a parser",
    status: "running",
    phase: "sub_tasks",
    cwd: "/tmp/wt",
    branch: "task/add-a-parser",
    target_ref: "refs/heads/main",
    tl_thread_id: "tl-1",
    tl_generations: 1,
    sub_tasks: [],
    awaiting: null,
    unresolved: [],
    updated_at: 100,
    ...overrides,
  };
}

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

test("with no tasks the main area explains what a task IS, not just that there are none", () => {
  // The sidebar already says the list is empty. What this space is for is the one
  // thing a list cannot say, to someone who has never started one.
  const html = renderToStaticMarkup(h(TaskWelcome, { runs: [] }));
  assert.match(html, /Start a task/);
  assert.match(html, /own git worktree/);
  assert.match(html, /Team lead/);
  assert.match(html, /Reviewer/);
  assert.match(html, /New task/);
});

test("with tasks but none selected the main area points at the list", () => {
  const html = renderToStaticMarkup(h(TaskWelcome, { runs: [run()] }));
  assert.match(html, /Pick a task/);
  assert.match(html, /on the left/);
  // The explainer is for first-timers; someone with tasks does not need it again.
  assert.doesNotMatch(html, /Team lead<\/b>/);
});

test("a first load shows a loading state, but a background refresh never blanks it", () => {
  const loadingFirst = renderToStaticMarkup(h(TaskWelcome, { runs: null, loading: true }));
  assert.match(loadingFirst, /Loading tasks/);

  const refreshing = renderToStaticMarkup(
    h(TaskWelcome, { runs: [run({ title: "Still here" })], loading: true })
  );
  assert.doesNotMatch(refreshing, /Loading tasks/);
});

test("an error only takes the screen before the first successful load", () => {
  const cold = renderToStaticMarkup(h(TaskWelcome, { runs: null, error: "relay went away" }));
  assert.match(cold, /Tasks unavailable/);
  assert.match(cold, /relay went away/);

  const warm = renderToStaticMarkup(
    h(TaskWelcome, { runs: [run()], error: new Error("relay went away") })
  );
  assert.doesNotMatch(warm, /Tasks unavailable/);
});

// ---- the sidebar list ------------------------------------------------------

test("a finished task stays in the sidebar list", () => {
  // Its branch is still on disk; a row that vanished is how a user loses track of
  // the work.
  const html = renderToStaticMarkup(
    h(TaskSidebarList, { runs: [run({ status: "cancelled", title: "Abandoned work" })] })
  );
  assert.match(html, /Abandoned work/);
  assert.match(html, /is-terminal/);
});

test("the sidebar marks the open task and only that one", () => {
  const html = renderToStaticMarkup(
    h(TaskSidebarList, {
      runs: [run({ team_run_id: "team-1" }), run({ team_run_id: "team-2" })],
      selectedRunId: "team-2",
    })
  );
  assert.equal((html.match(/is-selected/g) || []).length, 1);
});

test("a sidebar row leads with what the task needs, not with its phase", () => {
  const needs = renderToStaticMarkup(
    h(TaskSidebarList, { runs: [run({ status: "escalated" })] })
  );
  assert.match(needs, /Needs you/);
  assert.match(needs, /is-attention/);

  const working = renderToStaticMarkup(
    h(TaskSidebarList, { runs: [run({ sub_tasks: [subTask(), subTask({ status: "done" })] })] })
  );
  assert.match(working, /1\/2 sub-tasks/);
  assert.doesNotMatch(working, /Needs you/);
});

test("the sidebar always offers New task, even with nothing in it", () => {
  const html = renderToStaticMarkup(h(TaskSidebarList, { runs: [] }));
  assert.match(html, /New task/);
  assert.match(html, /No tasks yet/);
});

test("the diagram renders exactly three seats, in team order", () => {
  const html = renderToStaticMarkup(
    h(TeamDiagram, { run: run({ sub_tasks: [subTask()] }) })
  );
  assert.match(html, /Team lead/);
  assert.match(html, /Developer/);
  assert.match(html, /Reviewer/);
  // Anchored on a word boundary: `team-seat-head` and friends share the prefix.
  assert.equal(html.match(/class="team-seat[ "]/g).length, 3);
  assert.ok(html.indexOf("Team lead") < html.indexOf("Developer"));
  assert.ok(html.indexOf("Developer") < html.indexOf("Reviewer"));
});

test("an unseated role renders a disabled node rather than a dead link", () => {
  const html = renderToStaticMarkup(h(TeamDiagram, { run: run({ phase: "intake" }) }));
  assert.match(html, /Not started/);
  assert.match(html, /disabled=""/);
});

test("clicking a seated node asks to open that seat's thread", () => {
  const opened = [];
  const seats = TeamDiagram({
    run: run({ sub_tasks: [subTask()] }),
    onOpenThread: (id) => opened.push(id),
  });
  // Walk the element tree and fire each node's handler, as a click would.
  for (const node of seats.props.children) {
    const seat = node.type(node.props);
    if (!seat.props.disabled) seat.props.onClick();
  }
  assert.deepEqual(opened, ["tl-1", "dev-1", "rev-1"]);
});

test("there is no per-agent stop anywhere on the diagram", () => {
  // The only stop is the run's; a stop on a seat would be refused by the backend.
  const html = renderToStaticMarkup(
    h(TeamDiagram, { run: run({ sub_tasks: [subTask()] }) })
  );
  assert.doesNotMatch(html, /Stop/);
});

test("a parked question is announced with a way to answer it", () => {
  const html = renderToStaticMarkup(
    h(TaskDetail, {
      run: run({
        status: "awaiting_user",
        awaiting: { thread_id: "dev-1", request_id: "ask:1", role: "dev", asked_at: 1 },
        sub_tasks: [subTask()],
      }),
    })
  );
  assert.match(html, /asked you a question/);
  assert.match(html, /Answer it/);
});

test("the detail offers only the actions the backend would accept", () => {
  // Match on the action classes, not the labels: the hint text on Cancel legitimately
  // contains the words "Stop now", so a label-based assertion reads the wrong thing.
  const classesFor = (status) => {
    const html = renderToStaticMarkup(h(TaskDetail, { run: run({ status }) }));
    return (html.match(/task-action is-([a-z]+)/g) || []).map((match) =>
      match.replace("task-action is-", "")
    );
  };

  assert.deepEqual(classesFor("paused"), ["resume", "cancel"]);
  assert.deepEqual(classesFor("blocked"), ["resolve"]);
  assert.deepEqual(classesFor("pause_pending"), ["stop", "cancel"]);
  assert.deepEqual(classesFor("running"), ["pause", "stop", "cancel"]);
  for (const terminal of ["done", "escalated", "failed", "interrupted", "cancelled"]) {
    assert.deepEqual(classesFor(terminal), [], terminal);
  }
});

test("a paused task says the team lead can be talked to", () => {
  // Mirrors the TlWhilePaused gate — that is where a user redirects the work.
  const paused = renderToStaticMarkup(h(TaskDetail, { run: run({ status: "paused" }) }));
  assert.match(paused, /talk to the team lead/);

  const running = renderToStaticMarkup(h(TaskDetail, { run: run({ status: "running" }) }));
  assert.doesNotMatch(running, /talk to the team lead/);
});

test("a task that no longer exists says so instead of rendering an empty shell", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, { runs: [], selectedRunId: "team-gone" })
  );
  assert.match(html, /That task is gone/);
  assert.match(html, /still on disk/);
});

test("a task still loading is not reported as gone", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, { runs: null, selectedRunId: "team-1", loading: true })
  );
  assert.match(html, /Loading task/);
  assert.doesNotMatch(html, /That task is gone/);
});

test("sub-task rounds and summaries surface, but never the brief", () => {
  // The brief is TL-authored instruction for a developer, not status — it is
  // deliberately absent from the payload, and nothing here should imply otherwise.
  const html = renderToStaticMarkup(
    h(TaskDetail, {
      run: run({
        sub_tasks: [
          subTask({ status: "done", rounds_used: 2, result_summary: "Parser landed." }),
        ],
      }),
    })
  );
  assert.match(html, /Parser landed\./);
  assert.match(html, /2 rounds/);
  assert.match(html, /Sub-tasks \(1\/1\)/);
});

test("unresolved notes are listed so the report is not the only place they appear", () => {
  const html = renderToStaticMarkup(
    h(TaskDetail, {
      run: run({ status: "escalated", unresolved: ["Ran out of review rounds on s2"] }),
    })
  );
  assert.match(html, /Unresolved/);
  assert.match(html, /Ran out of review rounds on s2/);
});

test("an action in flight disables the others rather than allowing a second", () => {
  // Scoped to the action buttons: unseated diagram nodes are disabled too, and
  // counting those instead would pass no matter what the actions did.
  const actionsOf = (html) => html.match(/<button[^>]*class="task-action is-[^>]*>/g) || [];

  const idle = renderToStaticMarkup(h(TaskDetail, { run: run({ status: "running" }) }));
  assert.equal(actionsOf(idle).length, 3);
  assert.equal(actionsOf(idle).filter((button) => button.includes("disabled")).length, 0);

  const busy = renderToStaticMarkup(
    h(TaskDetail, { run: run({ status: "running" }), actionPending: "pause" })
  );
  assert.equal(actionsOf(busy).length, 3);
  assert.equal(actionsOf(busy).filter((button) => button.includes("disabled")).length, 3);
});

test("a refused action shows the relay's reason", () => {
  const html = renderToStaticMarkup(
    h(TaskDetail, {
      run: run({ status: "running" }),
      actionError: "this task is blocked; resolve it first",
    })
  );
  assert.match(html, /resolve it first/);
});

test("only a parked question offers a way to answer it", () => {
  // Every wanting-a-person state shares one bucket, so a banner keyed on the
  // BUCKET grows an "Answer it" button on an escalated task — where there is no
  // question, and the button can only be dead.
  const asking = renderToStaticMarkup(
    h(TaskDetail, {
      run: run({
        status: "awaiting_user",
        awaiting: { thread_id: "dev-1", request_id: "ask:1", role: "dev", asked_at: 1 },
      }),
    })
  );
  assert.match(asking, /Answer it/);

  for (const status of ["escalated", "blocked", "failed", "interrupted"]) {
    const html = renderToStaticMarkup(h(TaskDetail, { run: run({ status }) }));
    assert.doesNotMatch(html, /Answer it/, status);
    assert.match(html, /task-banner is-/, `${status} still explains itself`);
  }
});

test("a banner never promises an action the task cannot offer", () => {
  // Every terminal run has no lifecycle buttons at all. Telling the user to
  // "decide what happens next" or "start it again" with nothing to press is
  // worse than telling them where the work ended up — so this loops the same
  // statuses as its sibling rather than trusting one of them to stand in.
  const forbidden = /\b(Start it again|drop it|Decide what happens next|Try again|Retry)\b/i;
  for (const status of ["escalated", "failed", "interrupted"]) {
    const html = renderToStaticMarkup(h(TaskDetail, { run: run({ status, error: null }) }));
    assert.deepEqual(
      html.match(/task-action is-([a-z]+)/g) || [],
      [],
      `${status} offers no actions`
    );
    assert.doesNotMatch(html, forbidden, `${status} must not name one`);
    assert.match(html, /on disk/, `${status} says where the work went`);
  }
});
