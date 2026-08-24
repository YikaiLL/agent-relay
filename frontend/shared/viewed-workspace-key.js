// Identity of the workspace a surface is looking at. Birth `current_cwd` does
// not move when a session is observed in another tree, so the remembered
// pin/proven path has to ride along — otherwise an open Changes panel keeps
// showing the previous tree until the user refreshes.
//
// `workspacesRevision` is the snapshot cache key for ANY thread's proven/pin
// change. The local surface keeps `state.session` as the real active session
// while viewing another thread, so that thread's proven path is not on the
// snapshot; the revision is what lets an already-open panel notice.
export function viewedWorkspaceKey({
  threadId,
  currentCwd,
  threadWorkspaceCwd,
  workspacesRevision,
}) {
  return JSON.stringify([
    threadId || "",
    currentCwd || "",
    threadWorkspaceCwd || "",
    workspacesRevision || 0,
  ]);
}

export function sessionViewedWorkspaceKey(session, threadId) {
  return viewedWorkspaceKey({
    threadId,
    currentCwd: session?.current_cwd,
    threadWorkspaceCwd: session?.thread_workspace_cwd,
    workspacesRevision: session?.thread_workspaces_revision,
  });
}

// Local view-only: the pin holds the viewed thread's own cwd, but a background
// observation does not rewrite the pin. Include the snapshot revision so the
// Changes store still refetches for thread A while B is active.
export function localViewedWorkspaceKey({ session, viewThreadId, viewOnlyThread }) {
  const pin = viewOnlyThread;
  if (pin && viewThreadId && pin.threadId === viewThreadId) {
    return viewedWorkspaceKey({
      threadId: viewThreadId,
      currentCwd: pin.cwd,
      threadWorkspaceCwd: pin.threadWorkspaceCwd,
      workspacesRevision: session?.thread_workspaces_revision,
    });
  }
  return sessionViewedWorkspaceKey(session, viewThreadId);
}
