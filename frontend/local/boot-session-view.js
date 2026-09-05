// The local surface must establish its session-view route before applying the first
// session snapshot. Applying that snapshot can start Projects reconciliation, whose
// history replace must observe the restored thread rather than the store's initial
// null location.

export async function runLocalBootDataPhase({
  restoreHistory,
  loadSession,
  loadThreads,
  connectSessionStream,
  scheduleThreadsPoll,
  onRestoreError,
}) {
  try {
    await restoreHistory();
  } catch (error) {
    // Session-view persistence is an enhancement, not a prerequisite for the
    // relay data path. A corrupt workspace or blocked IndexedDB open must not
    // suppress the initial snapshot, thread list, stream, or fallback poll.
    try {
      onRestoreError?.(error);
    } catch {
      // Error reporting must not become another boot dependency.
    }
  }
  await loadSession();
  await loadThreads();
  connectSessionStream();
  scheduleThreadsPoll();
}

export function syncProjectsForSession(projectsStore, session) {
  // Route restoration can commit before the first session snapshot exists.
  // There is no meaningful Projects revision yet, and fetching revision zero
  // here only duplicates the request made when loadSession installs the real
  // snapshot moments later.
  if (!session) {
    return;
  }
  projectsStore.syncToRevision(session.projects_revision || 0);
}
