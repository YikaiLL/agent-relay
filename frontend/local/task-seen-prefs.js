// Which finished tasks you have already read, persisted client-side
// (localStorage). Fails soft: storage unavailable or corrupt degrades to "nothing
// read", never throws.
//
// Only REPORTS are discharged this way — a terminal task with no action left. A
// task still asking for something (`awaiting_user`, `blocked`) is never dismissed
// by being looked at; see `teamNeedsYouNow`.
//
// Client-side and desktop-only on purpose, matching `project-overview-prefs.js`:
// a server-persisted, cross-device version is a deliberate follow-up, and the
// worst case here is a badge that reappears on another machine — not lost work.

const KEY = "sealwire:tasks-seen";
// Bounded so a long-lived relay cannot grow this without limit. The relay itself
// retains at most MAX_WORKFLOW_RUNS runs, so anything beyond that is for runs
// that no longer exist.
const MAX_ENTRIES = 200;

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null; // access itself can throw (privacy mode, disabled storage)
  }
}

/** `{ [teamRunId]: updatedAtWhenRead }`. Always an object, never null. */
export function loadSeenTasks() {
  const store = storage();
  if (!store) {
    return {};
  }
  try {
    const parsed = JSON.parse(store.getItem(KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const clean = {};
    for (const [id, at] of Object.entries(parsed)) {
      if (typeof id === "string" && id && Number.isFinite(at)) {
        clean[id] = at;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

/**
 * Record that a task has been read at the revision it is currently at.
 *
 * Stores `updated_at` rather than a flag, so a settled run that moves afterwards
 * (a late report write, a resolve that re-settles it) asks again. Returns the new
 * map so the caller can render from it without a re-read.
 */
export function markTaskSeen(teamRunId, updatedAt) {
  const seen = loadSeenTasks();
  if (!teamRunId || !Number.isFinite(updatedAt)) {
    return seen;
  }
  if (seen[teamRunId] === updatedAt) {
    return seen;
  }
  seen[teamRunId] = updatedAt;

  let entries = Object.entries(seen);
  if (entries.length > MAX_ENTRIES) {
    // Drop the oldest read receipts. Losing one only means a finished task badges
    // once more; keeping every id forever is the worse trade.
    entries = entries.sort((left, right) => right[1] - left[1]).slice(0, MAX_ENTRIES);
  }
  const next = Object.fromEntries(entries);

  const store = storage();
  if (store) {
    try {
      store.setItem(KEY, JSON.stringify(next));
    } catch {
      // Quota / unavailable — the in-memory answer above already reflects the
      // read this session; losing persistence is acceptable, throwing is not.
    }
  }
  return next;
}
