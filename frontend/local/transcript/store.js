import {
  buildHydratedTranscriptProgress,
  createClearedTranscriptHydrationPatch,
  createClearedTranscriptHydrationFetchedRevisionPatch,
  createClearedTranscriptHydrationPromisePatch,
  createMergedTranscriptHydrationPagePatch,
  prepareTranscriptHydrationState,
  createTranscriptHydrationCompletePatch,
  createTranscriptHydrationRevisionPatch,
  createTranscriptHydrationPromisePatch,
  createTranscriptHydrationStatusPatch,
  restoreHydratedTranscriptSnapshot,
  restoreTranscriptHydrationForThread,
  stashTranscriptHydrationForThread,
  clearTranscriptHydrationThreadCache,
  applyTranscriptDeltaToWindow,
  markTranscriptWindowNeedsRepair,
  resolveDeltaAppend,
} from "../../shared/transcript-hydration-store.js";

function applyLocalTranscriptPatch(state, patch) {
  if (!patch) {
    return;
  }

  Object.assign(state, patch);
}

export function clearTranscriptHydration(state) {
  // Genuine reset (auth loss / session unavailable), not a thread switch — drop
  // the retained per-thread windows too.
  clearTranscriptHydrationThreadCache(state);
  applyLocalTranscriptPatch(state, createClearedTranscriptHydrationPatch());
}

// Thread switch: stash the leaving thread's loaded window and restore the target
// thread's retained window (or a cleared slot when it has none), so switching
// away and back keeps the older history the user scrolled into view instead of
// reloading only the tail.
export function switchTranscriptHydrationThread(state, nextThreadId) {
  stashTranscriptHydrationForThread(state);
  applyLocalTranscriptPatch(state, restoreTranscriptHydrationForThread(state, nextThreadId));
}

/// Append a live transcript delta to the loaded window.
///
/// The rendered transcript is rebuilt from this window on every snapshot, so a delta
/// must land here to survive — see applyTranscriptDeltaToWindow.
export function appendTranscriptDelta(state, delta) {
  return applyTranscriptDeltaToWindow(state, delta);
}

/// Mark every loaded entry non-authoritative after a delta gap (a lagged stream).
///
/// Needed because a compacted snapshot cannot repair a short local body on its own: the
/// merge deliberately keeps the LONGER text, so a stale-but-longer cache would win over
/// the authoritative preview forever.
export function invalidateTranscriptWindowForRepair(state) {
  return markTranscriptWindowNeedsRepair(state);
}

/// How much of a delta is genuinely new, given text we already hold. Re-exported so the
/// pre-hydration path reconciles identically to the loaded window.
export { resolveDeltaAppend };

/// Is the hydration window loaded for this thread?
export function transcriptWindowIsLoaded(state, threadId) {
  return Boolean(
    threadId
    && state.transcriptHydrationThreadId === threadId
    && state.transcriptHydrationEntries instanceof Map
    && Array.isArray(state.transcriptHydrationOrder)
    && state.transcriptHydrationOrder.length
  );
}

export function restoreHydratedTranscript(state, snapshot) {
  return restoreHydratedTranscriptSnapshot(state, snapshot);
}

export function prepareTranscriptHydration(state, snapshot) {
  const prepared = prepareTranscriptHydrationState(state, snapshot);
  applyLocalTranscriptPatch(state, prepared.patch);
  return prepared;
}

export function beginTranscriptHydration(state, status = "loading") {
  applyLocalTranscriptPatch(state, createTranscriptHydrationStatusPatch(status));
}

export function setTranscriptHydrationPromise(state, promise) {
  applyLocalTranscriptPatch(state, createTranscriptHydrationPromisePatch(promise));
}

export function clearTranscriptHydrationPromise(state, promise) {
  applyLocalTranscriptPatch(state, createClearedTranscriptHydrationPromisePatch(state, promise));
}

export function setTranscriptHydrationIdle(state) {
  applyLocalTranscriptPatch(state, createTranscriptHydrationStatusPatch("idle"));
}

export function clearTranscriptHydrationFetchedRevision(state) {
  applyLocalTranscriptPatch(state, createClearedTranscriptHydrationFetchedRevisionPatch());
}

export function recordTranscriptHydrationRevision(state, fetchedRevision) {
  applyLocalTranscriptPatch(state, createTranscriptHydrationRevisionPatch(fetchedRevision));
}

