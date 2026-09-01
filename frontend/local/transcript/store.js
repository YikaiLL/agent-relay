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
