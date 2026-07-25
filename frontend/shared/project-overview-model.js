// Pure model for the Projects "card overview" main-area view. No DOM, no storage —
// so the selection / status / ordering rules can be unit-tested in isolation and are
// shared verbatim by whatever surface renders the cards.

// The agents (sessions) that belong to a project. Membership lives in
// `thread_project_id` (a thread id -> project id map); a thread with no entry is
// Unassigned and never appears in any project overview. Recency-sorted by default so
// callers that don't apply pin/manual order still get a sensible order.
export function selectProjectAgents({ projectId, threads = [], threadProjectId = {} } = {}) {
  if (!projectId) {
    return [];
  }
  return (threads || [])
    .filter((thread) => thread && threadProjectId[thread.id] === projectId)
    .sort((left, right) => (Number(right.updated_at) || 0) - (Number(left.updated_at) || 0));
}

// One card's live status, derived from the same per-thread signals the sidebar dot
// uses (see selectThreadDot) with the SAME priority: needs_input > working >
// reviewing > completed. Returns a pill-friendly { key, label } (never null — an
// otherwise-quiet thread reads as "Idle").
export function projectCardStatus({ activity = null, attentionKind = null, reviewing = false } = {}) {
  if (attentionKind === "needs_input") {
    return { key: "needs_input", label: "Needs input" };
  }
  if (activity) {
    return { key: "working", label: "Working", tool: activity.tool || null };
  }
  if (reviewing) {
    return { key: "reviewing", label: "Reviewing" };
  }
  if (attentionKind === "completed") {
    return { key: "done", label: "Done" };
  }
  return { key: "idle", label: "Idle" };
}

// Order cards for display. `pinned` floats to the top; within the pinned and unpinned
// bands, `order` (the user's manual drag order, possibly partial) wins, and anything
// not in `order` falls back to recency. Pure and stable: never mutates its input.
export function sortProjectCards(threads = [], prefs = {}) {
  const pinned = new Set(prefs.pinned || []);
  const orderIndex = new Map((prefs.order || []).map((id, index) => [id, index]));
  const recency = (thread) => Number(thread.updated_at) || 0;

  return [...(threads || [])].sort((left, right) => {
    const leftPinned = pinned.has(left.id) ? 0 : 1;
    const rightPinned = pinned.has(right.id) ? 0 : 1;
    if (leftPinned !== rightPinned) {
      return leftPinned - rightPinned;
    }
    const leftOrder = orderIndex.has(left.id) ? orderIndex.get(left.id) : Infinity;
    const rightOrder = orderIndex.has(right.id) ? orderIndex.get(right.id) : Infinity;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return recency(right) - recency(left);
  });
}

// Move `draggingId` to sit immediately before `targetId` in `ids`, returning the new
// full order (the manual order persisted after a drag). Dropping onto itself, or a
// target not present, is a safe no-op / append. Pure — never mutates `ids`.
export function reorderCardIds(ids = [], draggingId = null, targetId = null) {
  const list = [...(ids || [])];
  if (!draggingId || draggingId === targetId || !list.includes(draggingId)) {
    return list;
  }
  const without = list.filter((id) => id !== draggingId);
  const targetIndex = without.indexOf(targetId);
  if (targetIndex < 0) {
    return [...without, draggingId];
  }
  without.splice(targetIndex, 0, draggingId);
  return without;
}

// Roll up a project's live per-thread signals into the counts the sidebar row badges
// show (e.g. "2 working", "1 approval"). Maps are the same shapes ThreadGroupList is
// fed: threadActivity/threadAttention are Map<id, …>, threadReviewing is a Set<id>.
export function summarizeProjectActivity({
  agents = [],
  threadActivity = null,
  threadAttention = null,
  threadReviewing = null,
} = {}) {
  let working = 0;
  let needsInput = 0;
  let reviewing = 0;
  for (const agent of agents) {
    const status = projectCardStatus({
      activity: threadActivity?.get?.(agent.id) || null,
      attentionKind: threadAttention?.get?.(agent.id) || null,
      reviewing: threadReviewing?.has?.(agent.id) || false,
    });
    if (status.key === "working") working += 1;
    else if (status.key === "needs_input") needsInput += 1;
    else if (status.key === "reviewing") reviewing += 1;
  }
  return { working, needsInput, reviewing, total: agents.length };
}
