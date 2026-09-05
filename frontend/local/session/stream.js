import { openSessionStream, sessionStreamUrl } from "../../session-stream.js";
import { applyDeltaToViewOnlyPin } from "../view-only-thread.js";
import {
  appendTranscriptDelta,
  applyEntryPatchToWindow,
  invalidateTranscriptWindowForRepair,
  markTranscriptWindowProjectionPending,
  resolveDeltaAppend,
  settleTranscriptProjection,
  transcriptWindowIsLoaded,
  __recordTranscriptFullRebuild,
  __readTranscriptFullRebuildCount,
  __resetTranscriptFullRebuildCount,
} from "../transcript/store.js";

// Re-exported so existing test imports (`from "./stream.js"`) keep working —
// the counter itself now lives in transcript/store.js, since that is where
// the deferred window-projection rebuild site (settleTranscriptProjection)
// lives. This file's own pre-hydration-fallback rebuild site (below) records
// to the SAME counter via __recordTranscriptFullRebuild, matching
// transcriptFullWindowCopyCount's one-counter-many-sites shape
// (frontend/shared/transcript-hydration-store.js:115).
export { __readTranscriptFullRebuildCount, __resetTranscriptFullRebuildCount };

export function createStreamController(ctx) {
  const {
    state,
    logLine,
    seedDefaults,
    renderSession,
    handleUnauthorized,
  } = ctx;
  const applySessionSnapshot = (...args) => ctx.applySessionSnapshot(...args);
  // Resolved lazily: the controller is built before the transcript controller exists.
  const ensureConversationTranscript = (...args) =>
    ctx.ensureConversationTranscript?.(...args);
  const cancelSessionPoll = (...args) => ctx.cancelSessionPoll(...args);
  const cancelStreamReconnect = (...args) => ctx.cancelStreamReconnect(...args);
  const scheduleSessionPoll = (...args) => ctx.scheduleSessionPoll(...args);
  const scheduleStreamReconnect = (...args) => ctx.scheduleStreamReconnect(...args);
  const transcriptFlushScheduler = ctx.transcriptFlushScheduler;

  function queueTranscriptRender(nextSession, chars = 0) {
    // State advances synchronously so another delta arriving in this same frame
    // appends to the latest text instead of the last painted snapshot. Only the
    // expensive render is coalesced, by the scheduler shared with the snapshot
    // path (session-controller.js builds it; see applySessionSnapshot).
    state.session = nextSession;
    // queue() first: note()'s early-flush check only fires while a render is
    // already pending, so it must never be the thing that starts one.
    transcriptFlushScheduler.queue("transcript_entry_delta");
    if (chars > 0) {
      transcriptFlushScheduler.note(chars);
    }
  }

  function connectSessionStream() {
    if (state.authRequired && !state.authenticated) {
      return;
    }

    if (typeof fetch !== "function" || typeof AbortController === "undefined") {
      logLine("Fetch streaming is unavailable. Falling back to polling.");
      state.streamConnected = false;
      scheduleSessionPoll();
      return;
    }

    if (state.sessionStream) {
      state.sessionStream.close();
    }

    // A monotonic per-connection id. Wall-clock rather than a counter so it keeps
    // increasing across a page reload — a reset counter could not distinguish a reloaded
    // page from the one it replaced.
    state.surfaceGeneration = Date.now();
    const stream = openSessionStream({
      url: sessionStreamUrl(window.location.origin, {
        deviceId: state.deviceId,
        surfaceId: state.surfaceId,
        surfaceGeneration: state.surfaceGeneration,
      }),
      apiToken: state.apiToken,
      onSession(data) {
        try {
          const snapshot = JSON.parse(data);
          state.streamConnected = true;
          cancelSessionPoll();
          seedDefaults(snapshot);
          // Attention + notifications are handled inside applySessionSnapshot
          // (the chokepoint shared with the polling fallback).
          applySessionSnapshot(snapshot);
        } catch (error) {
          logLine(`Stream payload failed: ${error.message}`);
        }
      },
      onEvent({ data, type }) {
        try {
          applySessionStreamEvent(type, JSON.parse(data));
        } catch (error) {
          logLine(`Stream event failed: ${error.message}`);
        }
      },
      onOpen() {
        if (!state.streamConnected) {
          logLine("Session stream connected.");
        }
        // The relay drops a surface's watch set when its stream ends, so a reconnect
        // starts with no subscription. Forget what we think we declared, or the
        // dedupe would suppress the re-declaration and this tab's background threads
        // would silently fall back to polling.
        state.resetWatchedThreadsDeclaration?.();
        state.streamConnected = true;
        cancelSessionPoll();
        cancelStreamReconnect();
      },
      onError(error) {
        if (state.sessionStream !== stream) {
          return;
        }

        if (error?.code === "unauthorized") {
          state.sessionStream = null;
          handleUnauthorized("Local auth session expired. Sign in again.");
          return;
        }

        logLine("Session stream disconnected. Falling back to polling.");
        state.streamConnected = false;
        state.sessionStream = null;
        // Reflect the dropped stream in the sidebar footer status promptly, rather
        // than waiting for the next successful poll to re-render.
        if (state.session) {
          renderSession(state.session);
        }
        scheduleSessionPoll();
        scheduleStreamReconnect();
      },
    });
    state.sessionStream = stream;
  }

  function applySessionStreamEvent(type, event) {
    if (!state.session) {
      return;
    }
    const kind = event?.kind || type;
    if (kind === "transcript_stream_lagged") {
      // We missed delta frames. Our cached bodies may be short, and a compacted
      // snapshot cannot fix that on its own (the merge keeps the longer local body
      // over a shorter preview).
      //
      // Marking the window dirty is NOT enough: the re-hydration gate only fires on a
      // later render whose snapshot still says truncated, and snapshot/delta frames are
      // merged with `stream::select` — so the newest snapshot can arrive BEFORE this
      // notice. With no further state change afterwards, nothing would ever refetch.
      // Drive the fetch directly instead.
      invalidateTranscriptWindowForRepair(state);
      void ensureConversationTranscript?.(state.session);
      // Whatever text is already pending must not sit out the coalescing
      // window behind a signal that says the current view may already be
      // stale — bring it forward now, same as the plan's other immediate
      // classes.
      transcriptFlushScheduler.flushNow("transcript_stream_lagged");
      return;
    }
    if (kind === "session_meta_updated") {
      const { transcript: _transcript, transcript_truncated: _truncated, ...metadata } =
        event.session || event.patch || event;
      renderSession({
        ...state.session,
        ...metadata,
        transcript: state.session.transcript,
        transcript_truncated: state.session.transcript_truncated,
      });
      return;
    }
    if (kind === "approval_added" && event.approval?.request_id) {
      const approvals = state.session.pending_approvals || [];
      const nextApprovals = approvals.some((approval) => approval?.request_id === event.approval.request_id)
        ? approvals.map((approval) =>
            approval?.request_id === event.approval.request_id
              ? { ...approval, ...event.approval }
              : approval
          )
        : [...approvals, event.approval];
      renderSession({ ...state.session, pending_approvals: nextApprovals });
      return;
    }
    if (kind === "approval_resolved") {
      const requestId = event.request_id || event.approval?.request_id || null;
      if (requestId) {
        renderSession({
          ...state.session,
          pending_approvals: (state.session.pending_approvals || [])
            .filter((approval) => approval?.request_id !== requestId),
        });
      }
      return;
    }
    if (
      kind === "transcript_entry_started"
      || kind === "transcript_entry_delta"
      || kind === "transcript_entry_completed"
      || kind === "transcript_entry_patched"
    ) {
      if (kind === "transcript_entry_delta") {
        applyLocalTranscriptEntryDelta(event);
      } else {
        applyLocalTranscriptEntryPatch(event, {
          defaultStatus:
            kind === "transcript_entry_completed"
              ? "completed"
              : kind === "transcript_entry_started"
                ? "running"
                : null,
        });
      }
    }
  }

  /**
   * The Tasks screen's Orchestrator transcript, which is a view-only pin in all
   * but name: a thread id plus the entries drawn for it.
   *
   * Borrowing the pin reducer rather than writing a second one is deliberate.
   * The hard parts of applying a delta are not the append — they are refusing a
   * re-delivered chunk by `text_offset`, refusing a first delta that does not
   * start at 0 (its opening text never arrived, so the body would render
   * truncated as if whole), and refusing an unlabeled delta that might belong to
   * another thread. A second copy of that would drift, and the failure mode of
   * drift here is corrupted text with nothing to notice it by.
   *
   * @returns {boolean} whether the entries changed
   */
  function applyDeltaToOrchestratorEntries(event) {
    const threadId = state.orchestratorEntriesThreadId;
    if (!threadId || !Array.isArray(state.orchestratorEntries)) {
      return false;
    }
    // The reducer returns the SAME object when the delta does not apply — which
    // includes "this delta is for another thread", so no id check is needed here.
    const pin = { threadId, entries: state.orchestratorEntries };
    const next = applyDeltaToViewOnlyPin(pin, event);
    if (next === pin) {
      return false;
    }
    state.orchestratorEntries = next.entries;
    // The reducer also reports that this thread is mid-turn, and that is the
    // more reliable signal: `thread_activity` can omit the Orchestrator, or the
    // Tasks screen can miss the frame that carried the phase. Dropping it left
    // the working->idle refresh unable to fire, so the last entry stayed
    // rendered as streaming forever.
    if (next.wasWorking) {
      state.orchestratorWasWorking = true;
      // The next render must not treat a fresh delta as an observed idle edge
      // when `thread_activity` omits the Orchestrator.
      state.orchestratorDeltaRaisedWorking = true;
      if (state.orchestratorEntriesLoading) {
        state.orchestratorDeltaDuringFetch = true;
      }
    }
    // Same signal, different slot: the Orchestrator's entries are scalars rather
    // than a pin object, so the reducer's `tailGap` is carried here.
    if (next.tailGap) {
      state.orchestratorTailGap = true;
      if (state.orchestratorEntriesLoading) {
        state.orchestratorDeltaDuringFetch = true;
      }
    }
    return true;
  }

  function observeAppliedActiveThreadDelta(observation) {
    const sink = globalThis.__appliedLocalTranscriptDeltas;
    if (!Array.isArray(sink) || !observation?.itemId) {
      return;
    }
    if (
      !(Number.isSafeInteger(observation.textLengthBefore) && observation.textLengthBefore >= 0)
      || !(Number.isSafeInteger(observation.textLengthAfter) && observation.textLengthAfter >= 0)
      || observation.textLengthAfter <= observation.textLengthBefore
    ) {
      return;
    }
    sink.push({
      itemId: observation.itemId,
      threadId: observation.threadId || null,
      turnId: observation.turnId || null,
      textLengthBefore: observation.textLengthBefore,
      textLengthAfter: observation.textLengthAfter,
    });
  }

  function applyLocalTranscriptEntryDelta(event) {
    if (!event?.item_id || !Array.isArray(state.session?.transcript)) {
      return;
    }
    const currentThreadId = state.session.active_thread_id || null;
    if (event.thread_id && currentThreadId && event.thread_id !== currentThreadId) {
      // Not the active thread — but this surface may be drawing it anyway, in one
      // of two places. Route it instead of dropping it: dropping is what made a
      // background thread's transcript update only when a poll happened to land.
      // Both destinations run the SAME reducer; only the slot they live in differs.
      let changed = false;
      const pin = state.viewOnlyThread;
      const nextPin = applyDeltaToViewOnlyPin(pin, event);
      if (nextPin !== pin) {
        state.viewOnlyThread = nextPin;
        changed = true;
      }
      if (applyDeltaToOrchestratorEntries(event)) {
        changed = true;
      }
      if (changed) {
        queueTranscriptRender(state.session, (event.delta ?? "").length);
      }
      return;
    }
    // Monotonic. A delta already covered by the initial snapshot legitimately arrives
    // afterwards (the stream subscribes before the snapshot is rendered), and taking its
    // revision verbatim would walk the cursor BACKWARDS — making later snapshots look
    // stale and breaking the freshness checks that depend on it.
    const currentRevision = Number.isSafeInteger(state.session.transcript_revision)
      ? state.session.transcript_revision
      : null;
    const eventRevision = Number.isSafeInteger(event.revision) ? event.revision : null;
    const nextRevision =
      eventRevision == null
        ? state.session.transcript_revision
        : currentRevision == null
          ? eventRevision
          : Math.max(currentRevision, eventRevision);

    // The hydration window, when loaded, is the ONE place the delta is reconciled: it
    // owns the text_offset bookkeeping that makes re-delivery idempotent — and it is
    // already O(1) per delta (a Map write). Projecting it back to the rendered array
    // (order.map(...).filter(Boolean)) is O(n) in the loaded window, so that step is
    // deferred to settleTranscriptProjection() and runs once per render instead
    // of once per token — this call only bumps transcript_revision.
    // state.session.transcript trails the window by up to one render until then;
    // every reader that needs the newest text reads the window directly.
    if (transcriptWindowIsLoaded(state, currentThreadId)) {
      const textLengthBefore = (state.transcriptHydrationEntries.get(event.item_id)?.text ?? "").length;
      const applied = appendTranscriptDelta(state, event);
      const textLengthAfter = (state.transcriptHydrationEntries.get(event.item_id)?.text ?? "").length;
      if (applied) {
        observeAppliedActiveThreadDelta({
          itemId: event.item_id,
          threadId: currentThreadId,
          turnId: event.turn_id || null,
          textLengthBefore,
          textLengthAfter,
        });
      }
      const nextSession = {
        ...state.session,
        transcript_revision: nextRevision,
      };
      markTranscriptWindowProjectionPending(state);
      queueTranscriptRender(nextSession, Math.max(0, textLengthAfter - textLengthBefore));
      return;
    }

    // No window yet (deltas can arrive before the first hydration). Reconcile against
    // the rendered transcript directly, with the SAME offset rules — otherwise the live
    // tail would either vanish before hydration or double-append on re-delivery.
    const entryIndex = state.session.transcript.findIndex(
      (candidate) => candidate?.item_id === event.item_id
    );
    const deltaText = event.delta ?? "";
    const startsAtZero =
      event.text_offset == null
      || (Number.isSafeInteger(event.text_offset) && event.text_offset === 0);
    const appendText =
      entryIndex >= 0
        ? resolveDeltaAppend(
          state.session.transcript[entryIndex].text ?? "",
          deltaText,
          event.text_offset
        )
        : (startsAtZero ? deltaText : null);
    if (appendText == null || appendText === "") {
      // Duplicate, gap, or a body that starts mid-stream. Hydration is authoritative
      // for all three; splicing here would corrupt the text it will later reconcile.
      return;
    }

    const textLengthBefore =
      entryIndex >= 0 ? (state.session.transcript[entryIndex].text ?? "").length : 0;
    const nextTranscript = entryIndex >= 0
      ? state.session.transcript.map((entry, index) =>
          index === entryIndex
            ? {
              ...entry,
              entry_seq: Number.isSafeInteger(event.entry_seq) && !Number.isSafeInteger(entry.entry_seq)
                ? event.entry_seq
                : entry.entry_seq,
              kind: entry.kind || normalizeLocalDeltaKind(event.delta_kind || event.entry_kind),
              status: "running",
              text: `${entry.text ?? ""}${appendText}`,
              turn_id: entry.turn_id || event.turn_id || null,
            }
            : entry
        )
      : [
          ...state.session.transcript,
          {
            entry_seq: Number.isSafeInteger(event.entry_seq) ? event.entry_seq : null,
            item_id: event.item_id,
            kind: normalizeLocalDeltaKind(event.delta_kind || event.entry_kind),
            status: "running",
            text: appendText,
            tool: null,
            turn_id: event.turn_id || null,
          },
        ];
    // Same full-rebuild shape as the deferred window projection
    // (settleTranscriptProjection), just bounded (max_transcript_entries: 8)
    // rather than deferred — counted for the same reason: visibility into
    // every site that copies the whole array.
    __recordTranscriptFullRebuild();
    observeAppliedActiveThreadDelta({
      itemId: event.item_id,
      threadId: currentThreadId,
      turnId: event.turn_id || null,
      textLengthBefore,
      textLengthAfter: textLengthBefore + appendText.length,
    });
    queueTranscriptRender(
      {
        ...state.session,
        transcript: nextTranscript,
        transcript_revision: nextRevision,
      },
      appendText.length
    );
  }

  function normalizeLocalDeltaKind(kind) {
    return kind === "command_output" ? "command" : kind || "agent_text";
  }

  function applyLocalTranscriptEntryPatch(event, { defaultStatus = null } = {}) {
    // Validate BEFORE settling: background threads are watched, so an
    // off-thread patch here is routine, not exceptional, and the early
    // returns below drop it without ever touching state.session.transcript.
    // Settling is an O(n) window projection — paying for it on a patch we
    // are about to discard defeats the whole point of deferring it to the
    // flush.
    const currentThreadId = state.session?.active_thread_id || null;
    const eventThreadId = event.thread_id || event.active_thread_id || event.entry?.thread_id || null;
    if (eventThreadId && currentThreadId && eventThreadId !== currentThreadId) {
      return;
    }
    const entry = event.entry || {
      item_id: event.item_id,
      entry_seq: event.entry_seq,
      kind: event.entry_kind,
      status: event.status,
      text: event.text,
      tool: event.tool,
      turn_id: event.turn_id,
    };
    if (!entry?.item_id || !Array.isArray(state.session?.transcript)) {
      return;
    }
    // Only now is this function committed to reading state.session.transcript
    // and rebuilding it (below) — settle any pending window append into it
    // FIRST, or that rebuild would carry the pre-append text forward into its
    // own new array reference, silently dropping the pending delta (see
    // settleTranscriptProjection's doc). Once settled here, the render
    // chokepoint's own settle is a no-op — this rebuild's array already
    // carries both the delta and this patch.
    settleTranscriptProjection(state);
    const patchedEntry = {
      ...entry,
      kind: entry.kind || event.entry_kind || null,
      status: entry.status || defaultStatus || "completed",
      turn_id: entry.turn_id || event.turn_id || null,
    };
    // Also invalidate the window's own copy, not just rebuild the array
    // below: it can never safely carry this patch's fields itself (see
    // invalidateTranscriptWindowEntryForPatch), so a later delta re-arming
    // the pending projection must not settle by trusting the window's stale
    // copy over the array's fresher one — renderedTranscriptFromWindow reads
    // this thread's array as the fallback source for exactly that reason. A
    // no-op when the window isn't loaded yet, or doesn't yet track this item.
    applyEntryPatchToWindow(state, currentThreadId, patchedEntry);
    const entryIndex = state.session.transcript.findIndex(
      (candidate) => candidate?.item_id === patchedEntry.item_id
    );
    // True when applyEntryPatchToWindow just no-op'd because the window has
    // never tracked this item at all. renderedTranscriptFromWindow's own
    // array-fallback means the array rebuild below is never silently dropped
    // by a later settle, so the window still not knowing this item exists is
    // not a data-loss risk — see the comment below on why it must STAY that
    // way rather than being taught about it via this patch.
    const patchIntroducesUntrackedItem = entryIndex < 0 && transcriptWindowIsLoaded(state, currentThreadId);
    const nextTranscript = entryIndex >= 0
      ? state.session.transcript.map((candidate, index) =>
          index === entryIndex
            ? {
              ...candidate,
              ...patchedEntry,
              kind: patchedEntry.kind || candidate.kind || "agent_text",
              text: patchedEntry.text ?? candidate.text ?? null,
              tool: patchedEntry.tool ?? candidate.tool ?? null,
              turn_id: patchedEntry.turn_id || candidate.turn_id || null,
            }
            : candidate
        )
      : [
          ...state.session.transcript,
          {
            text: patchedEntry.text ?? "",
            tool: patchedEntry.tool ?? null,
            ...patchedEntry,
            kind: patchedEntry.kind || "agent_text",
          },
        ];
    const nextSession = {
      ...state.session,
      transcript: nextTranscript,
      transcript_revision: Number.isSafeInteger(event.revision)
        ? event.revision
        : state.session.transcript_revision,
    };
    if (patchIntroducesUntrackedItem) {
      // state.session (still pre-patch here), NOT nextSession: a patch has no
      // content_state field, so exposing this item's fabricated array entry to
      // hydration's tail merge would default the missing field to "full" and
      // poison the window with an empty-but-"full" entry — permanently
      // suppressing the real fetch (transcript-hydration-store.js's
      // contentStateOf; see .sealwire/PLAN.md, "Invalidate; do not write" ->
      // "Never route non-authoritative data through the authoritative path" ->
      // "Invalidate and refetch instead of merging a patch-derived session").
      // state.session never mentions this item, so the merge can only repair
      // OTHER already-tracked entries — a real snapshot later teaches the
      // window about this one honestly.
      void ensureConversationTranscript(state.session);
    }
    // Completion, failure, error and cancellation are terminal, and a patch is
    // the ONLY way local ever learns of them for an entry with no dedicated
    // snapshot turn-state change — so this must paint at once, not wait out
    // the coalescing window (.sealwire/PLAN.md). Mirrors remote's
    // commitLiveSession(nextSession, { immediate: entryPatch.status !== "running" }).
    if (patchedEntry.status !== "running") {
      state.session = nextSession;
      transcriptFlushScheduler.flushNow("transcript_entry_patch");
    } else {
      queueTranscriptRender(nextSession);
    }
  }

  return {
    connectSessionStream,
    applySessionStreamEvent,
    applyLocalTranscriptEntryDelta,
    normalizeLocalDeltaKind,
    applyLocalTranscriptEntryPatch,
  };
}
