// Rules for a user-chosen session title, shared by every surface so local, remote and
// the relay agree on what a rename MEANS before one is ever sent.
//
// The title a tab shows is normally the provider's, and the provider keeps re-deriving
// it as the conversation grows — that drift is the whole reason this feature exists. A
// rename installs a relay-side override that wins from then on; clearing the override is
// the only way back to the auto title. Both surfaces therefore need to express two
// different things ("call it X" and "stop overriding"), which is why every helper here
// is `string | null` rather than plain string.

/**
 * Longest accepted title, in Unicode CODE POINTS. Mirrors `MAX_THREAD_NAME_CHARS` in
 * state/app/threads.rs, which counts with `chars().count()` — i.e. scalar values, not
 * UTF-16 code units. `String.prototype.slice` counts code units, so cutting with it
 * disagrees with the relay on any string containing astral characters (emoji, many CJK
 * extensions) and can slice a surrogate PAIR in half, producing a lone surrogate that is
 * not valid UTF-8 on the wire.
 */
export const MAX_THREAD_NAME_CHARS = 96;

/**
 * Normalize raw input into what will actually be stored.
 *
 * Blank in any form — empty, whitespace, `null`, `undefined` — normalizes to `null`,
 * i.e. RESET. Storing a blank title would leave a nameless tab, which is strictly worse
 * than the provider's own guess, so "clear it" is the only sensible reading of a name
 * the user erased.
 *
 * @param {unknown} value
 * @returns {string|null} the title to store, or null to fall back to the agent's own
 */
export function normalizeThreadName(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  // Spread, not `slice`: iterating a string yields code points, so this counts the same
  // units the relay does and can never split a surrogate pair.
  const points = [...trimmed];
  return points.length > MAX_THREAD_NAME_CHARS
    ? points.slice(0, MAX_THREAD_NAME_CHARS).join("")
    : trimmed;
}

/**
 * Whether submitting `next` would actually change anything.
 *
 * Both surfaces call this before dispatching: a rename that changes nothing still costs
 * a round trip and, server-side, would be a no-op that deliberately does not bump
 * `threads_revision` — so sending it just makes the UI look like it did something.
 *
 * @param {unknown} next raw input from the editor
 * @param {string|null|undefined} current the session's CURRENT override (not its
 *   displayed title — a session showing the provider's name has no override at all)
 */
export function threadNameChanged(next, current) {
  return normalizeThreadName(next) !== normalizeThreadName(current);
}

/**
 * The value an edit box should open with.
 *
 * Deliberately seeded from the DISPLAYED title, not the override: a session that has
 * never been renamed shows the provider's name, and opening an empty box there would
 * make "rename" feel like "retype from scratch". Editing from what you can see is what
 * every other rename in the app does.
 *
 * The wrinkle is that what you can see may have been shortened in transit. A USER's title
 * never is — `MAX_THREAD_NAME_CHARS` is pinned to the smallest wire budget for exactly
 * that reason — but the relay puts no such cap on the PROVIDER's own titles, and Claude
 * derives one from the first prompt, which is easily longer. Confirming the prompt would
 * then persist the compacted string, ellipsis and all, as the user's deliberate choice.
 *
 * Nothing client-side can recover the tail (it never arrived), so this does the one
 * honest thing available: drop the marker so a display artefact cannot become part of a
 * stored name. The detection is exact, not a guess — see `wasCompacted`.
 *
 * @param {{name?: string|null, preview?: string, renamed?: boolean}|null|undefined} thread
 * @param {string} fallback shown when the session has neither a name nor a preview
 */
export function threadNameDraft(thread, fallback = "") {
  const name = thread?.name;
  if (name && !thread?.renamed && wasCompacted(name)) {
    return name.slice(0, -1).trimEnd();
  }
  return name || thread?.preview || fallback || "";
}

/**
 * Whether the relay shortened this title on its way here.
 *
 * Precise rather than "ends with an ellipsis": that blunt test renamed a session the user
 * had deliberately called `Waiting…` to `Waiting`. Compaction leaves a signature it cannot
 * fake — the result is EXACTLY the budget long and ends in the marker — and callers only
 * consult this for titles the relay says are not the user's (`renamed === false`), so a
 * user-typed name of any length is out of reach of it.
 */
function wasCompacted(name) {
  return name.endsWith("…") && [...name].length === MAX_THREAD_NAME_CHARS;
}

/**
 * The session's CURRENT user-chosen title, or null when it is still showing the agent's.
 *
 * The wire carries `renamed` (a flag) rather than a second copy of the title, because
 * whenever an override exists it IS `name` — see `ThreadSummaryView::renamed`. This
 * reassembles the override from the pair, so callers never have to know that.
 */
export function threadCustomName(thread) {
  return thread?.renamed ? (thread.name ?? null) : null;
}

/**
 * Write a rename onto a thread row in place — the optimistic update, and again when the
 * server's receipt arrives.
 *
 * Both fields move together: `name` is what every surface renders, `renamed` is how the
 * NEXT rename tells an override from the agent's own guess, and leaving that stale would
 * make an immediate second rename look like a no-op.
 *
 * The asymmetry is deliberate and load-bearing. A rename bumps `threads_revision`, which
 * makes this same client refetch the thread list — so three writes race for this row:
 * this optimistic one, the refetched row, and this function again with the receipt. On a
 * RESET the client has no copy of the agent's own title (the override overwrote it), so
 * writing `name = null` on the late receipt would wipe whatever the refetch had already
 * delivered, with no further revision bump to correct it. Leaving `name` alone instead
 * means the removed title lingers for at most one round trip — and never blanks the tab.
 *
 * @param {object|null|undefined} row  a thread row; a missing one is a no-op (the
 *   session may have been closed or deleted mid-rename)
 * @param {string|null} customName  the new override, or null to clear it
 */
export function applyRenameToRow(row, customName) {
  if (!row) {
    return;
  }
  row.renamed = Boolean(customName);
  if (customName) {
    row.name = customName;
  }
}