export function markTranscriptHydrationComplete(state, fetchedRevision) {
  applyLocalTranscriptPatch(state, createTranscriptHydrationCompletePatch(fetchedRevision));
}

export function getTranscriptHydrationThreadId(state) {
  return state.transcriptHydrationThreadId;
}

export function getTranscriptHydrationSignature(state) {
  return state.transcriptHydrationSignature;
}

export function getTranscriptHydrationCursor(state) {
  return state.transcriptHydrationOlderCursor;
}

export function mergeTranscriptHydrationPage(state, page, { prepend = false } = {}) {
  applyLocalTranscriptPatch(
    state,
    createMergedTranscriptHydrationPagePatch(state, page, { prepend })
  );
}

export { buildHydratedTranscriptProgress };

// -- Deferred window→array projection ----------------------------------------
//
// Appending a delta to the loaded window (appendTranscriptDelta, above) is
// O(1) — a Map write. Projecting it back onto the rendered array
// (order.map(...).filter(Boolean)) is O(n) in the loaded window, so that step
// is deferred: a delta only raises a pending flag, and settleTranscriptProjection
// does the actual rebuild, once, whenever it is next called. See
// .sealwire/PLAN.md, "The one lesson that keeps costing us".

// Test/perf instrumentation, mirroring transcriptFullWindowCopyCount's
// one-counter-many-sites shape (transcript-hydration-store.js:115): every
// site that copies the WHOLE transcript array increments this, whether that
// is this module's deferred window projection or session/stream.js's
// synchronous pre-hydration fallback.
let transcriptFullRebuildCount = 0;

export function __readTranscriptFullRebuildCount() {
  return transcriptFullRebuildCount;
}

export function __resetTranscriptFullRebuildCount() {
  transcriptFullRebuildCount = 0;
}

export function __recordTranscriptFullRebuild() {
  transcriptFullRebuildCount += 1;
}

/// Project the hydration window onto a rendered transcript array. Falls back
/// to the session's own transcript when the window is not loaded for this
/// thread (a delta can arrive before the first hydration), so the live tail
/// still shows rather than blanking.
export function renderedTranscriptFromWindow(state, session) {
  const entries = state.transcriptHydrationEntries;
  const order = state.transcriptHydrationOrder;
  if (
    state.transcriptHydrationThreadId !== session?.active_thread_id
    || !(entries instanceof Map)
    || !Array.isArray(order)
    || !order.length
  ) {
    return session?.transcript || [];
  }
  return order.map((itemId) => entries.get(itemId)).filter(Boolean);
}

/// Marks that a live delta appended to the loaded window without yet being
/// reflected in state.session.transcript. The O(n) rebuild that would reflect
/// it is deferred until settleTranscriptProjection actually runs, so a burst
/// of deltas costs one rebuild instead of one per delta.
export function markTranscriptWindowProjectionPending(state) {
  state.transcriptWindowProjectionPending = true;
}

/// Idempotently materialise any pending window projection into
/// state.session.transcript. Cheap when nothing is pending; safe to call
/// re-entrantly or from many call sites (flush start, the renderSession
/// chokepoint, or any path about to read/rewrite the transcript array) since
/// it always re-derives from the CURRENT window rather than trusting a
/// remembered array reference. That matters because array-identity
/// detection (the bug this replaces) has a blind spot: a write that rebuilds
/// the array — e.g. a transcript_entry_patch reducer — produces a new
/// reference every time, so identity comparison misses on exactly the case
/// it needs to catch. Settling before every read closes that gap: by the
/// time a patch reads the array to rebuild it, the pending delta is already
/// baked in and rides along in the patch's own rebuild.
///
/// Returns whether it materialised anything, so a caller holding a
/// session-shaped copy (spread from state.session before this ran) knows
/// whether it needs to fold the freshly-settled transcript back in.
export function settleTranscriptProjection(state) {
  if (!state?.transcriptWindowProjectionPending || !state.session) {
    return false;
  }
  state.transcriptWindowProjectionPending = false;
  const threadId = state.session.active_thread_id || null;
  if (!transcriptWindowIsLoaded(state, threadId)) {
    return false;
  }
  __recordTranscriptFullRebuild();
  state.session = {
    ...state.session,
    transcript: renderedTranscriptFromWindow(state, state.session),
  };
  return true;
}
