// The bell: filter the session list down to what is actually going on.
//
// It is a FILTER, not a second page. The list has one source of truth and the bell
// narrows it — which is the whole reason it can be composed with search, and the reason
// there is never a second place showing "the same sessions but different".
//
// Buckets come from `selectThreadState`, the same ladder the per-row dot uses, so a row
// showing an amber dot is necessarily in the "Needs input" bucket. Idle threads have no
// state and no bucket: the bell shows everything that is NOT idle.

import { THREAD_STATES, THREAD_STATE_LABELS, selectThreadState } from "./thread-dot.js";

/** All four states selected — the bell's default and its most useful setting. */
export const EMPTY_THREAD_FILTER = Object.freeze({
  on: false,
  states: THREAD_STATES,
  retained: Object.freeze({}),
});

export function isThreadFilterActive(filter) {
  return Boolean(filter?.on);
}

function selectedStates(filter) {
  const states = (filter?.states || []).filter((state) => THREAD_STATES.includes(state));
  return states.length ? states : THREAD_STATES;
}

function flattenThreads(groups) {
  return (groups || []).flatMap((group) => group?.threads || []);
}

/**
 * How many threads sit in each state, across the whole (unfiltered) list.
 *
 * Drives the popover's per-state counts, so those must be computed BEFORE the filter is
 * applied — a pill reading "Working 3" has to keep saying 3 while you are looking at
 * only "Needs input", or the control cannot tell you what selecting it would give you.
 */
export function summarizeThreadStates(groups, stateOf) {
  const counts = { needs_input: 0, working: 0, reviewing: 0, completed: 0, total: 0 };
  for (const thread of flattenThreads(groups)) {
    const state = stateOf(thread);
    if (state && state in counts) {
      counts[state] += 1;
      counts.total += 1;
    }
  }
  return counts;
}

/**
 * The monotonic retention map: thread id → the state it was last seen in.
 *
 * A row must not vanish from under the pointer because the agent answered while you were
 * reaching for it. So membership only ever GROWS while a filter is on: a thread that has
 * matched once stays listed until the filter is turned off or its selection changes.
 *
 * It remembers the STATE, not just the id, because a thread can leave the ladder
 * entirely. The sharpest case is the one the user is most likely to be watching: a
 * thread that finishes while you are looking at it gets no `completed` badge at all
 * (`thread-attention.js` drops the badge for the viewed foreground thread), so it goes
 * working → stateless. With only an id to go on there would be no bucket to keep it in
 * and the row would vanish anyway.
 *
 * New matches join live — that half must stay immediate, or the bell would show a
 * snapshot of the past rather than what is going on.
 *
 * Returns the next map; callers keep it on the filter and pass it back in.
 */
export function nextRetainedStates(previous, groups, filter, stateOf) {
  if (!isThreadFilterActive(filter)) {
    return {};
  }
  const states = selectedStates(filter);
  const next = { ...(previous || {}) };
  for (const thread of flattenThreads(groups)) {
    const state = thread?.id ? stateOf(thread) : null;
    if (state && states.includes(state)) {
      next[thread.id] = state;
    }
  }
  return next;
}

/**
 * Re-bucket the list by state, dropping idle threads and anything outside the selection.
 *
 * Groups come back in the ladder's order — not by recency — because that order IS the
 * urgency order, and a bell whose first bucket moved around would stop being scannable.
 */
export function buildThreadStateGroups(groups, { stateOf, states, retained = {} } = {}) {
  const wanted = (states || THREAD_STATES).filter((state) => THREAD_STATES.includes(state));
  const buckets = new Map();

  for (const thread of flattenThreads(groups)) {
    const live = stateOf(thread);
    const remembered = (retained || {})[thread?.id] || null;
    // A live state always wins, so a retained row moves to where it actually is rather
    // than being frozen where it entered. A retained row with no live state left keeps
    // its last bucket — that is what stops it vanishing when it goes idle.
    const state = live || remembered;
    if (!state) {
      // Never matched. Retention keeps rows, it does not admit new ones.
      continue;
    }
    if (!wanted.includes(state) && !remembered) {
      continue;
    }
    if (!buckets.has(state)) {
      buckets.set(state, {
        key: `state:${state}`,
        // Empty on purpose: `ThreadGroupHeader` only makes a header clickable when it
        // carries a real cwd, so a state bucket folds but its label stays inert and can
        // never be written into the workspace input as a path.
        cwd: "",
        label: THREAD_STATE_LABELS[state],
        state,
        latestUpdatedAt: 0,
        threads: [],
      });
    }
    const bucket = buckets.get(state);
    bucket.threads.push(thread);
    bucket.latestUpdatedAt = Math.max(bucket.latestUpdatedAt, Number(thread.updated_at) || 0);
  }

  return THREAD_STATES.filter((state) => buckets.has(state)).map((state) => {
    const bucket = buckets.get(state);
    return {
      ...bucket,
      threads: [...bucket.threads].sort(
        (left, right) => (right.updated_at || 0) - (left.updated_at || 0)
      ),
    };
  });
}

/**
 * What the list renders once the bell is applied.
 *
 * `groups` is whatever the list would otherwise show — the resting cwd groups, or the
 * search results. The bell narrows that, which is what lets the two compose.
 */
export function selectThreadFilterView({ groups = [], filter = null, stateOf = () => null } = {}) {
  if (!isThreadFilterActive(filter)) {
    return { filtering: false, groups, counts: null };
  }

  const states = selectedStates(filter);
  const counts = summarizeThreadStates(groups, stateOf);
  const filtered = buildThreadStateGroups(groups, {
    stateOf,
    states,
    retained: filter.retained || {},
  });
  const shown = filtered.reduce((total, group) => total + group.threads.length, 0);
  const everyState = states.length === THREAD_STATES.length;

  return {
    filtering: true,
    groups: filtered,
    counts,
    countLabel: shown === 1 ? "1 session" : `${shown} sessions`,
    emptyMessage: everyState
      ? "Nothing is running or waiting on you."
      : "No sessions in the selected states.",
  };
}

export { THREAD_STATES, THREAD_STATE_LABELS, selectThreadState };
