// Tombstones for sessions this browser archived or deleted.
//
// Browser history entries outlive threads: a `?thread=<id>` entry survives the
// session it names, so back/forward can land on one that no longer exists. Without a
// tombstone the navigation handler helpfully re-opens a tab for a dead session.
//
// Persisted because the same history entries survive a reload — an in-memory set is
// empty again on the next page load, exactly when the stale entries are still there.
// Note this is per-browser-profile: another window shares it, a different profile
// does not, which matches how the history it guards is scoped.
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
 */
export function rememberRemovedThreadId(threadId, existing = null) {
  if (!threadId) {
    return existing || loadRemovedThreadIds();
  }

  const current = existing || loadRemovedThreadIds();
  const next = [...current.filter((id) => id !== threadId), threadId].slice(-MAX_TOMBSTONES);

  const store = storage();
  if (store) {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota or private-mode failures are non-fatal; the caller keeps its in-memory
      // copy for this page load.
    }
  }
  return next;
}
