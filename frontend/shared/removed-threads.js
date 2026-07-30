// Tombstones for sessions this browser archived or deleted.
//
// Browser history entries outlive threads: a `?thread=<id>` entry survives the
// session it names, so navigating (or launching) onto one can land on a session that
// no longer exists. Without a tombstone the navigation handler helpfully re-opens a
// tab for a dead session.
//
// Persisted because the same history entries survive a reload — an in-memory set is
// empty again on the next page load, exactly when the stale entries are still there.
//
// Reads go to storage EVERY time rather than caching: a cached copy loaded at page
// init never learns about a deletion made in another window, which is precisely the
// case a shared store is supposed to cover. Checks happen on navigation, so the cost
// of a parse is irrelevant.
//
// What this does and does not guarantee: any window of the same profile sees a
// tombstone as soon as it looks (no event plumbing needed). Writes are
// read-merge-write over a shared key, so two windows deleting different sessions in
// the same instant could still have one entry lose the race; the consequence is
// bounded to one stale tombstone, i.e. one dead tab that can be closed by hand.
//
// Bounded and fail-soft, like the other prefs modules: storage being unavailable,
// full, or corrupt degrades to "no tombstones" and never throws.

const STORAGE_KEY = "sealwire:removed-threads";
// Generous enough to cover any realistic run of deletions in one profile, small
// enough that the entry stays tiny. Oldest ids fall off first; the risk of dropping
// one is only that a very old history entry could re-open a tab.
const MAX_TOMBSTONES = 200;

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadRemovedThreadIds() {
  const store = storage();
  if (!store) {
    return [];
  }
  try {
    const parsed = JSON.parse(store.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string" && id) : [];
  } catch {
    return [];
  }
}

/**
 * Record `threadId` as removed and return the resulting id list (newest last).
 * Re-recording an id moves it to the newest slot rather than duplicating it.
 *
 * Merges against a fresh read so a concurrent deletion in another window is kept
 * rather than overwritten wholesale.
 */
export function rememberRemovedThreadId(threadId) {
  if (!threadId) {
    return loadRemovedThreadIds();
  }

  const next = [
    ...loadRemovedThreadIds().filter((id) => id !== threadId),
    threadId,
  ].slice(-MAX_TOMBSTONES);

  const store = storage();
  if (store) {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota or private-mode failures are non-fatal; the caller's in-session
      // fallback still covers this page load.
    }
  }
  return next;
}

/**
 * Is this session known to be removed?
 *
 * Reads storage fresh so a deletion made in another window is honoured immediately.
 * `sessionFallback` covers the case where storage is unavailable (private mode, quota)
 * and the only record is this page's own in-memory set.
 */
export function isRemovedThreadId(threadId, sessionFallback = null) {
  if (!threadId) {
    return false;
  }
  if (sessionFallback?.has?.(threadId)) {
    return true;
  }
  return loadRemovedThreadIds().includes(threadId);
}
