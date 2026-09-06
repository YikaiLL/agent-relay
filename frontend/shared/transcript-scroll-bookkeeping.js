import {
  captureTranscriptScrollSnapshot,
  readTranscriptScrollPosition,
  rememberTranscriptScrollPosition,
  restoreTranscriptScrollPosition,
} from "./transcript-scroll.js";

// Shared bookkeeping engine behind both transcript panes (Local, Remote).
// Owns the three things every pane retains across renders — the previous
// render's snapshot, per-key scroll positions, per-key anchored-id sets —
// keyed by an opaque "scroll key" the caller supplies (a thread id for
// Local, `relayId:threadId` for Remote). Pure and React-free so every
// surface-specific timing quirk (flushSync vs. listener-driven, capture
// mode, reset epochs) stays in the adapter hook, not here.
export function createTranscriptScrollBookkeeping() {
  let previousSnapshot = null;
  const positions = new Map();
  const anchors = new Map();

  function anchorsFor(key) {
    return anchors.get(key) || new Set();
  }

  // Remembering a leaving view and dropping the anchors of whatever key the
  // bounded LRU evicted are one coupled step — every retirement path shares
  // this, so no caller can retain a position while orphaning its anchors.
  function rememberView(key, geometrySource) {
    const evictedKey = rememberTranscriptScrollPosition(positions, key, geometrySource);
    if (evictedKey) {
      anchors.delete(evictedKey);
    }
    return evictedKey;
  }

  function readRestoreIntent(key) {
    return readTranscriptScrollPosition(positions, key);
  }

  function applyRestore({
    key,
    nextEntries,
    nextThreadId,
    pendingInputRequestIds,
    restoredScrollPosition,
    scrollElement,
  }) {
    const anchorSet = anchorsFor(key);
    const action = restoreTranscriptScrollPosition({
      alreadyAnchoredUserIds: anchorSet,
      nextEntries,
      nextThreadId,
      pendingInputRequestIds,
      previousSnapshot,
      restoredScrollPosition,
      scrollElement,
    });
    const claimedIds = [action?.userEntryId, ...(action?.inputRequestIds || [])].filter(
      Boolean
    );
    if (claimedIds.length) {
      for (const id of claimedIds) {
        anchorSet.add(id);
      }
      anchors.set(key, anchorSet);
    }
    return action;
  }

  function commitSnapshot({ key, threadId, entries, scrollElement }) {
    previousSnapshot = {
      ...captureTranscriptScrollSnapshot({ entries, scrollElement, threadId }),
      scrollKey: key,
    };
    return previousSnapshot;
  }

  function reset() {
    previousSnapshot = null;
    positions.clear();
    anchors.clear();
  }

  // Rekey the promoted key/thread-id pair (the deferred-Claude case: a
  // synthetic `claude-pending-*` id promoted to its real session id on first
  // send) across all three retained things in one step. Returns true if
  // anything was rekeyed.
  function retarget({ fromKey, toKey, fromThreadId, toThreadId }) {
    if (!fromKey || !toKey || !fromThreadId || !toThreadId || fromKey === toKey) {
      return false;
    }
    let changed = false;
    // Thread ids alone are not a reliable match: two distinct keys can share
    // one (a reconnect reusing a thread id under a different relay). Only
    // rekey the retained snapshot when its own scrollKey agrees with fromKey
    // -- or is absent, the null-element snapshot's shape, which carries no
    // key to disagree with.
    const snapshotScrollKey = previousSnapshot?.scrollKey;
    const snapshotBelongsToFromKey = snapshotScrollKey == null || snapshotScrollKey === fromKey;
    if (previousSnapshot?.activeThreadId === fromThreadId && snapshotBelongsToFromKey) {
      previousSnapshot.activeThreadId = toThreadId;
      if (snapshotScrollKey === fromKey) {
        previousSnapshot.scrollKey = toKey;
      }
      changed = true;
    }
    if (positions.has(fromKey)) {
      positions.set(toKey, positions.get(fromKey));
      positions.delete(fromKey);
      changed = true;
    }
    if (anchors.has(fromKey)) {
      anchors.set(toKey, anchors.get(fromKey));
      anchors.delete(fromKey);
      changed = true;
    }
    return changed;
  }

  return {
    anchorsFor,
    applyRestore,
    commitSnapshot,
    getSnapshot: () => previousSnapshot,
    readRestoreIntent,
    rememberView,
    reset,
    retarget,
  };
}
