// Composer failures, keyed by the thread they belong to. Shared by both
// surfaces so they cannot drift apart on semantics that are entirely about
// timing.
//
// Why per-thread and not "the most recent failure": every operation that
// touches this races with navigation. A send takes its target thread as an
// argument precisely so it survives the user switching sessions, and settings
// updates have no navigation lock either. With one shared slot, each of those
// timings is its own bug — a failure painted on the wrong session, or a
// success on thread A silencing the real failure on thread B. Keyed by thread,
// an operation on A can only ever touch A's entry, and the reader shows the
// entry for the thread on screen.
//
// The stored text is the relay's own `error.message`, verbatim. It names the
// thread and the reason; paraphrasing it into "Send failed" is the information
// loss this exists to undo.
//
// All functions are pure and return a NEW map: the remote surface keeps this in
// its patched state object, where in-place mutation would not re-render.

/**
 * How many threads' failures to keep. The local shell is a long-lived page, so
 * an unbounded map grows once per failing thread for the life of the tab. Only
 * the thread on screen is ever read, so evicting the oldest costs nothing that
 * a later attempt does not recompute.
 */
export const MAX_TRACKED_COMPOSER_ERRORS = 20;

/**
 * @param {Record<string, string> | null | undefined} errors
 * @param {string | null} threadId
 * @param {string} message empty/blank drops the entry
 * @returns {Record<string, string>}
 */
export function withThreadError(errors, threadId, message) {
  const next = { ...(errors || {}) };
  if (!threadId) {
    return next;
  }
  const text = String(message ?? "").trim();
  // Delete first either way: re-inserting moves the key to the end, which is
  // what makes insertion order a usable recency order for eviction below.
  delete next[threadId];
  if (!text) {
    return next;
  }
  next[threadId] = text;
  const keys = Object.keys(next);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_TRACKED_COMPOSER_ERRORS))) {
    delete next[stale];
  }
  return next;
}

/** @returns {Record<string, string>} */
export function withoutThreadError(errors, threadId) {
  return withThreadError(errors, threadId, "");
}

/** @returns {string} the failure to show for `threadId`, or "" when it has none */
export function threadError(errors, threadId) {
  if (!threadId) {
    return "";
  }
  return errors?.[threadId] || "";
}
