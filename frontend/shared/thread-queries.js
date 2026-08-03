export function threadListQueryKey({
  limit = null,
  scope = "default",
  surface,
}) {
  return [
    "thread-list",
    surface,
    scope,
    { limit },
  ];
}

export function threadTranscriptPageQueryKey({
  before = null,
  scope = "default",
  surface,
  threadId,
}) {
  return [
    "thread-transcript",
    surface,
    scope,
    threadId || "",
    before ?? null,
  ];
}

export function createThreadListQueryOptions({
  fetchThreads,
  limit = null,
  scope = "default",
  surface,
}) {
  return {
    queryKey: threadListQueryKey({ limit, scope, surface }),
    queryFn: () => fetchThreads({ limit }),
  };
}

/**
 * Fetch the thread list bypassing the query cache's in-flight de-duplication, and seed
 * the cache with the result.
 *
 * `queryClient.fetchQuery` returns the ALREADY-RUNNING request's promise when one is in
 * flight for the same key (query-core's `Query.fetch` returns its retryer's promise
 * unless `cancelRefetch` is set, and `fetchQuery` never sets it). Normally that
 * coalescing is exactly what you want — boot, the 12s poll and a manual refresh should
 * not become three requests.
 *
 * It is wrong for a refresh triggered by a KNOWN mutation, such as the `threads_revision`
 * bump after a rename. There, the caller needs data that reflects a change made at a
 * specific moment; being handed a response to a request that was issued BEFORE it means
 * silently rendering pre-mutation state. And because the revision has already been
 * consumed by then, nothing retries — the stale title sits there until the next poll.
 *
 * Starting a second request is NOT enough on its own, which is the subtle part. The
 * pre-mutation request stays in flight and keeps owning the cache key, so a routine
 * refresh arriving afterwards dedupes onto IT — and since that refresh is the most recent
 * invocation, the callers' generation guards (which only know invocation order) accept
 * its stale answer and discard the fresh one. Evicting the query first is what stops a
 * later reader from attaching to a request that predates the mutation.
 *
 * Nothing subscribes to this key independently — it is a de-dup layer, not a store — so
 * evicting it is safe; the caller already holds the data it needs. `setQueryData`
 * afterwards re-seeds it so the next reader starts from post-mutation state.
 */
export async function fetchThreadListFresh({
  fetchThreads,
  limit = null,
  queryClient = null,
  scope = "default",
  surface,
}) {
  const queryKey = threadListQueryKey({ limit, scope, surface });
  // Before the request, so nothing that arrives while it runs can join the old one.
  queryClient?.removeQueries({ queryKey, exact: true });
  const threads = await fetchThreads({ limit });
  queryClient?.setQueryData(queryKey, threads);
  return threads;
}

export function createThreadTranscriptPageQueryOptions({
  before = null,
  fetchPage,
  scope = "default",
  surface,
  threadId,
}) {
  return {
    queryKey: threadTranscriptPageQueryKey({
      before,
      scope,
      surface,
      threadId,
    }),
    queryFn: () => fetchPage({
      before,
      threadId,
    }),
  };
}
