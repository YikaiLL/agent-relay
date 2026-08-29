import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  canStartWorkflow,
  isWorkflowBlocked,
  isWorkflowInProgressForThread,
  isTerminalWorkflowStatus,
  workflowStatusLabel,
} from "./workflow-state.js";

test("workflow activity projection drives locking without full workflow cards", () => {
  const session = {
    active_thread_id: "parent-1",
    workflow_activity: [
      {
        id: "run-activity",
        status: "running",
        parent_thread_id: "parent-1",
        locked_thread_ids: ["parent-1", "reviewer-1"],
      },
    ],
    active_workflow_runs: [],
  };
  assert.equal(isWorkflowInProgressForThread(session, "parent-1"), true);
  assert.equal(isWorkflowInProgressForThread(session, "reviewer-1"), true);
});

test("a capped workflow activity list defers to the viewed thread's exact lock bit", () => {
  const session = {
    active_thread_id: "same-cwd-outside-cap",
    workflow_locked: true,
    workflow_activity: [
      {
        id: "run-activity",
        status: "running",
        parent_thread_id: "parent-1",
        locked_thread_ids: ["parent-1", "same-cwd-inside-cap"],
      },
    ],
  };

  assert.equal(
    isWorkflowInProgressForThread(session, "same-cwd-outside-cap"),
    true,
    "thread_state.workflow_locked remains authoritative when its id is outside the bounded list"
  );
});

import { canRequestReview } from "./review-state.js";
import { WorkflowRunCard, workflowSubmitPayload } from "./workflow-panel.js";

const h = React.createElement;

test("workflowSubmitPayload carries parentThreadId (the viewed thread) to the submit", () => {
  // The shared submit builder (local + remote) must forward the viewed thread so the
  // backend authors on it, mirroring how Request review targets its parent.
  const payload = workflowSubmitPayload({
    taskPrompt: "  do the thing  ",
    reviewerProvider: "codex",
    maxRounds: 3,
    parentThreadId: "thread-viewed",
  });
  assert.equal(payload.parentThreadId, "thread-viewed");
  assert.equal(payload.taskPrompt, "do the thing");
  // Absent → null, so the server falls back to the active thread.
  assert.equal(workflowSubmitPayload({ taskPrompt: "x" }).parentThreadId, null);
});

test("canStartWorkflow gates on the VIEWED thread, like Request review", () => {
  // The active thread is a busy chat, but the user is VIEWING a different, idle
  // thread. Request review is launchable there (it targets the viewed thread), so
  // Code Flow must be too — the two gates must agree on the same thread.
  const session = {
    active_thread_id: "chat-active",
    active_turn_id: "turn-9", // active thread is mid-turn (busy)
    current_status: "active",
    thread_activity: [], // the viewed thread is NOT working
    active_review_jobs: [],
    active_workflow_runs: [],
    pending_approvals: [],
  };
  const viewed = "idle-thread";

  // Review can be requested on the idle viewed thread...
  assert.equal(canRequestReview(session, "device-1", viewed), true);
  // ...so Code Flow must be startable on it too (regression: was gated on the
  // busy ACTIVE thread and returned false).
  assert.equal(canStartWorkflow(session, viewed), true);

  // When the VIEWED thread itself is busy, both are disabled.
  const busyViewed = { ...session, thread_activity: [{ thread_id: viewed }] };
  assert.equal(canRequestReview(busyViewed, "device-1", viewed), false);
  assert.equal(canStartWorkflow(busyViewed, viewed), false);
});

test("blocked workflow runs remain active and keep launch disabled", () => {
  const session = {
    active_thread_id: "parent-1",
    current_status: "idle",
    active_workflow_runs: [{ id: "run-1", status: "blocked", parent_thread_id: "parent-1" }],
  };

  assert.equal(isTerminalWorkflowStatus("blocked"), false);
  assert.equal(isWorkflowBlocked(session), true);
  assert.equal(isWorkflowInProgressForThread(session, "parent-1"), true);
  assert.equal(workflowStatusLabel("blocked"), "Blocked");
  assert.equal(canStartWorkflow(session), false);
});

