import { useLayoutEffect, useRef } from "react";

import { findPendingInputRequestIds } from "../shared/thread-attention.js";
import {
  captureTranscriptScrollSnapshot,
  readTranscriptScrollPosition,
  rememberTranscriptScrollPosition,
  restoreTranscriptScrollPosition,
  retargetTranscriptScrollThread,
} from "../shared/transcript-scroll.js";

// Per-thread scroll bookkeeping for the local transcript pane. Shaped after
// use-transcript-scroll-bookkeeping.js (remote), but not shared with it: this
// surface renders through flushSync with no StrictMode, so its pre-swap read
// can happen directly in the render body instead of needing a continuous
// scroll listener. See .sealwire/PLAN.md.
//
// The store's three field names match what retargetTranscriptScrollThread
// (transcript-scroll.js) reads and writes by name — do not rename them.
export function useLocalTranscriptScrollBookkeeping({
  activeThreadId,
  entries,
  mode,
  promotion,
  resetEpoch,
  scrollElement,
  session,
}) {
  const storeRef = useRef({
    localTranscriptScrollSnapshot: null,
    localTranscriptScrollPositions: new Map(),
    localTranscriptScrollAnchors: new Map(),
  });
  const pendingCommitRef = useRef(null);
  const appliedPromotionRef = useRef(null);
  // Seeded from the first render's value, not a hardcoded 0 — otherwise mount
  // itself would read as a reset if the caller's epoch already started > 0.
  const seenResetEpochRef = useRef(resetEpoch);
  const store = storeRef.current;

  // One-shot by IDENTITY: the caller never clears this field, so every render
  // until the next promotion hands back the same object, and re-running the
  // rekey against a since-reused `from` id would move someone else's data.
  if (promotion && appliedPromotionRef.current !== promotion) {
    appliedPromotionRef.current = promotion;
    retargetTranscriptScrollThread(store, promotion.from, promotion.to);
  }

  if (resetEpoch !== seenResetEpochRef.current) {
    seenResetEpochRef.current = resetEpoch;
    store.localTranscriptScrollSnapshot = null;
    store.localTranscriptScrollPositions.clear();
    store.localTranscriptScrollAnchors.clear();
  }

  // Runs in the render body, not an effect: this root only mutates its DOM at
  // commit (flushSync, no StrictMode), so scrollElement here still holds the
  // PREVIOUS commit's content — the one point that can see the leaving
  // thread's geometry before the swap clamps it.
  pendingCommitRef.current = null;

  if (mode === "empty-ready") {
    // Leaving another thread for this empty one: retain its offset BEFORE
    // rendering the empty state, or the swap's clamped scrollTop overwrites
    // the reader's actual place with a false (usually zero) one.
    const emptyThreadId = activeThreadId;
    const previousEmptySnapshot = store.localTranscriptScrollSnapshot || null;
    if (
      previousEmptySnapshot?.activeThreadId
      && previousEmptySnapshot.activeThreadId !== emptyThreadId
    ) {
      const evictedThreadId = rememberTranscriptScrollPosition(
        store.localTranscriptScrollPositions,
        previousEmptySnapshot.activeThreadId,
        scrollElement
      );
      if (evictedThreadId) {
        store.localTranscriptScrollAnchors.delete(evictedThreadId);
      }
    }

    // Record the (empty) snapshot for this genuinely-empty thread so its
    // first entries classify as a same-thread new message (jump-bottom that
    // fires once) instead of a thread switch that may restore stale history.
    pendingCommitRef.current = (element) => {
      store.localTranscriptScrollSnapshot = captureTranscriptScrollSnapshot({
        entries: [],
        scrollElement: element,
        threadId: emptyThreadId,
      });
    };
  } else if (mode === "entries") {
    const previousSnapshot = store.localTranscriptScrollSnapshot || null;
    const localThreadId = activeThreadId;
    let restoredScrollPosition = null;
    if (
      previousSnapshot?.activeThreadId
      && previousSnapshot.activeThreadId !== localThreadId
    ) {
      const evictedThreadId = rememberTranscriptScrollPosition(
        store.localTranscriptScrollPositions,
        previousSnapshot.activeThreadId,
        scrollElement
      );
      if (evictedThreadId) {
        store.localTranscriptScrollAnchors.delete(evictedThreadId);
      }
      restoredScrollPosition = readTranscriptScrollPosition(
        store.localTranscriptScrollPositions,
        localThreadId
      );
    }
    const anchorsForThread =
      store.localTranscriptScrollAnchors.get(localThreadId) || new Set();

    pendingCommitRef.current = (element) => {
      const action = restoreTranscriptScrollPosition({
        alreadyAnchoredUserIds: anchorsForThread,
        nextEntries: entries,
        nextThreadId: localThreadId,
        pendingInputRequestIds: findPendingInputRequestIds(session, localThreadId),
        previousSnapshot,
        restoredScrollPosition,
        scrollElement: element,
      });
      const handledScrollIds = [
        action?.userEntryId,
        ...(action?.inputRequestIds || []),
      ].filter(Boolean);
      if (handledScrollIds.length) {
        for (const handledId of handledScrollIds) {
          anchorsForThread.add(handledId);
        }
        store.localTranscriptScrollAnchors.set(localThreadId, anchorsForThread);
      }
      store.localTranscriptScrollSnapshot = captureTranscriptScrollSnapshot({
        entries,
        scrollElement: element,
        threadId: localThreadId,
      });
    };
  }

  // Dep-less on purpose: this must run after every commit, mirroring the old
  // flushSync body. Cleared before running so a stale closure can never fire.
  useLayoutEffect(() => {
    const commit = pendingCommitRef.current;
    pendingCommitRef.current = null;
    commit?.(scrollElement);
  });
}
