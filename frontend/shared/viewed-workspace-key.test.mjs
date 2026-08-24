import test from "node:test";
import assert from "node:assert/strict";

import {
  localViewedWorkspaceKey,
  sessionViewedWorkspaceKey,
  viewedWorkspaceKey,
} from "./viewed-workspace-key.js";

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