test("resolving workflow runs remain active and lock their parent", () => {
  const session = {
    active_thread_id: "parent-1",
    current_status: "idle",
    active_workflow_runs: [{ id: "run-1", status: "resolving", parent_thread_id: "parent-1" }],
  };

  assert.equal(isTerminalWorkflowStatus("resolving"), false);
  assert.equal(isWorkflowBlocked(session), false);
  assert.equal(isWorkflowInProgressForThread(session, "parent-1"), true);
  assert.equal(workflowStatusLabel("resolving"), "Resolving");
  assert.equal(canStartWorkflow(session), false);
});

test("workflow lock helper honors server-supplied same-cwd locked thread ids", () => {
  const session = {
    active_thread_id: "sibling-1",
    current_status: "idle",
    active_workflow_runs: [
      {
        id: "run-1",
        status: "running",
        parent_thread_id: "parent-1",
        locked_thread_ids: ["parent-1", "sibling-1"],
      },
    ],
  };

  assert.equal(isWorkflowInProgressForThread(session, "parent-1"), true);
  assert.equal(isWorkflowInProgressForThread(session, "sibling-1"), true);
  assert.equal(isWorkflowInProgressForThread(session, "other-cwd"), false);
  assert.equal(
    isWorkflowInProgressForThread(
      {
        active_workflow_runs: [
          {
            id: "run-2",
            status: "failed",
            parent_thread_id: "parent-1",
            locked_thread_ids: ["sibling-1"],
          },
        ],
      },
      "sibling-1"
    ),
    false
  );
});

test("workflow lock helper honors per-view thread_state workflow lock", () => {
  assert.equal(
    isWorkflowInProgressForThread(
      {
        active_thread_id: "viewed-thread",
        workflow_locked: true,
        active_workflow_runs: [{ id: "run-1", status: "running", parent_thread_id: "other" }],
      },
      "viewed-thread"
    ),
    true
  );
  assert.equal(
    isWorkflowInProgressForThread(
      {
        active_thread_id: "other-thread",
        workflow_locked: true,
        active_workflow_runs: [{ id: "run-1", status: "running", parent_thread_id: "other" }],
      },
      "viewed-thread"
    ),
    false
  );
  assert.equal(
    isWorkflowInProgressForThread(
      { active_thread_id: "viewed-thread", workflow_locked: true, active_workflow_runs: [] },
      "viewed-thread"
    ),
    false,
    "an explicit empty active_workflow_runs snapshot should clear a stale per-view lock"
  );
});

test("WorkflowRunCard renders final negative reviewer findings", () => {
  const html = renderToStaticMarkup(
    h(WorkflowRunCard, {
      run: {
        id: "run-1",
        status: "escalated",
        current_step: "review",
        round: 1,
        last_verdict: {
          approved: false,
          findings: ["Finding A\n\nVERDICT: NEEDS_CHANGES"],
        },
      },
    })
  );

  // A run is work in flight, so its verdict is a trailing detail rather than a headline —
  // the "Verdict:" prefix went with the card treatment that used to wrap it.
  assert.match(html, /workflow-run-verdict[^>]*>Needs changes</);
  assert.match(html, /Finding A/);
  assert.match(html, /VERDICT: NEEDS_CHANGES/);
  // Findings are RAW text, not markdown elements, so the pre-wrap that preserves their
  // blank lines has to live on this class rather than being inherited from the reviewer
  // body (which is real markup and was being double-spaced by it).
  assert.match(html, /class="workflow-run-findings"/);
});

test("WorkflowRunCard renders a recovery action for blocked runs", () => {
  const html = renderToStaticMarkup(
    h(WorkflowRunCard, {
      run: {
        id: "run-1",
        status: "blocked",
        current_step: "execute",
        error: "turn did not confirm stopping",
      },
      onResolveWorkflow() {},
    })
  );

  assert.match(html, /Stop workflow &amp; unlock/);
  assert.match(html, /turn did not confirm stopping/);
});

test("WorkflowRunCard disables the recovery action while resolving", () => {
  const html = renderToStaticMarkup(
    h(WorkflowRunCard, {
      run: {
        id: "run-1",
        status: "resolving",
        current_step: "execute",
      },
      onResolveWorkflow() {},
    })
  );

  assert.match(html, /disabled=""/);
  assert.match(html, /Stopping workflow…/);
});
