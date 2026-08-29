// Kept for the callers that still measure elapsed time, and because removing a
// named constant is not the same as removing the behaviour it throttled.
export const VIEWED_THREAD_REFRESH_INTERVAL_MS = 300;

/**
 * Should a viewed (non-active) thread's transcript be refetched?
 *
 * Only when it STOPS working. There used to be a second answer -- every 300ms
 * for as long as it kept working -- and it dated from a relay that streamed
 * only the globally-active thread (pin: 2026-06-11; per-thread streaming:
 * 2026-08-05). Once every watched thread streams, that poll stopped being how
 * the tail arrives and became only a way to overwrite it: each refetch replaced
 * a live tail with a server page built moments earlier, so anything the stream
 * had appended in between disappeared. The reader's own message was the usual
 * casualty, being the newest entry in the pin.
 *
 * The merge no longer discards those entries either (mergeRefreshedViewOnlyPage
 * retains the tail), so this is belt and braces -- but a poll that can only
 * re-assert what the stream already delivered is work with no upside.
 *
 * A delta the reducer REFUSED does not wait for that edge: it sets `tailGap`
 * on the pin, which `needsRepair` reads below. That is what the poll was
 * standing in for, done precisely -- only when there is a hole, and in the
 * frame it appeared rather than three times a second regardless.
 */
export function shouldRefreshViewedThread({
  historyLoading = false,
  loading = false,
  needsRepair = false,
  wasWorking,
  working,
}) {
  if (loading) {
    return false;
  }
  // A delta the reducer REFUSED, reported by the pin rather than left for
  // whatever refreshed next. This is the precise trigger the poll was a blunt
  // stand-in for: it fires only when there is actually a hole, and it fires in
  // the frame the hole appeared instead of at the end of the turn. The
  // conversation has always had its own version of this -- a refused chunk
  // downgrades the entry to `preview`, which re-arms hydration on the next
  // render (transcript-hydration-store.js:829-835).
  if (needsRepair) {
    return true;
  }
  if (wasWorking && !working) {
    return true;
  }
  return false;
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
