import { useLayoutEffect, useRef } from "react";

import { findPendingInputRequestIds } from "../shared/thread-attention.js";
import { setRemoteTranscriptElement } from "./ui-refs.js";
import {
  captureTranscriptScrollSnapshot,
  readTranscriptScrollPosition,
  rememberTranscriptScrollPosition,
  restoreTranscriptScrollPosition,
  retargetRemoteTranscriptScroll,
} from "./transcript-scroll.js";

// Per-thread scroll bookkeeping for the remote transcript pane.
//
// Owns the two retained maps (restoration intent + already-anchored user
// entries), decides the scroll action for each render, and keeps the retained
// entry for the CURRENTLY RENDERED thread fresh (on scroll and on every
// render) so a switch away and back lands the reader where they left off.
//
// Lives in its own module because the ordering it has to respect — React
// commits child DOM mutations BEFORE running a parent's layout-effect cleanup —
// is only observable through the real hook, so the regression test drives this
// hook directly (use-transcript-scroll-bookkeeping.dom.test.mjs).
export function useRemoteTranscriptScrollBookkeeping({
  currentState,
  entries,
  session,
  threadId,
  transcriptRef,
}) {
  const previousRenderRef = useRef({
    activeThreadId: null,
    entries: [],
  });
  const anchoredUserIdsRef = useRef(new Map()); // threadId -> Set<userId>
  const scrollPositionsRef = useRef(new Map()); // relayId:threadId -> restoration intent
  const renderedScrollKeyRef = useRef(null);

  const remoteThreadId = threadId || null;
  const remoteScrollKey = remoteThreadId
    ? `${currentState.activeRelayId || "-"}:${remoteThreadId}`
    : null;
  // The key of the thread the LATEST render is committing. Written during
  // render on purpose: a layout-effect cleanup runs after React has already
  // mutated the scroller's children, so this is the only handle the cleanup
  // has on "whose content is in the DOM right now". A render that never
  // commits can only make the check fail closed (we skip a redundant
  // re-record), never the other way around.
  renderedScrollKeyRef.current = remoteScrollKey;

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    setRemoteTranscriptElement(transcript);
    if (!transcript) {
      previousRenderRef.current = {
        activeThreadId: remoteThreadId,
        entries,
      };
      return undefined;
    }

    const previous = previousRenderRef.current;

    // Deferred-Claude promotion (send path sets the one-shot alias): same
    // logical thread under a new public id — rekey the retained bookkeeping
    // instead of treating it as a thread switch, so the first reply keeps the
    // send-anchor instead of jump-bottom briefly re-enabling live follow.
    const promotion = currentState.promotedThreadAlias || null;
    if (
      promotion
      && previous?.activeThreadId === promotion.from
      && remoteThreadId === promotion.to
    ) {
      retargetRemoteTranscriptScroll({
        anchoredUserIds: anchoredUserIdsRef.current,
        scrollPositions: scrollPositionsRef.current,
        snapshot: previous,
        fromScrollKey: `${currentState.activeRelayId || "-"}:${promotion.from}`,
        toScrollKey: remoteScrollKey,
        fromThreadId: promotion.from,
        toThreadId: remoteThreadId,
      });
      // Consumed: the alias is one-shot. (An alias whose transition this pane
      // never renders stays until the next promotion overwrites it — pending
      // ids are unique, so it can never match anything else.)
      currentState.promotedThreadAlias = null;
    }

    let restoredScrollPosition = null;
    if (previous?.scrollKey && previous.scrollKey !== remoteScrollKey) {
      // The prior layout-effect cleanup and scroll listener retained the old
      // thread against its own DOM. Do not overwrite it here using the newly
      // rendered thread's geometry; that can turn a history-reading offset into
      // a false bottom-follow marker (or vice versa).
      if (!scrollPositionsRef.current.has(previous.scrollKey)) {
        const evictedScrollKey = rememberTranscriptScrollPosition(
          scrollPositionsRef.current,
          previous.scrollKey,
          previous
        );
        if (evictedScrollKey) {
          anchoredUserIdsRef.current.delete(evictedScrollKey);
        }
      }
      restoredScrollPosition = readTranscriptScrollPosition(
        scrollPositionsRef.current,
        remoteScrollKey
      );
    }
    const anchorsForThread =
      anchoredUserIdsRef.current.get(remoteScrollKey) || new Set();
    const action = restoreTranscriptScrollPosition({
      alreadyAnchoredUserIds: anchorsForThread,
      nextEntries: entries,
      nextThreadId: remoteThreadId,
      // An approval / AskUser question is not a transcript entry, so it needs its
      // own trigger to be brought into view when it arrives (it renders last, at
      // the bottom). Fire-once, keyed on the request ids — plural because a
      // second question can arrive while the first is still outstanding.
      pendingInputRequestIds: findPendingInputRequestIds(session, remoteThreadId),
      previousSnapshot: previous,
      restoredScrollPosition,
      scrollElement: transcript,
    });
    // Record what this action handled. New-message actions use this to avoid
    // re-jumping mid-stream; thread-transition actions use it to establish the
    // loaded transcript as a baseline so the next snapshot cannot mistake
    // retained history for a newly-sent message. One Set serves both kinds —
    // request ids are namespaced, so they cannot collide with item ids.
    const handledScrollIds = [
      action?.userEntryId,
      ...(action?.inputRequestIds || []),
    ].filter(Boolean);
    if (handledScrollIds.length) {
      for (const handledId of handledScrollIds) {
        anchorsForThread.add(handledId);
      }
      anchoredUserIdsRef.current.set(remoteScrollKey, anchorsForThread);
    }

    const rememberCurrentPosition = () => {
      // Only the thread currently in the DOM may write its own geometry. On a
      // thread switch this cleanup fires with the NEXT thread's content already
      // committed, and recording then would file that content's numbers (an
      // empty projection reads as "at the bottom") under the leaving thread's
      // key — silently converting a history-reading offset into bottom-follow.
      // The leaving thread's own entry is already current: the scroll listener
      // and this render's own call recorded it against its own DOM.
      if (renderedScrollKeyRef.current !== remoteScrollKey) {
        return;
      }
      const evictedScrollKey = rememberTranscriptScrollPosition(
        scrollPositionsRef.current,
        remoteScrollKey,
        transcript
      );
      if (evictedScrollKey) {
        anchoredUserIdsRef.current.delete(evictedScrollKey);
      }
    };
    rememberCurrentPosition();
    transcript.addEventListener("scroll", rememberCurrentPosition, { passive: true });

    previousRenderRef.current = {
      ...captureTranscriptScrollSnapshot({
        entries,
        scrollElement: transcript,
        threadId: remoteThreadId,
      }),
      scrollKey: remoteScrollKey,
    };
    return () => {
      rememberCurrentPosition();
      transcript.removeEventListener("scroll", rememberCurrentPosition);
      setRemoteTranscriptElement(null);
    };
  });
}
