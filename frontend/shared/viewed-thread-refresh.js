export const VIEWED_THREAD_REFRESH_INTERVAL_MS = 300;

export function shouldRefreshViewedThread({
  elapsedMs,
  historyLoading = false,
  loading = false,
  wasWorking,
  working,
}) {
  if (loading) {
    return false;
  }
  if (wasWorking && !working) {
    return true;
  }
  if (historyLoading) {
    return false;
  }
  return Boolean(working && elapsedMs >= VIEWED_THREAD_REFRESH_INTERVAL_MS);
}

// A terminal snapshot can arrive while an older-history request is in flight.
// Starting the tail request immediately would invalidate that history request's
// generation, so remember the viewed thread and re-run the refresh decision
// once the single history request settles.
export function createViewedThreadRefreshLatch() {
  let deferredThreadId = null;
  return {
    defer(threadId) {
      deferredThreadId = threadId || null;
    },
    take() {
      const threadId = deferredThreadId;
      deferredThreadId = null;
      return threadId;
    },
  };
}
