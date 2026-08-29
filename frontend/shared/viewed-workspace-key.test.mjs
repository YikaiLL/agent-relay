import test from "node:test";
import assert from "node:assert/strict";

import {
  decideWorkspaceRefresh,
  localViewedWorkspaceKey,
  sessionViewedWorkspaceKey,
  viewedWorkspaceKey,
} from "./viewed-workspace-key.js";

const turnDiff = (itemId) => ({ item_id: itemId, tool: { item_type: "turnDiff" } });

// The boot refresh runs before any session exists, so it settles blank.
test("the first snapshot counts as a change, because nothing could resolve before it", () => {
  const decision = decideWorkspaceRefresh({
    session: { current_cwd: "/repo", transcript: [] },
    workspaceKey: sessionViewedWorkspaceKey({ current_cwd: "/repo" }, "thread-a"),
    lastWorkspaceKey: null,
    lastTurnDiffId: null,
  });

  assert.equal(decision.refresh, true, "a thread with no turnDiff yet would never resolve");
});

test("an unchanged snapshot with nothing new does not refetch", () => {
  const key = sessionViewedWorkspaceKey({ current_cwd: "/repo" }, "thread-a");
  const decision = decideWorkspaceRefresh({
    session: { current_cwd: "/repo", transcript: [] },
    workspaceKey: key,
    lastWorkspaceKey: key,
    lastTurnDiffId: null,
  });

  assert.equal(decision.refresh, false, "the 12s poll must not become a fetch loop");
});

test("a new turnDiff refetches, and the same one twice does not", () => {
  const key = sessionViewedWorkspaceKey({ current_cwd: "/repo" }, "thread-a");
  const session = { current_cwd: "/repo", transcript: [turnDiff("item-1")] };

  const first = decideWorkspaceRefresh({
    session,
    workspaceKey: key,
    lastWorkspaceKey: key,
    lastTurnDiffId: null,
  });
  assert.equal(first.refresh, true);
  assert.equal(first.turnDiffId, "item-1", "remembered so the next snapshot is a no-op");

  const again = decideWorkspaceRefresh({
    session,
    workspaceKey: key,
    lastWorkspaceKey: key,
    lastTurnDiffId: first.turnDiffId,
  });
  assert.equal(again.refresh, false);
});

test("a workspace change forgets the turnDiff, so the new tree's own diff refetches", () => {
  const decision = decideWorkspaceRefresh({
    session: { current_cwd: "/repo", transcript: [turnDiff("item-1")] },
    workspaceKey: sessionViewedWorkspaceKey({ current_cwd: "/other" }, "thread-b"),
    lastWorkspaceKey: sessionViewedWorkspaceKey({ current_cwd: "/repo" }, "thread-a"),
    lastTurnDiffId: "item-1",
  });

  assert.equal(decision.refresh, true);
  assert.equal(decision.turnDiffId, null, "the previous tree's turn must not suppress the next");
});

test("an observation-only workspace change produces a new identity", () => {
  const threadId = "thread-1";
  const birth = viewedWorkspaceKey({
    threadId,
    currentCwd: "/repo",
    threadWorkspaceCwd: "/repo",
  });
  const observed = viewedWorkspaceKey({
    threadId,
    currentCwd: "/repo",
    threadWorkspaceCwd: "/repo/.worktrees/feature",
  });
  assert.notEqual(
    observed,
    birth,
    "same birth cwd + a new proven tree must not look like the same workspace"
  );
});

test("sessionViewedWorkspaceKey reads the remembered tree off the snapshot", () => {
  const before = sessionViewedWorkspaceKey(
    { current_cwd: "/repo", thread_workspace_cwd: "/repo" },
    "thread-1"
  );
  const after = sessionViewedWorkspaceKey(
    { current_cwd: "/repo", thread_workspace_cwd: "/repo/.worktrees/feature" },
    "thread-1"
  );
  assert.notEqual(after, before);
});

test("local view-only key changes when a background thread's workspace is observed", () => {
  const session = {
    active_thread_id: "thread-b",
    current_cwd: "/b",
    thread_workspace_cwd: "/b",
    thread_workspaces_revision: 1,
  };
  const pin = { threadId: "thread-a", cwd: "/a", threadWorkspaceCwd: "/a" };
  const before = localViewedWorkspaceKey({
    session,
    viewThreadId: "thread-a",
    viewOnlyThread: pin,
  });
  const after = localViewedWorkspaceKey({
    session: { ...session, thread_workspaces_revision: 2 },
    viewThreadId: "thread-a",
    viewOnlyThread: pin,
  });
  assert.notEqual(
    after,
    before,
    "viewing A while B is active must still notice A's observation"
  );
  assert.notEqual(
    before,
    sessionViewedWorkspaceKey(session, "thread-a"),
    "must not key off the active session's tree while a pin is in place"
  );
});
