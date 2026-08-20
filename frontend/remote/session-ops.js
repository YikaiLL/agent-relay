import {
  dispatchOrRecover,
  dispatchRemoteActionWithoutReply,
  scheduleClaimRefresh,
} from "./actions.js";
import {
  isCurrentDeviceActiveController,
  isVerboseBrokerLoggingEnabled,
  renderLog,
  renderSession,
} from "./session-surface.js";
import {
  patchRemoteState,
  state,
} from "./state.js";
import {
  clearTranscriptHydration,
  restoreHydratedTranscript,
  switchTranscriptHydrationThread,
} from "./transcript/store.js";
import {
  hydrateRemoteTranscript,
  loadOlderRemoteTranscript,
} from "./transcript/hydration.js";
import {
  createTranscriptEntryDetailFetcher,
  createTranscriptPageFetcher,
} from "./transcript/api.js";
import { transcriptPageCache } from "./transcript/page-cache-instance.js";
import {
  dispatchWorkspaceRepair,
  readWorkspaceRepair,
  setWorkspaceRepairError,
  setWorkspaceRepairPending,
  workspaceRepairResolved,
} from "./workspace-repair.js";
import { withThreadError } from "../shared/composer-errors.js";
import { createCachingTranscriptPageFetcher } from "../shared/caching-transcript-fetcher.js";
import { providerLabel } from "../shared/provider-labels.js";
import {
  createThreadListQueryOptions,
  createThreadTranscriptPageQueryOptions,
  fetchThreadListFresh,
} from "../shared/thread-queries.js";
import {
  syncLiveTranscriptEntryDetailsFromSnapshot,
} from "./transcript/details.js";
import { remoteQueryClient } from "./query-client.js";
import { remoteUiRefs } from "./ui-refs.js";
import {
  applyRemoteSurfacePatch,
  createRemoteThreadSearchPatch,
  createRemoteThreadsPatch,
} from "./surface-state.js";
import { isReviewInProgressForThread } from "../shared/review-state.js";
import {
  detectDeferredThreadPromotion,
  shouldRebindPinnedViewOnPromotion,
} from "../shared/thread-promotion.js";
import { resolveOutgoingEffort } from "../shared/reasoning-efforts.js";
import { buildNavigationThreadGroups } from "../shared/thread-groups.js";
import {
  EMPTY_THREAD_SEARCH,
  normalizeThreadSearchQuery,
} from "../shared/thread-search.js";
import { threadAttention } from "../shared/thread-attention.js";
import { forkFieldsToPayload } from "../shared/fork-fields.js";
import { isDocumentForeground, notifyThreadEvents } from "../shared/thread-notify.js";
import { shouldRefreshViewedThread } from "../shared/viewed-thread-refresh.js";
import { isWorkingThreadStatus } from "../shared/thread-status.js";
import { createFrameRenderQueue } from "./frame-render-queue.js";

const fetchTranscriptPageOverBroker = createTranscriptPageFetcher(dispatchOrRecover);
const fetchRawTranscriptPage = fetchTranscriptPageOverBroker;
const fetchTranscriptEntryDetailRequest =
  createTranscriptEntryDetailFetcher(dispatchOrRecover);

// Persistent, encrypted-at-rest cache for OLDER transcript history pages. Only
// append-stable older pages (before != null) are cached; the live tail always
// hits the network. This makes scroll-up history loads and post-reload backfill
// resolve from disk instead of a per-page network round trip. See
// shared/caching-transcript-fetcher.js for the policy and the streaming red line.
const fetchCachedTranscriptPage = createCachingTranscriptPageFetcher({
  cache: transcriptPageCache,
  fetchPage: fetchRawTranscriptPage,
  getScope: remoteQueryScope,
});

// Client-local viewed thread. The relay's live/control snapshot is retained in
// state.realSession while state.session is the rendered projection.
let viewOnlyThreadId = null;
let viewOnlyNavigationGeneration = 0;
let viewOnlyRefreshInFlight = false;
let viewOnlyLastRefreshAt = 0;
let viewOnlyWasWorking = false;
// Last thread-watch set declared to the relay, so a snapshot that changes nothing about
// what is on screen does not become an outbound frame.
let lastDeclaredWatchKey = null;
const transcriptFrameRenderQueue = createFrameRenderQueue({
  render() {
    if (state.session) {
      renderSession(state.session);
    }
  },
});

export function flushRemoteTranscriptRenderForTest() {
  transcriptFrameRenderQueue.flush();
}

function invalidateViewOnlyNavigation() {
  viewOnlyNavigationGeneration += 1;
  viewOnlyThreadId = null;
  viewOnlyRefreshInFlight = false;
  viewOnlyLastRefreshAt = 0;
  viewOnlyWasWorking = false;
  // The relay drops watch sets when the broker connection goes, so the phone must
  // forget what it declared or it would never re-declare after reconnecting.
  lastDeclaredWatchKey = null;
}

function remoteQueryScope() {
  return state.remoteAuth?.relayId || "unpaired";
}

function fetchTranscriptPage({ threadId, before }) {
  return remoteQueryClient
    .fetchQuery(
      createThreadTranscriptPageQueryOptions({
        before,
        fetchPage: fetchCachedTranscriptPage,
        scope: remoteQueryScope(),
        surface: "remote",
        threadId,
      })
    );
}

// The repair records live on a Map hanging off `state`, so mutating them is invisible to
// `useSyncExternalStore`. Re-publish the same Map through the store to bump the snapshot
// identity and repaint the banner.
function publishWorkspaceRepair() {
  patchRemoteState({ workspaceRepairByThread: state.workspaceRepairByThread || new Map() });
}

/**
 * Ask the relay to make this thread's recorded workspace exist again.
 *
 * Ack-only over the broker and claim-free by design: a phone must be able to un-brick a
 * session it is merely viewing, without stealing the active-controller lease.
 */
export async function repairRemoteWorkspace(threadId) {
  const targetThreadId = threadId || state.session?.active_thread_id || null;
  if (!targetThreadId) {
    renderLog("There is no session whose workspace could be re-created.");
    return false;
  }

  setWorkspaceRepairPending(state, targetThreadId, true);
  publishWorkspaceRepair();

  try {
    await dispatchWorkspaceRepair(dispatchOrRecover, targetThreadId);
    // Clear now rather than waiting for the next tail fetch: the relay has just confirmed
    // the directory exists, and a banner still claiming otherwise would be a lie with a
    // button on it. The refresh below replaces this with the relay's own verdict.
    workspaceRepairResolved(state, targetThreadId);
    publishWorkspaceRepair();
    renderLog(`Re-created the workspace for session ${targetThreadId}.`);
    // No client-side probe cache to invalidate here: the verdict rides
    // `snapshot.workspace_missing` (see shared/workspace-repair.js), so the refresh
    // below is the whole of it. An assignment to a stray `lastWorkspaceVerdictProbeKey`
    // outlived the design that had one, and being inside this try meant the
    // ReferenceError it threw in strict mode was caught below and reported as a failed
    // repair — of a workspace the relay had just rebuilt.
    void fetchRawTranscriptPage({ threadId: targetThreadId, before: null }).catch(() => {});
    return true;
  } catch (error) {
    // The relay's own message, kept whole — "the repository … no longer exists either" is
    // the difference between a user who knows what to do and one who does not.
    setWorkspaceRepairError(
      state,
      targetThreadId,
      error.message || "Failed to re-create the workspace"
    );
    publishWorkspaceRepair();
    renderLog(`Workspace repair failed: ${error.message}`);
    return false;
  }
}

function transcriptDeltaKindToEntryKind(deltaKind) {
  switch (deltaKind) {
    case "command_output":
      return "command";
    case "agent_text":
    default:
      return "agent_text";
  }
}

export function applyTranscriptDelta({
  thread_id,
  base_revision,
  revision,
  entry_seq,
  server_time,
  item_id,
  turn_id,
  delta,
  delta_kind,
  kind,
  text_offset,
}) {
  if (typeof window !== "undefined" && typeof window.__transcriptDeltaCount === "number") {
    window.__transcriptDeltaCount++;
  }
  const liveSession = currentLiveSession();
  if (!liveSession) return;
  const liveThreadId = liveSession.active_thread_id || null;

  // Which session does this delta belong to?
  //
  // The relay now streams every thread this surface has declared it is watching, not
  // just the one globally-active thread. So a delta whose thread isn't the live one is
  // no longer automatically junk — it may be the thread being read view-only, whose
  // transcript lives in the PROJECTED session (`state.session`), not the live one.
  // Dropping it was what made a watched background thread update only when a poll
  // happened to land.
  let currentSession = liveSession;
  let commit = commitLiveSession;
  let currentThreadId = liveThreadId;
  if (thread_id && liveThreadId && thread_id !== liveThreadId) {
    if (viewOnlyThreadId && thread_id === viewOnlyThreadId && state.session?.view_only) {
      currentSession = state.session;
      currentThreadId = viewOnlyThreadId;
      commit = commitViewedSession;
    } else {
      const message = `[transcript-delta] ignored thread=${thread_id} current=${liveThreadId} item=${item_id || "-"} kind=${delta_kind || kind || "-"}`;
      renderLog(message);
      // TODO(remote-monitor-debug): Remove this console mirror once transcript routing is stable.
      console.log(message);
      return;
    }
  }
  const currentRevision = numericRevision(currentSession.transcript_revision);
  const deltaBaseRevision = numericRevision(base_revision);
  const deltaRevision = numericRevision(revision);
  if (
    deltaRevision != null
    && currentRevision != null
    && deltaRevision < currentRevision
  ) {
    const message = `[transcript-delta] ignored stale revision=${deltaRevision} current=${currentRevision} thread=${thread_id || "-"} item=${item_id || "-"}`;
    renderLog(message);
    console.log(message);
    return;
  }

  const transcript = currentSession.transcript;
  if (!Array.isArray(transcript)) return;
  const resolvedKind = transcriptDeltaKindToEntryKind(delta_kind || kind);
  const entryIndex = transcript.findIndex((e) => e.item_id === item_id);
  const deltaText = delta ?? "";
  const offset = numericOffset(text_offset);

  // Offset-based path (agent-text deltas carry text_offset): the entry's own
  // text length is the cursor, so a single dropped/coalesced chunk no longer
  // freezes the whole message. We can tell apart a contiguous append, a
  // duplicate re-delivery, and a genuine gap — and only the gap needs an
  // authoritative repair fetch. This tolerates a non-contiguous base_revision
  // chain (interleaved streams, snapshot-bumped revisions). Deltas whose
  // revision is strictly behind the current revision are still dropped above as
  // superseded before reaching here — that is intentional (a newer snapshot
  // already covers them).
  if (offset != null) {
    const haveText = entryIndex >= 0 ? (transcript[entryIndex].text ?? "") : "";
    const have = haveText.length;
    if (have < offset) {
      // Missing earlier text: appending here would splice the stream out of
      // order. Pull the authoritative tail instead of silently freezing.
      scheduleTranscriptGapRepair(currentThreadId || thread_id || null, "offset_gap", deltaRevision, {
        item: item_id,
        offset,
        have,
      });
      return;
    }
    // Length alone can't prove the overlap is the SAME text. If the bytes we
    // already hold in [offset, offset+overlap) disagree with this delta, local
    // text has diverged — treating it as a duplicate / appending the tail would
    // silently keep or extend corrupted text, so force an authoritative repair.
    const overlapLen = Math.min(have - offset, deltaText.length);
    if (overlapLen > 0 && haveText.slice(offset, offset + overlapLen) !== deltaText.slice(0, overlapLen)) {
      scheduleTranscriptGapRepair(currentThreadId || thread_id || null, "offset_mismatch", deltaRevision, {
        item: item_id,
        offset,
        have,
      });
      return;
    }
    if (have >= offset + deltaText.length) {
      // Duplicate re-delivery: we already hold this delta's whole range.
      return;
    }
    // Contiguous, or partially-overlapping re-delivery: append only the tail we
    // are missing so re-delivery stays idempotent.
    commitTranscriptDeltaAppend({
      commit,
      currentSession,
      transcript,
      entryIndex,
      item_id,
      appendText: deltaText.slice(have - offset),
      resolvedKind,
      turn_id,
      entry_seq,
      deltaRevision,
      server_time,
    });
    return;
  }

  // Fallback path (command output / legacy deltas with no offset): rely on the
  // base_revision chain, but on a mismatch repair instead of dropping — the old
  // silent drop is exactly what left the last message permanently incomplete.
  if (
    deltaBaseRevision != null
    && currentRevision != null
    && deltaBaseRevision !== currentRevision
  ) {
    scheduleTranscriptGapRepair(currentThreadId || thread_id || null, "base_revision_gap", deltaRevision, {
      item: item_id,
      base_revision: deltaBaseRevision,
      current: currentRevision,
    });
    return;
  }
  commitTranscriptDeltaAppend({
    commit,
    currentSession,
    transcript,
    entryIndex,
    item_id,
    appendText: deltaText,
    resolvedKind,
    turn_id,
    entry_seq,
    deltaRevision,
    server_time,
  });
}

function commitTranscriptDeltaAppend({
  commit = commitLiveSession,
  currentSession,
  transcript,
  entryIndex,
  item_id,
  appendText,
  resolvedKind,
  turn_id,
  entry_seq,
  deltaRevision,
  server_time,
}) {
  const nextTranscript = entryIndex >= 0
    ? transcript.map((entry, index) => {
        if (index !== entryIndex) {
          return entry;
        }
        return {
          ...entry,
          entry_seq: Number.isSafeInteger(entry_seq) && !Number.isSafeInteger(entry.entry_seq)
            ? entry_seq
            : entry.entry_seq,
          kind: entry.kind || resolvedKind,
          status: "running",
          text: `${entry.text ?? ""}${appendText}`,
          turn_id: entry.turn_id || turn_id || null,
        };
      })
    : [
        ...transcript,
        {
          item_id,
          turn_id: turn_id ?? null,
          text: appendText,
          kind: resolvedKind,
          status: "running",
          tool: null,
          entry_seq: Number.isSafeInteger(entry_seq) ? entry_seq : null,
        },
      ];
  const nextSession = {
    ...currentSession,
    transcript: nextTranscript,
  };
  // Always advance the revision cursor when we apply a delta, even though the
  // offset path ignores base_revision for the apply decision. This keeps the
  // shared per-thread revision monotonic so the command-output base_revision
  // chain (and snapshot freshness checks) stay intact across interleaving.
  if (deltaRevision != null) {
    nextSession.transcript_revision = deltaRevision;
  }
  if (Number.isSafeInteger(server_time)) {
    nextSession.server_time = server_time;
  }
  commit(nextSession);
}

// Highest target revision we still owe a repair for, per thread. A Map (not a
// Set) so a gap detected *while* a repair is already in flight is not swallowed:
// we remember the newest revision and the loop re-fetches if it is past what the
// in-flight pass covered.
const pendingGapRepairThreads = new Map();

function scheduleTranscriptGapRepair(threadId, reason, targetRevision, detail = {}) {
  if (typeof window !== "undefined" && typeof window.__transcriptGapRepairCount === "number") {
    window.__transcriptGapRepairCount++;
  }
  const detailText = Object.entries(detail)
    .map(([key, value]) => `${key}=${value ?? "-"}`)
    .join(" ");
  const message = `[transcript-delta] gap -> repair thread=${threadId || "-"} reason=${reason} target=${targetRevision ?? "-"} ${detailText}`.trimEnd();
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once gap repair is stable.
  console.log(message);
  if (!threadId) {
    return;
  }
  const target = numericRevision(targetRevision) ?? 0;
  const existingTarget = pendingGapRepairThreads.get(threadId);
  if (existingTarget != null) {
    if (target > existingTarget) {
      pendingGapRepairThreads.set(threadId, target);
    }
    return;
  }
  pendingGapRepairThreads.set(threadId, target);
  void runTranscriptRepairLoop(threadId);
}

const MAX_TRANSCRIPT_REPAIR_FAILURES = 3;

/// Is this thread still one we are actually showing?
///
/// Repair used to test only the LIVE thread, which meant a gap on a background thread
/// being read view-only exited the loop immediately and discarded the pending repair —
/// so the missing text sat there until polling or end-of-turn happened to refill it.
/// Now that a watched background thread streams, it can gap like any other and has to
/// be repairable too.
function isRepairableThread(threadId) {
  return (
    currentLiveSession()?.active_thread_id === threadId
    || (viewOnlyThreadId != null && viewOnlyThreadId === threadId)
  );
}

async function runTranscriptRepairLoop(threadId) {
  let repairedToRevision = -1;
  let consecutiveFailures = 0;
  try {
    while (isRepairableThread(threadId)) {
      const target = pendingGapRepairThreads.get(threadId) ?? 0;
      if (target <= repairedToRevision) {
        break;
      }
      try {
        await repairActiveTranscriptTail(threadId, target);
        repairedToRevision = target;
        consecutiveFailures = 0;
      } catch (error) {
        // A single failed fetch must NOT abandon the loop: do not advance
        // repairedToRevision, and re-read pendingGapRepairThreads on the next
        // iteration so a higher-revision gap that arrived while this attempt was
        // in flight is still honored instead of being dropped on the failure.
        consecutiveFailures += 1;
        renderLog(
          `[transcript-delta] gap repair attempt failed thread=${threadId} (${consecutiveFailures}/${MAX_TRANSCRIPT_REPAIR_FAILURES}): ${error?.message || error}`
        );
        if (consecutiveFailures >= MAX_TRANSCRIPT_REPAIR_FAILURES) {
          // Give up for now; the next delta or snapshot re-arms repair.
          break;
        }
      }
    }
  } finally {
    pendingGapRepairThreads.delete(threadId);
  }
}

// Pull the authoritative transcript tail and overlay it onto the visible
// transcript. This deliberately bypasses the snapshot-truncation hydration gate
// (`prepareTranscriptHydrationState` no-ops when `transcript_truncated` is
// false, which is exactly the normal live-gap case) and the query cache, so a
// dropped live chunk is actually re-fetched and healed rather than only logged.
async function repairActiveTranscriptTail(threadId, targetRevision) {
  const page = await fetchRawTranscriptPage({ threadId, before: null });
  // Repair whichever session actually holds this thread's transcript: the live one, or
  // the view-only projection when the thread is being read in the background. Writing
  // a background thread's repaired tail into the live session would corrupt the live
  // thread's transcript, so the target is chosen the same way the delta path chooses it.
  const live = currentLiveSession();
  const viewingThisThread =
    viewOnlyThreadId === threadId && state.session?.view_only && threadId != null;
  const liveSession = viewingThisThread ? state.session : live;
  const commit = viewingThisThread ? commitViewedSession : commitLiveSession;
  // The thread may have changed while the fetch was in flight — a legitimate no-op
  // (the user moved on), not a failure to retry.
  if (!liveSession || liveSession.active_thread_id !== threadId) {
    return;
  }
  // A missing or wrong-thread page is an incomplete/garbled response: throw so
  // runTranscriptRepairLoop retries instead of silently treating the gap as
  // repaired and advancing past it.
  if (!page || page.thread_id !== threadId) {
    throw new Error("remote transcript repair page response is incomplete");
  }

  const pageEntries = Array.isArray(page.entries) ? page.entries : [];
  const pageItemIds = new Set(pageEntries.map((entry) => entry?.item_id).filter(Boolean));
  const current = Array.isArray(liveSession.transcript) ? liveSession.transcript : [];
  const currentByItemId = new Map(
    current.filter((entry) => entry?.item_id).map((entry) => [entry.item_id, entry])
  );

  // Older entries the bounded tail page did not reach keep their place; the
  // page's entries (server-authoritative) replace the visible tail.
  const olderKept = current.filter(
    (entry) => !entry?.item_id || !pageItemIds.has(entry.item_id)
  );
  const repairedTail = pageEntries.map((entry) => {
    const existing = currentByItemId.get(entry?.item_id);
    if (!existing) {
      return entry;
    }
    return {
      ...existing,
      ...entry,
      // The page is authoritative, but never let an unexpectedly short page
      // entry shorten already-visible text. Pure length comparison — no
      // "..."-suffix inference.
      text: selectLongerVisibleText(existing.text, entry.text),
    };
  });

  const currentRevision = numericRevision(liveSession.transcript_revision) ?? 0;
  const pageRevision = numericRevision(page.revision) ?? 0;
  const nextRevision = Math.max(
    currentRevision,
    pageRevision,
    numericRevision(targetRevision) ?? 0
  );

  const nextSession = {
    ...liveSession,
    transcript: [...olderKept, ...repairedTail],
    transcript_truncated: page.prev_cursor != null,
  };
  if (nextRevision > 0) {
    nextSession.transcript_revision = nextRevision;
  }
  commit(nextSession);
}

export function applyTranscriptEvent(event) {
  const eventKind = event?.kind || event?.type || "";
  if (!state.session) {
    return;
  }

  if (eventKind === "transcript_entry_delta") {
    applyTranscriptDelta({
      ...event,
      delta_kind: event.delta_kind || event.entry_kind || event.entry?.kind,
      kind: event.entry_kind || event.entry?.kind,
    });
    return;
  }

  if (
    eventKind === "transcript_entry_started"
    || eventKind === "transcript_entry_completed"
    || eventKind === "transcript_entry_patched"
  ) {
    applyTranscriptEntryPatch(event, {
      defaultStatus:
        eventKind === "transcript_entry_completed"
          ? "completed"
          : eventKind === "transcript_entry_started"
            ? "running"
            : null,
    });
    return;
  }

  if (eventKind === "approval_added") {
    const approval = event.approval || event.request || null;
    if (!approval?.request_id) {
      return;
    }
    const liveSession = currentLiveSession();
    applySessionMetadataPatch({
      pending_approvals: upsertApproval(liveSession?.pending_approvals || [], approval),
    });
    return;
  }

  if (eventKind === "approval_resolved") {
    const requestId = event.request_id || event.approval?.request_id || null;
    if (!requestId) {
      return;
    }
    const liveSession = currentLiveSession();
    applySessionMetadataPatch({
      pending_approvals: (liveSession?.pending_approvals || [])
        .filter((approval) => approval?.request_id !== requestId),
    });
    return;
  }

  if (eventKind === "session_meta_updated") {
    applySessionMetadataPatch(event.session || event.patch || event);
  }
}

export function applySessionSnapshot(snapshot) {
  if (typeof window !== "undefined" && typeof window.__snapshotCount === "number") {
    window.__snapshotCount++;
  }
  // Captured before the realSession sync below so an INBOUND pending->real
  // promotion (another device sent the first message) is still visible.
  const previousActiveThreadId =
    state.realSession?.active_thread_id || state.session?.active_thread_id || null;
  // Keep the authoritative live snapshot aligned with the rendered session
  // whenever no client-local projection is active. This also preserves live
  // transcript deltas that arrived after the previous full snapshot.
  if (!state.session) {
    state.realSession = null;
    viewOnlyThreadId = null;
  } else if (!state.session.view_only) {
    state.realSession = state.session;
    if (
      viewOnlyThreadId
      && viewOnlyThreadId !== state.session.active_thread_id
    ) {
      viewOnlyThreadId = null;
    }
  }
  if (!shouldAcceptSessionSnapshot(snapshot)) {
    const currentRevision = numericRevision(state.realSession?.transcript_revision);
    const incomingRevision = numericRevision(snapshot?.transcript_revision);
    const message = `[session-snapshot] ignored stale revision=${incomingRevision ?? "-"} current=${currentRevision ?? "-"} thread=${snapshot?.active_thread_id || "-"}`;
    renderLog(message);
    console.log(message);
    return;
  }
  // Deferred-Claude promotion seen from the SNAPSHOT side — this is how every
  // client that didn't send the first message (a second remote observer, or a
  // remote watching while the local UI sends) learns about it. The sender path
  // in sendMessage() handles its own client explicitly.
  const inboundPromotion = detectDeferredThreadPromotion({
    previousThreadId: previousActiveThreadId,
    nextThreadId: snapshot?.active_thread_id || null,
    nextThreadPromotedFrom: snapshot?.active_thread_promoted_from || null,
  });
  if (inboundPromotion) {
    // One-shot scroll-bookkeeping alias for the transcript pane (it clears it
    // after rekeying).
    state.promotedThreadAlias = inboundPromotion;
    if (
      shouldRebindPinnedViewOnPromotion({
        pinnedThreadId: viewOnlyThreadId,
        promotion: inboundPromotion,
      })
    ) {
      // The pending thread ceased to exist; without re-pinning, the
      // projection would keep rendering the stale pending transcript forever.
      viewOnlyNavigationGeneration += 1;
      viewOnlyThreadId = inboundPromotion.to;
      viewOnlyLastRefreshAt = Date.now();
      viewOnlyWasWorking = Boolean(snapshot?.active_turn_id);
      clearTranscriptHydration(state);
    }
  }
  const displaySnapshot = stampThreadActivitySnapshotTime(
    preserveVisibleTranscriptText(state.realSession, snapshot)
  );
  state.realSession = displaySnapshot;
  const previousThreadId = state.session?.active_thread_id || "-";
  const viewingLiveThread =
    viewOnlyThreadId && displaySnapshot.active_thread_id === viewOnlyThreadId;
  const projectedSnapshot = viewOnlyThreadId && !viewingLiveThread
    ? projectRemoteViewedSession(displaySnapshot, viewOnlyThreadId, state.session)
    : displaySnapshot;
  syncLiveTranscriptEntryDetailsFromSnapshot(state, projectedSnapshot);
  const effectiveSnapshot = viewOnlyThreadId && !viewingLiveThread
    ? projectedSnapshot
    : restoreHydratedTranscript(state, projectedSnapshot);
  transcriptFrameRenderQueue.cancel();
  applyRenderedSession(effectiveSnapshot, {
    hydrationSnapshot: displaySnapshot,
    hydrateTranscript: !viewOnlyThreadId || viewingLiveThread,
  });
  maybeRefreshRemoteViewedThread(displaySnapshot);
  // Keep the relay's idea of what this phone is watching in step with what it is
  // actually rendering. Deduped internally, so this is one frame per real change.
  declareWatchedThreads();
  // Derive per-thread attention flags from the snapshot stream and fire browser
  // notifications for threads the user isn't actively watching. Best-effort:
  // never let a notification hiccup break snapshot rendering.
  try {
    const viewedThreadId = viewOnlyThreadId || snapshot?.active_thread_id || null;
    const events = threadAttention.ingest(snapshot, {
      viewedThreadId,
      isForeground: isDocumentForeground(),
    });
    notifyThreadEvents(events);
  } catch (error) {
    renderLog(`[thread-attention] ingest failed: ${error?.message || error}`);
  }
  // Everything below is diagnostics, and it is not cheap: reading `scrollHeight`
  // forces a synchronous layout of the whole transcript subtree, and `renderLog` is a
  // `patchRemoteState` — a full RemoteApp re-render. Both were paid on EVERY snapshot,
  // including the identical idle snapshots a relay repeats for a thread this surface
  // is not even displaying. Behind the flag, a snapshot costs neither.
  if (!isVerboseBrokerLoggingEnabled()) {
    return;
  }
  const scrollTop = remoteUiRefs.remoteTranscript?.scrollTop || 0;
  const scrollHeight = remoteUiRefs.remoteTranscript?.scrollHeight || 0;
  const clientHeight = remoteUiRefs.remoteTranscript?.clientHeight || 0;
  const windowY =
    typeof window.scrollY === "number"
      ? window.scrollY
      : typeof window.pageYOffset === "number"
        ? window.pageYOffset
        : 0;
  const restored =
    effectiveSnapshot !== displaySnapshot
      || (displaySnapshot?.transcript_truncated && !effectiveSnapshot?.transcript_truncated)
      ? "1"
      : "0";
  const message = `[scroll] applySessionSnapshot prev=${previousThreadId} input=${displaySnapshot?.active_thread_id || "-"} effective=${effectiveSnapshot?.active_thread_id || "-"} state=${state.session?.active_thread_id || "-"} in_truncated=${displaySnapshot?.transcript_truncated ? "1" : "0"} out_truncated=${effectiveSnapshot?.transcript_truncated ? "1" : "0"} restored=${restored} hydration=${state.transcriptHydrationStatus} older_cursor=${state.transcriptHydrationOlderCursor ?? "-"} entries=${effectiveSnapshot?.transcript?.length || 0} top=${scrollTop} height=${scrollHeight} client=${clientHeight} winY=${windowY}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once snapshot scroll restoration is stable.
  console.log(message);
}

function preserveVisibleTranscriptText(currentSession, snapshot) {
  if (
    !currentSession?.active_thread_id
    || !snapshot?.active_thread_id
    || currentSession.active_thread_id !== snapshot.active_thread_id
    || !Array.isArray(currentSession.transcript)
    || !Array.isArray(snapshot.transcript)
  ) {
    return snapshot;
  }

  const currentByItemId = new Map(
    currentSession.transcript
      .filter((entry) => entry?.item_id)
      .map((entry) => [entry.item_id, entry])
  );
  let changed = false;
  const transcript = snapshot.transcript.map((entry) => {
    const current = currentByItemId.get(entry?.item_id);
    const resolved = selectVisibleSnapshotEntry(current, entry);
    if (resolved === entry) {
      return entry;
    }
    changed = true;
    return resolved;
  });

  return changed
    ? {
      ...snapshot,
      transcript,
    }
    : snapshot;
}

// Authoritative (`full`) content is anything not explicitly flagged
// `preview`/`omitted` by snapshot compaction — including a genuine body that
// ends in "...". String-suffix inference is intentionally gone.
function isFullSnapshotEntry(entry) {
  const state = entry?.content_state;
  return state !== "preview" && state !== "omitted";
}

function selectLongerVisibleText(existingText, incomingText) {
  if (incomingText == null) {
    return existingText ?? null;
  }
  if (existingText == null) {
    return incomingText;
  }
  return incomingText.length >= existingText.length ? incomingText : existingText;
}

function selectVisibleSnapshotEntry(current, incoming) {
  const currentText = current?.text;
  const incomingText = incoming?.text;
  // Take the incoming entry as-is when it is authoritative, or when we have no
  // full text of our own to protect.
  if (
    isFullSnapshotEntry(incoming)
    || typeof currentText !== "string"
    || !isFullSnapshotEntry(current)
  ) {
    return incoming;
  }
  // Omitted: the incoming shell text is meaningless, so keep our visible body —
  // but DO NOT promote content_state to full. The snapshot still says "omitted",
  // so the hydration store re-fetches the authoritative body (promoting it here
  // would defeat re-hydration and freeze a stale body).
  if (incoming?.content_state === "omitted") {
    return {
      ...incoming,
      text: currentText,
    };
  }
  // Preview: keep our visible body only if it is at least as long (more
  // complete); otherwise the grown preview is fresher. Either way the incoming
  // content_state (preview) is preserved so hydration still settles the entry.
  if (currentText.length >= incomingText.length) {
    return {
      ...incoming,
      text: currentText,
    };
  }
  return incoming;
}

function shouldAcceptSessionSnapshot(snapshot) {
  if (!snapshot) {
    return false;
  }
  const incomingThreadId = snapshot.active_thread_id || null;
  const currentThreadId = state.realSession?.active_thread_id || null;
  if (!incomingThreadId || incomingThreadId !== currentThreadId) {
    return true;
  }

  const incomingRevision = numericRevision(snapshot.transcript_revision);
  const currentRevision = numericRevision(state.realSession?.transcript_revision);
  return incomingRevision == null || currentRevision == null || incomingRevision >= currentRevision;
}

export function projectRemoteViewedSession(realSession, threadId, currentView) {
  const thread = (state.threads || []).find((candidate) => candidate?.id === threadId);
  const activity = (realSession?.thread_activity || []).find(
    (entry) => entry?.thread_id === threadId
  );
  const threadState = currentView?.thread_state || currentView || {};
  const explicitTurnId = threadState.active_turn_id || null;
  const explicitStatus =
    threadState.current_status == null ? "" : String(threadState.current_status).trim();
  const hasExplicitThreadState = Boolean(explicitTurnId || explicitStatus);
  const explicitWorking = Boolean(
    explicitTurnId || (explicitStatus && isWorkingThreadStatus(explicitStatus))
  );
  // The viewed thread state comes from an independent transcript-page fetch. When
  // that fetch is newer and says the viewed thread is idle, ignore an older
  // thread_activity row from the compact live snapshot so mobile does not keep
  // the composer locked forever.
  const viewRefreshTime = viewedRefreshServerTime(currentView);
  const snapshotTime = threadActivityServerTime(realSession);
  const activityFreshEnough =
    !viewRefreshTime || !snapshotTime || snapshotTime >= viewRefreshTime;
  const isWorking = explicitWorking || Boolean(
    activity && (!hasExplicitThreadState || activityFreshEnough)
  );
  const currentPhase = isWorking
    ? threadState.current_phase ?? activity?.phase ?? null
    : null;
  const currentTool = isWorking
    ? threadState.current_tool ?? activity?.tool ?? null
    : null;
  const pendingApprovals = (realSession?.pending_approvals || []).filter(
    (entry) => entry?.thread_id === threadId
  );
  const pendingQuestions = (realSession?.pending_ask_user_questions || []).filter(
    (entry) => entry?.thread_id === threadId
  );
  return {
    ...(realSession || {}),
    active_controller_device_id: "__view_only__",
    active_controller_last_seen_at: null,
    active_flags: [],
    active_thread_id: threadId,
    active_turn_id: explicitTurnId || (isWorking ? `view:${threadId}` : null),
    controller_lease_expires_at: null,
    current_cwd: threadState.current_cwd || thread?.cwd || "",
    current_phase: currentPhase,
    current_status: threadState.current_status
      || (isWorking ? "active" : settledThreadStatus(thread?.status)),
    current_tool: currentTool,
    last_progress_at: threadState.last_progress_at ?? null,
    provider: threadState.provider || thread?.provider || "",
    model: threadState.model || "",
    reasoning_effort: threadState.reasoning_effort || "",
    approval_policy: threadState.approval_policy || "",
    sandbox: threadState.sandbox || "",
    available_models: threadState.available_models || [],
    // The viewed thread's OWN reviewers. The global remote snapshot scopes
    // reviewer_threads to the active parent, so without this a viewed non-active
    // thread shows fewer reviewers than local; the per-thread read supplies them
    // on view entry (currentView.thread_state.reviewers). On a later snapshot /
    // live delta, currentView is the previously-projected session (no thread_state,
    // value already under reviewer_threads), so fall back to that — otherwise the
    // set collapses to [] on the first re-projection.
    reviewer_threads: threadState.reviewers ?? currentView?.reviewer_threads ?? [],
    review_locked: Boolean(threadState.review_locked),
    workflow_locked: Boolean(threadState.workflow_locked ?? currentView?.workflow_locked),
    settings_writable: Boolean(threadState.settings_writable),
    pending_approvals: pendingApprovals,
    pending_ask_user_questions: pendingQuestions,
    transcript:
      currentView?.active_thread_id === threadId ? currentView.transcript || [] : [],
    transcript_revision:
      currentView?.active_thread_id === threadId ? currentView.transcript_revision || 0 : 0,
    transcript_truncated:
      currentView?.active_thread_id === threadId
        ? Boolean(currentView.transcript_truncated)
        : false,
    view_only: true,
    view_last_refresh_server_time: viewRefreshTime || null,
  };
}

function serverTimeSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function snapshotServerTime(session) {
  return serverTimeSeconds(session?.server_time);
}

function threadActivityServerTime(session) {
  return serverTimeSeconds(session?.thread_activity_server_time) || snapshotServerTime(session);
}

function viewedRefreshServerTime(currentView) {
  return serverTimeSeconds(
    currentView?.view_last_refresh_server_time ?? currentView?.server_time
  );
}

function stampThreadActivitySnapshotTime(snapshot) {
  if (!snapshot) {
    return snapshot;
  }
  const snapshotTime = snapshotServerTime(snapshot);
  return snapshotTime
    ? {
      ...snapshot,
      thread_activity_server_time: snapshotTime,
    }
    : snapshot;
}

function settledThreadStatus(status) {
  const normalized = typeof status === "string" ? status.toLowerCase() : "";
  return normalized === "active" || normalized === "running" || normalized === "working"
    ? "idle"
    : status || "idle";
}

function applyTranscriptEntryPatch(event, { defaultStatus = null } = {}) {
  const currentSession = currentLiveSession();
  if (!currentSession) {
    return;
  }
  const currentThreadId = currentSession.active_thread_id || null;
  const eventThreadId = event.thread_id || event.active_thread_id || event.entry?.thread_id || null;
  if (eventThreadId && currentThreadId && eventThreadId !== currentThreadId) {
    return;
  }
  if (!shouldAcceptTranscriptRevision(event)) {
    scheduleTranscriptGapRepair(
      currentThreadId || eventThreadId,
      "entry_patch_revision_mismatch",
      event.revision ?? event.transcript_revision,
      {
        base_revision: event.base_revision,
        current: currentSession.transcript_revision,
        item: event.item_id || event.entry?.item_id,
      }
    );
    return;
  }

  const incoming = event.entry || {
    item_id: event.item_id,
    entry_seq: event.entry_seq,
    kind: event.entry_kind || event.kind,
    status: event.status,
    text: event.text,
    tool: event.tool,
    turn_id: event.turn_id,
  };
  const itemId = incoming.item_id || event.item_id;
  if (!itemId || !Array.isArray(currentSession.transcript)) {
    return;
  }

  const entryPatch = {
    ...incoming,
    item_id: itemId,
    kind: incoming.kind || event.entry_kind
      ? normalizeTranscriptEventEntryKind(incoming.kind || event.entry_kind)
      : null,
    status: incoming.status || defaultStatus || "completed",
    turn_id: incoming.turn_id || event.turn_id || null,
  };
  const entryIndex = currentSession.transcript.findIndex((entry) => entry.item_id === itemId);
  const nextTranscript = entryIndex >= 0
    ? currentSession.transcript.map((entry, index) => {
        if (index !== entryIndex) {
          return entry;
        }
        return {
          ...entry,
          ...entryPatch,
          kind: entryPatch.kind || entry.kind || "agent_text",
          text: entryPatch.text ?? entry.text ?? null,
          tool: entryPatch.tool ?? entry.tool ?? null,
          turn_id: entryPatch.turn_id || entry.turn_id || null,
        };
      })
    : [
        ...currentSession.transcript,
        {
          text: entryPatch.text ?? "",
          tool: entryPatch.tool ?? null,
          ...entryPatch,
          kind: entryPatch.kind || "agent_text",
        },
      ];

  const nextSession = {
    ...currentSession,
    transcript: nextTranscript,
  };
  const eventRevision = numericRevision(event.revision ?? event.transcript_revision);
  if (eventRevision != null) {
    nextSession.transcript_revision = eventRevision;
  }
  if (Number.isSafeInteger(event.server_time)) {
    nextSession.server_time = event.server_time;
  }
  commitLiveSession(nextSession);
}

function applySessionMetadataPatch(patch) {
  const currentSession = currentLiveSession();
  if (!currentSession || !patch) {
    return;
  }
  const {
    kind: _kind,
    type: _type,
    transcript: _transcript,
    transcript_truncated: _transcriptTruncated,
    ...metadata
  } = patch;
  const nextSession = {
    ...currentSession,
    ...metadata,
    transcript: currentSession.transcript,
    transcript_truncated: currentSession.transcript_truncated,
  };
  if (Object.prototype.hasOwnProperty.call(metadata, "thread_activity")) {
    nextSession.thread_activity_server_time =
      serverTimeSeconds(metadata.server_time) || currentSession.thread_activity_server_time || null;
  }
  commitLiveSession(nextSession);
}

function shouldAcceptTranscriptRevision(event) {
  const currentRevision = numericRevision(
    currentLiveSession()?.transcript_revision
  );
  const eventBaseRevision = numericRevision(event.base_revision);
  const eventRevision = numericRevision(event.revision ?? event.transcript_revision);
  if (eventRevision != null && currentRevision != null && eventRevision < currentRevision) {
    return false;
  }
  return !(eventBaseRevision != null && currentRevision != null && eventBaseRevision !== currentRevision);
}

function currentLiveSession() {
  return state.session?.view_only ? state.realSession : state.session;
}

/// Commit a delta into the VIEW-ONLY projection.
///
/// Deliberately does not touch `state.realSession`: the live session still belongs to
/// whatever thread the relay has active, and folding a watched background thread's
/// text into it would corrupt the transcript the user sees on switching back.
// Declaring which threads this phone has on screen, so the relay streams their deltas
// here and nothing else. Without a declaration the relay falls back to "just the active
// thread", which is exactly the pre-subscription behavior — so a stale client degrades
// rather than going silent.
/// Forget the last declaration so the next snapshot re-sends it.
///
/// The relay clears a surface's watch set when the broker connection drops, so a
/// reconnect starts unsubscribed. Without this the phone would consider the set
/// already sent and never re-declare, leaving background threads on polling.
export function resetDeclaredWatchedThreads() {
  lastDeclaredWatchKey = null;
}

export function declareWatchedThreads() {
  const live = state.realSession || state.session;
  const threadIds = [];
  // The phone renders ONE conversation: the pinned thread when reading view-only,
  // otherwise the live thread.
  const viewed = viewOnlyThreadId || live?.active_thread_id || null;
  if (viewed) {
    threadIds.push(viewed);
  }
  // The peer id is part of the key BECAUSE the relay stores watch sets per broker
  // peer and drops them when the connection ends. A reconnect mints a new peer id, so
  // including it makes the identical thread set re-declare automatically — without it
  // the dedupe would suppress the re-send and background threads would silently fall
  // back to polling until the user switched threads.
  const key = `${state.socketPeerId || "-"}|${threadIds.join(" ")}`;
  // Called from the snapshot path, so without this dedupe every snapshot would
  // become an outbound frame.
  if (key === lastDeclaredWatchKey) {
    return false;
  }
  lastDeclaredWatchKey = key;
  // `dispatchRemoteActionWithoutReply` is async, so a socket that is not up yet
  // REJECTS rather than throwing — a try/catch around the call would miss it and
  // leave an unhandled rejection behind.
  dispatchRemoteActionWithoutReply("watch_threads", {
    input: { thread_ids: threadIds },
  }).catch((error) => {
    // Not paired / not connected yet. Forget the key so the next snapshot retries,
    // otherwise this surface would sit on a subscription the relay never received.
    lastDeclaredWatchKey = null;
    renderLog(`[watch-threads] declaration failed: ${error?.message || error}`);
  });
  return true;
}

/// Commit a delta into the VIEW-ONLY projection.
///
/// Deliberately does not touch `state.realSession`: the live session still belongs to
/// whatever thread the relay has active, and folding a watched background thread's
/// text into it would corrupt the transcript the user sees on switching back.
function commitViewedSession(nextViewedSession) {
  state.session = nextViewedSession;
  transcriptFrameRenderQueue.queue();
}

function commitLiveSession(nextLiveSession) {
  state.realSession = nextLiveSession;
  let nextRenderedSession = nextLiveSession;
  if (viewOnlyThreadId && viewOnlyThreadId !== nextLiveSession.active_thread_id) {
    nextRenderedSession = projectRemoteViewedSession(
      nextLiveSession,
      viewOnlyThreadId,
      state.session
    );
  }
  // Advance reducer state synchronously so every delta in this frame appends to
  // the latest text. Subscriber notification and React reconciliation are the
  // expensive part, so those are coalesced to one animation-frame render.
  state.session = nextRenderedSession;
  transcriptFrameRenderQueue.queue();
}

function normalizeTranscriptEventEntryKind(kind) {
  if (
    kind === "user_text"
    || kind === "agent_text"
    || kind === "command"
    || kind === "tool_call"
    || kind === "reasoning"
  ) {
    return kind;
  }
  return transcriptDeltaKindToEntryKind(kind || "agent_text");
}

function upsertApproval(approvals, incoming) {
  const existingIndex = approvals.findIndex(
    (approval) => approval?.request_id === incoming.request_id
  );
  if (existingIndex === -1) {
    return [...approvals, incoming];
  }
  return approvals.map((approval, index) =>
    index === existingIndex ? { ...approval, ...incoming } : approval
  );
}

function numericRevision(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function numericOffset(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function syncRemoteSnapshot(reason, silent = false) {
  if (!silent) {
    renderLog(`Syncing remote session (${reason}).`);
  }

  try {
    await dispatchRemoteActionWithoutReply("heartbeat", {
      input: {},
    });
  } catch (error) {
    renderLog(`Remote heartbeat sync failed: ${error.message}`);
  }

  try {
    await refreshRemoteThreads(reason, { silent: true });
  } catch (error) {
    renderLog(`Remote session sync failed: ${error.message}`);
  }
}

export async function startRemoteSession(sessionDraftOverride = null) {
  // Explicit live action: invalidate pending view fetches and let live snapshots flow.
  invalidateViewOnlyNavigation();
  const sessionDraft = sessionDraftOverride;
  if (!sessionDraft) {
    throw new Error("startRemoteSession requires a session draft");
  }
  const cwd = sessionDraft.cwd.trim();
  if (!cwd) {
    renderLog("Choose a workspace before starting a remote session.");
    return false;
  }

  renderLog(`Starting remote session in ${cwd}.`);

  try {
    await dispatchOrRecover("start_session", {
      input: {
        cwd,
        initial_prompt: sessionDraft.initialPrompt.trim() || null,
        model: sessionDraft.model.trim() || null,
        approval_policy: sessionDraft.approvalPolicy,
        sandbox: sessionDraft.sandbox,
        effort: sessionDraft.effort,
        provider: sessionDraft.provider,
      },
    });
    return true;
  } catch (error) {
    renderLog(`Remote start failed: ${error.message}`);
    return false;
  }
}

export async function forkRemoteSession(forkDraft = null) {
  invalidateViewOnlyNavigation();
  if (!forkDraft?.sourceThreadId) {
    return { ok: false, error: "Choose a session to fork." };
  }
  const cwd = String(forkDraft.cwd || "").trim();
  if (!cwd) {
    return { ok: false, error: "Choose a workspace before forking a remote session." };
  }

  renderLog(`Forking remote session ${forkDraft.sourceThreadId}.`);

  try {
    // Untouched settings go out as null so the relay inherits them from the
    // SOURCE thread rather than from whatever session is open here.
    await dispatchOrRecover("fork_session", {
      input: forkFieldsToPayload({ ...forkDraft, cwd }),
    });
    return { ok: true };
  } catch (error) {
    renderLog(`Remote fork failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

export async function fetchRemoteProviders() {
  if (!state.remoteAuth) {
    return [];
  }
  const result = await dispatchOrRecover("list_providers", {});
  return result.providers || [];
}

export async function fetchRemoteProviderModels(provider) {
  if (!state.remoteAuth || !provider) {
    return [];
  }
  const result = await dispatchOrRecover("list_provider_models", {
    provider,
  });
  return result.models || [];
}

// Generation counter for the remote list. Bypassing de-duplication means two list
// requests can be in flight at once with no ordering guarantee, so the OLDER one must not
// land on top of the newer one's data — after a rename, the stale answer is precisely the
// one that predates it.
let remoteThreadsGeneration = 0;

export async function refreshRemoteThreads(reason, options = {}) {
  // `fresh` bypasses the query cache's in-flight de-duplication — see
  // `fetchThreadListFresh`. Used when the refresh answers a KNOWN mutation (a rename,
  // here or on another device) rather than a poll.
  const { silent = false, fresh = false } = options;
  const generation = ++remoteThreadsGeneration;

  if (!silent) {
    renderLog(`Fetching remote session list (${reason}).`);
  }

  try {
    const queryOptions = {
      fetchThreads: fetchRemoteThreads,
      limit: 80,
      scope: remoteQueryScope(),
      surface: "remote",
    };
    const threads = fresh
      ? await fetchThreadListFresh({ ...queryOptions, queryClient: remoteQueryClient })
      : await remoteQueryClient.fetchQuery(createThreadListQueryOptions(queryOptions));
    // Superseded by a newer refresh while this one was in flight — its result is the
    // older view of the list, so applying it would undo the newer one.
    if (generation !== remoteThreadsGeneration) {
      return threads;
    }
    applyRemoteSurfacePatch(createRemoteThreadsPatch(threads));
    return threads;
  } catch (error) {
    // A superseded refresh did not fail — it was overtaken, and a fresh fetch CANCELS the
    // request it replaced (evicting the query destroys its retryer). Reporting that as
    // "Remote session refresh failed" would put an error banner on the screen every time
    // a rename overtook the 12s poll, for a refresh whose result was going to be thrown
    // away regardless. Swallow it; the newer request owns the repaint.
    if (generation !== remoteThreadsGeneration) {
      return [];
    }
    if (!silent) {
      renderLog(`Remote session refresh failed: ${error.message}`);
    }
    throw error;
  } finally {
    // Re-arm the recurring poll on every refresh — the same chokepoint pattern
    // local uses (loadThreads()'s finally schedules the next scheduleThreadsPoll).
    // Recovery's initial refresh starts the loop; manual refreshes just reset the
    // 12s clock. Without this, remote's left list would freeze between manual
    // refreshes while local's keeps its timestamps and ordering live.
    scheduleRemoteThreadsPoll();
  }
}

// Cadence matches the local surface's thread poll (frontend/local/session/polling.js)
// so the remote sidebar refreshes its timestamps and reorders on the same beat.
const REMOTE_THREADS_POLL_INTERVAL_MS = 12_000;

export function scheduleRemoteThreadsPoll() {
  if (typeof window === "undefined") {
    return;
  }
  // Unpaired surfaces have nothing to poll; clearing here means teardown paths
  // that drop remoteAuth (return home / forget device) stop the loop for free.
  if (!state.remoteAuth) {
    cancelRemoteThreadsPoll();
    return;
  }
  if (state.remoteThreadsPollTimer) {
    window.clearTimeout(state.remoteThreadsPollTimer);
  }
  state.remoteThreadsPollTimer = window.setTimeout(
    runRemoteThreadsPoll,
    REMOTE_THREADS_POLL_INTERVAL_MS
  );
}

export function cancelRemoteThreadsPoll() {
  if (!state.remoteThreadsPollTimer) {
    return;
  }
  window.clearTimeout(state.remoteThreadsPollTimer);
  state.remoteThreadsPollTimer = null;
}

function runRemoteThreadsPoll() {
  state.remoteThreadsPollTimer = null;
  if (!state.remoteAuth) {
    return;
  }
  if (!state.socketConnected) {
    // Broker is down: skip the round trip (it would only time out) but keep the
    // loop alive so polling resumes the moment the socket reconnects.
    scheduleRemoteThreadsPoll();
    return;
  }
  // refreshRemoteThreads re-arms the next poll from its finally block.
  void refreshRemoteThreads("poll", { silent: true }).catch(() => {});
}

/**
 * The raw page, including which providers could not be listed.
 *
 * A failed provider is dropped from the merge and the action still succeeds, so "zero
 * threads" and "half the providers were unreachable" arrive identically unless the
 * caller reads this. It only matters for search — where an empty answer reads as "that
 * session does not exist" — but it rides both paths so there is one shape.
 */
export async function fetchRemoteThreadPage({ limit = 80, q = "", ids = null } = {}) {
  if (!state.remoteAuth) {
    return { threads: [], unavailableProviders: [] };
  }

  const query = { limit };
  if (q) {
    query.q = q;
  }
  // Ask about specific sessions instead of for a page. The relay scans as deeply as a
  // search for these and does not truncate to `limit`, so absence from the answer means
  // it genuinely could not resolve the id — the one thing a page cannot tell you, because
  // its bound applies to the provider scan too. See `ThreadsQuery.ids`.
  if (Array.isArray(ids) && ids.length) {
    query.ids = ids;
  }
  const result = await dispatchOrRecover("list_threads", { query });
  return {
    threads: result.threads?.threads || [],
    unavailableProviders: result.threads?.unavailable_providers || [],
  };
}

export async function fetchRemoteThreads(options = {}) {
  return (await fetchRemoteThreadPage(options)).threads;
}

/**
 * Ask the relay which of these sessions it can still resolve.
 *
 * Deliberately NOT routed through the thread-list query cache. That cache is keyed by the
 * resting list, and a probe is a different question with a different answer shape —
 * seeding it would let a narrow probe answer a later request for the whole page.
 */
export async function probeRemoteThreadsExist(threadIds) {
  const ids = [...new Set((threadIds || []).filter(Boolean))];
  if (!ids.length) {
    return { threads: [], unavailableProviders: [] };
  }
  return fetchRemoteThreadPage({ limit: ids.length, ids });
}

let remoteThreadSearchGeneration = 0;
let remoteThreadSearchTimer = null;
let remoteThreadSearchCancelToken = 0;

/**
 * Debounce a query. The timer lives HERE, not in the component, so that every path that
 * tears the surface down cancels it along with the request — a timer owned by React is
 * invisible to `createResetRemoteSurfaceStatePatch` and can fire against whatever
 * connection replaced the one it was typed into.
 */
export function queueRemoteThreadSearch(rawQuery, delayMs = 180) {
  window.clearTimeout(remoteThreadSearchTimer);
  remoteThreadSearchTimer = null;
  if (!normalizeThreadSearchQuery(rawQuery)) {
    // Clearing is not a fetch — apply it at once so the list snaps back rather than
    // sitting on stale matches for another debounce window.
    void searchRemoteThreads("");
    return;
  }
  remoteThreadSearchTimer = window.setTimeout(() => {
    remoteThreadSearchTimer = null;
    void searchRemoteThreads(rawQuery);
  }, delayMs);
}

/**
 * Abandon everything a search owns: the pending keystroke timer, any answer still in
 * flight, and the results on screen.
 *
 * Bumping the generation is what makes an in-flight answer land nowhere. Relay identity
 * alone is not enough — re-pairing tears the surface down while KEEPING the current
 * relay id, so a rejected request would otherwise pass the identity check and write its
 * error back over state that was just cleared.
 */
export function cancelRemoteThreadSearch() {
  window.clearTimeout(remoteThreadSearchTimer);
  remoteThreadSearchTimer = null;
  remoteThreadSearchGeneration += 1;
  remoteThreadSearchCancelToken += 1;
  applyRemoteSurfacePatch({
    threadSearch: { ...EMPTY_THREAD_SEARCH },
    // Lets the component drop the text still in its field. The draft is React's, and a
    // reset has no other way to reach it.
    threadSearchCancelToken: remoteThreadSearchCancelToken,
  });
}

/**
 * Run a title search, or clear one when `rawQuery` is blank.
 *
 * Deliberately NOT through the query cache. `threadListQueryKey` keys on `{limit}` only
 * and `createThreadListQueryOptions` hardcodes `queryFn: () => fetchThreads({limit})`,
 * so a cached search would share a key with the 12s poll — each would serve the other's
 * answer. Local sidesteps it the same way.
 *
 * Results land in `state.threadSearch` and NOWHERE else: `state.threads` stays the
 * authoritative list that the poll, the render model and every id lookup read.
 */
export async function searchRemoteThreads(rawQuery) {
  const query = normalizeThreadSearchQuery(rawQuery);
  const generation = ++remoteThreadSearchGeneration;
  // Captured, not read at completion: a relay switch mid-flight must invalidate the
  // answer even if the generation happened to line up.
  const relayId = state.remoteAuth?.relayId || null;
  const stillCurrent = () =>
    generation === remoteThreadSearchGeneration && (state.remoteAuth?.relayId || null) === relayId;

  if (!query) {
    // Clearing is not a fetch — snap back rather than flashing stale matches.
    applyRemoteSurfacePatch(createRemoteThreadSearchPatch({ ...EMPTY_THREAD_SEARCH }));
    return;
  }

  applyRemoteSurfacePatch(
    createRemoteThreadSearchPatch({
      ...state.threadSearch,
      query,
      loading: true,
      error: null,
    })
  );

  try {
    // 80, not local's 120: the remote surface's response budget caps the list at 80
    // (THREADS_RESPONSE_REMOTE_SURFACE_BUDGET) and reduces further under byte pressure,
    // so asking for more would be silently trimmed and the count line would lie.
    const { threads, unavailableProviders } = await fetchRemoteThreadPage({ limit: 80, q: query });
    if (!stillCurrent()) {
      return;
    }
    applyRemoteSurfacePatch(
      createRemoteThreadSearchPatch({
        query,
        groups: buildNavigationThreadGroups(threads),
        loading: false,
        error: null,
        unavailableProviders,
      })
    );
  } catch (error) {
    if (!stillCurrent()) {
      return;
    }
    applyRemoteSurfacePatch(
      createRemoteThreadSearchPatch({
        query,
        groups: [],
        loading: false,
        error: error.message || "Search failed",
        unavailableProviders: [],
      })
    );
  }
}

export async function resumeRemoteSession(threadId, _sessionDraftOverride = null) {
  if (!threadId) {
    return;
  }
  // Explicit live action: invalidate pending view fetches and let live snapshots flow.
  invalidateViewOnlyNavigation();

  renderLog(`Resuming remote session ${threadId}.`);

  try {
    await dispatchOrRecover("resume_session", {
      input: {
        thread_id: threadId,
      },
    });
    return true;
  } catch (error) {
    renderLog(`Remote resume failed: ${error.message}`);
    return false;
  }
}

export async function updateRemoteSessionSettings({ approval_policy, sandbox, effort, model } = {}) {
  if (!state.session?.active_thread_id) {
    return false;
  }
  const input = { thread_id: state.session.active_thread_id };
  if (typeof approval_policy === "string" && approval_policy) {
    input.approval_policy = approval_policy;
  }
  if (typeof sandbox === "string" && sandbox) {
    input.sandbox = sandbox;
  }
  if (typeof effort === "string" && effort) {
    input.effort = effort;
  }
  if (typeof model === "string" && model) {
    input.model = model;
  }
  if (
    !("approval_policy" in input)
    && !("sandbox" in input)
    && !("effort" in input)
    && !("model" in input)
  ) {
    return false;
  }

  try {
    await dispatchOrRecover("update_session_settings", { input });
    const parts = [];
    if (input.approval_policy) parts.push(`approval=${input.approval_policy}`);
    if (input.sandbox) parts.push(`sandbox=${input.sandbox}`);
    if (input.effort) parts.push(`effort=${input.effort}`);
    if (input.model) parts.push(`model=${input.model}`);
    renderLog(`Updated remote session settings: ${parts.join(", ")}`);
    if (state.session?.view_only && state.session.active_thread_id === input.thread_id) {
      applyRenderedSession(
        {
          ...state.session,
          approval_policy: input.approval_policy || state.session.approval_policy,
          sandbox: input.sandbox || state.session.sandbox,
          reasoning_effort: input.effort || state.session.reasoning_effort,
          model: input.model || state.session.model,
        },
        { hydrateTranscript: false }
      );
    }
    return true;
  } catch (error) {
    renderLog(`Remote settings update failed: ${error.message}`);
    return false;
  }
}

export async function viewRemoteThread(threadId) {
  if (!threadId) {
    return false;
  }

  const navigationGeneration = ++viewOnlyNavigationGeneration;
  renderLog(`Viewing remote session ${threadId}.`);
  if (state.realSession?.active_thread_id === threadId) {
    viewOnlyThreadId = threadId;
    viewOnlyLastRefreshAt = Date.now();
    viewOnlyWasWorking = Boolean(state.realSession.active_turn_id);
    applyRenderedSession(state.realSession);
    return true;
  }

  try {
    const page = await fetchTranscriptPage({
      before: null,
      threadId,
    });
    // A newer view, resume, start, or relay reset won while this fetch was in
    // flight. Do not let this stale response restore an old read-only projection.
    if (navigationGeneration !== viewOnlyNavigationGeneration) {
      return false;
    }
    if (!page || page.thread_id !== threadId) {
      throw new Error("remote transcript page response is incomplete");
    }

    // Retain the leaving thread's loaded window and restore the target thread's
    // retained window (if any) instead of clearing — so switching between remote
    // threads and back keeps the older history scrolled into view. The page fetch
    // above still refreshes the tail; hydration merges it onto the restored
    // window, and scroll-up reuses the retained older pages without a refetch.
    switchTranscriptHydrationThread(state, threadId);
    // Pin this thread so incoming live snapshots update state.realSession while
    // leaving the user's local view in place.
    viewOnlyThreadId = threadId;
    viewOnlyLastRefreshAt = Date.now();
    if (!viewOnlyRefreshInFlight) {
      viewOnlyWasWorking = Boolean(
        (state.realSession?.thread_activity || []).find(
          (entry) => entry?.thread_id === threadId
        )
      );
    }
    applyRenderedSession(
      projectRemoteViewedSession(
        state.realSession || state.session,
        threadId,
        {
          active_thread_id: threadId,
          transcript: page.entries || [],
          transcript_revision: page.revision || 0,
          transcript_truncated: page.prev_cursor != null,
          thread_state: page.thread_state || null,
          view_last_refresh_server_time: page.server_time ?? null,
        }
      ),
      {
        hydrateTranscript: true,
      }
    );
    return true;
  } catch (error) {
    renderLog(`Remote session view failed: ${error.message}`);
    return false;
  }
}

function maybeRefreshRemoteViewedThread(realSession) {
  if (!viewOnlyThreadId || viewOnlyRefreshInFlight) {
    return;
  }
  const working = Boolean(
    (realSession?.thread_activity || []).find(
      (entry) => entry?.thread_id === viewOnlyThreadId
    )
  );
  const shouldRefresh = shouldRefreshViewedThread({
    elapsedMs: Date.now() - viewOnlyLastRefreshAt,
    wasWorking: viewOnlyWasWorking,
    working,
  });
  viewOnlyWasWorking = working;
  if (!shouldRefresh) {
    return;
  }
  const threadId = viewOnlyThreadId;
  viewOnlyRefreshInFlight = true;
  viewOnlyLastRefreshAt = Date.now();
  void viewRemoteThread(threadId).finally(() => {
    viewOnlyRefreshInFlight = false;
    maybeRefreshRemoteViewedThread(state.realSession);
  });
}

export async function sendMessage(messageDraft, effort, model = "") {
  if (typeof messageDraft !== "string" || typeof effort !== "string") {
    throw new Error("sendMessage requires a draft and effort");
  }
  const text = messageDraft.trim();
  if (!text) {
    renderLog("Message is empty.");
    return false;
  }
  const threadId = state.session?.active_thread_id;
  if (!threadId) {
    renderLog("No session is selected.");
    return false;
  }
  // A new attempt supersedes the last failure ON THIS THREAD only. Patched
  // (not assigned) so the composer re-renders on both the clear and the set.
  setComposerError(threadId, "");

  // Clamp the effort to the target model's supported set so a stale/foreign
  // value (e.g. a Claude-only "max" left on a codex thread) is never forwarded
  // and rejected with a 400 — the same guard the local composer applies.
  const outgoingEffort = resolveOutgoingEffort({
    override: effort,
    models: state.session?.available_models || [],
    model: model || state.session?.model || "",
  });

  try {
    await dispatchOrRecover("send_message", {
      input: {
        text,
        model,
        effort: outgoingEffort,
        thread_id: threadId,
      },
    });
    // Claude's first send promotes a synthetic pending id to the real SDK
    // session id. The action snapshot arrives while the old id is still pinned,
    // so it is initially projected back onto that stale id. Rebind the client-
    // local view after the successful targeted send and hydrate the real thread.
    const promotedThreadId = state.realSession?.active_thread_id || null;
    if (
      threadId.startsWith("claude-pending-")
      && viewOnlyThreadId === threadId
      && promotedThreadId
      && promotedThreadId !== threadId
    ) {
      viewOnlyNavigationGeneration += 1;
      viewOnlyThreadId = promotedThreadId;
      viewOnlyLastRefreshAt = Date.now();
      viewOnlyWasWorking = Boolean(state.realSession?.active_turn_id);
      // One-shot alias for the transcript pane: it keeps per-thread scroll
      // bookkeeping keyed by thread id, and must rekey it (same logical
      // thread, new public id) instead of treating the promotion as a thread
      // switch — which would jump-bottom and briefly re-enable live follow on
      // top of the freshly send-anchored message. Only this send path KNOWS
      // it's a promotion; a pending→other-id transition seen by the pane alone
      // could also be the user switching threads.
      state.promotedThreadAlias = { from: threadId, to: promotedThreadId };
      clearTranscriptHydration(state);
      applyRenderedSession(state.realSession);
    }
    return true;
  } catch (error) {
    renderLog(`Remote send failed: ${error.message}`);
    // Filed against the thread this send targeted (captured above), not the
    // live one: the user can switch sessions while the request is in flight,
    // and the reader only renders it while that thread is on screen.
    setComposerError(threadId, error.message);
    return false;
  }
}

/**
 * Publish (or clear, with an empty message) one thread's composer failure. The
 * relay's own message is kept verbatim — it names the thread and the reason,
 * which is the entire value of showing it at all. Keyed by thread so a request
 * settling late can only ever affect the thread it was aimed at; see
 * shared/composer-errors.js.
 */
function setComposerError(threadId, message) {
  patchRemoteState({
    composerErrors: withThreadError(state.composerErrors, threadId, message),
  });
}

export async function stopActiveTurn() {
  // Name the active thread's own provider — never a hardcoded "Codex".
  const agentName = providerLabel(state.session?.provider) || "agent";
  if (!state.session?.active_thread_id || !state.session.active_turn_id) {
    renderLog(`There is no running ${agentName} turn to stop.`);
    return false;
  }

  try {
    await dispatchOrRecover("stop_turn", {
      input: {
        thread_id: state.session.active_thread_id,
      },
    });
    renderLog(`Remote stop request sent to ${agentName}.`);
    return true;
  } catch (error) {
    renderLog(`Remote stop failed: ${error.message}`);
    return false;
  }
}

export async function takeOverControl() {
  const threadId = state.session?.active_thread_id || null;
  if (!threadId) {
    renderLog("There is no session to take over.");
    return false;
  }
  try {
    await dispatchOrRecover("take_over", {
      input: { thread_id: threadId },
    });
    return true;
  } catch (error) {
    renderLog(`Take over failed: ${error.message}`);
    return false;
  }
}

export async function submitDecision(decision, scope) {
  if (!state.currentApprovalId) {
    renderLog("No pending approval to submit.");
    return;
  }

  try {
    await dispatchOrRecover("decide_approval", {
      request_id: state.currentApprovalId,
      input: {
        decision,
        scope,
      },
    });
  } catch (error) {
    renderLog(`Approval failed: ${error.message}`);
  }
}

// Submit the user's answer to a pending AskUserQuestion via the broker
// remote_action channel. `answers` is the {questionText: label | label[] | freeText}
// map the SDK expects in updatedInput.answers.
export async function submitAskUserAnswer(requestId, answers) {
  if (!requestId) {
    renderLog("No pending AskUserQuestion to answer.");
    return;
  }
  try {
    await dispatchOrRecover("submit_ask_user_answer", {
      request_id: requestId,
      input: { answers },
    });
  } catch (error) {
    renderLog(`AskUserQuestion submit failed: ${error.message}`);
    throw error;
  }
}

export async function fetchAskUserQuestionDetail(requestId) {
  if (!requestId) {
    return null;
  }
  const result = await dispatchOrRecover("fetch_ask_user_question_detail", {
    request_id: requestId,
  });
  return result.ask_user_question_detail?.request || null;
}

export async function applyFileChange(itemId, direction) {
  if (!itemId) {
    renderLog("No file change selected.");
    return;
  }
  const threadId = state.session?.active_thread_id;
  if (!threadId) {
    renderLog("No session is selected.");
    return;
  }

  renderLog(`${direction === "rollback" ? "Rolling back" : "Reapplying"} file change ${itemId}`);

  try {
    await dispatchOrRecover("apply_file_change", {
      item_id: itemId,
      input: {
        direction,
        thread_id: threadId,
      },
    });
  } catch (error) {
    renderLog(`File change action failed: ${error.message}`);
  }
}

// The session this remote surface is currently viewing (a view-only pin, else the
// active thread). Shared so the diff request and its refetch-trigger key agree.
export function getRemoteViewedThreadId() {
  return viewOnlyThreadId || state.session?.active_thread_id || null;
}

// Identity of the viewed workspace (thread id + cwd): used to drop stale diff data
// on a view switch OR a same-thread cwd change during the load window.
export function getRemoteViewedWorkspaceKey() {
  return JSON.stringify([getRemoteViewedThreadId() || "", state.session?.current_cwd || ""]);
}

export async function fetchRemoteWorkspaceDiff(root = null, autoRoot = false) {
  const threadId = getRemoteViewedThreadId();
  const payload = {};
  if (threadId) payload.thread_id = threadId;
  // The relay validates this against the worktrees it enumerated for that session,
  // so a stale pin fails closed rather than reading a foreign tree.
  if (root) payload.root = root;
  // One-shot opt-in: land on where this thread has actually been writing.
  if (autoRoot) payload.auto_root = true;
  const result = await dispatchOrRecover("fetch_workspace_diff", payload);
  return result.workspace_diff;
}

// Cross-agent review actions over the broker. Each ack carries no snapshot, so
// we follow up with syncRemoteSnapshot to refresh review_activity/revisions.
export async function requestRemoteReview({
  reviewerProvider,
  reviewerModel,
  reviewerEffort,
  instructions,
  reviewerThreadId,
  parentThreadId,
  maxRounds,
  recapSource,
} = {}) {
  if (!reviewerProvider) {
    renderLog("Pick a reviewer provider before starting a review.");
    return false;
  }
  renderLog(
    reviewerThreadId
      ? `Requesting ${reviewerProvider} re-review.`
      : `Requesting ${reviewerProvider} review.`
  );
  try {
    await dispatchOrRecover("request_review", {
      input: {
        reviewer_provider: reviewerProvider,
        reviewer_model: reviewerModel || null,
        // Optional reasoning-effort override (clean or reuse).
        reviewer_effort: reviewerEffort || null,
        instructions: instructions || null,
        // Phase 3: reuse an existing reviewer thread when chosen.
        reviewer_thread_id: reviewerThreadId || null,
        // The thread to review (the viewed thread). null defaults to the active thread.
        parent_thread_id: parentThreadId || null,
        // How to brief the reviewer ("last_message" default vs "recap").
        recap_source: recapSource || "last_message",
        // Phase 5: round budget for the iterative reviewer↔author loop.
        max_rounds: maxRounds || 1,
      },
    });
    await syncRemoteSnapshot("post-review-request", true);
    return true;
  } catch (error) {
    // Log AND re-raise so the request modal can show the relay's reason inline
    // (mirrors the local lifecycle path); a rejected review is no longer a silent
    // no-op the user only finds in the activity log.
    renderLog(`Remote review request failed: ${error.message}`);
    throw error;
  }
}

export async function startRemoteWorkflow({
  taskPrompt,
  reviewerProvider,
  reviewerModel,
  reviewerInstructions,
  maxRounds,
  anchorItemId,
  parentThreadId,
} = {}) {
  if (!taskPrompt?.trim()) {
    renderLog("Enter a task before starting Code Flow.");
    return false;
  }
  if (!reviewerProvider) {
    renderLog("Pick a reviewer provider before starting Code Flow.");
    return false;
  }
  renderLog(`Starting Code Flow with ${reviewerProvider} reviewer.`);
  try {
    await dispatchOrRecover("start_workflow", {
      input: {
        workflow_id: "code_flow",
        task_prompt: taskPrompt.trim(),
        reviewer_provider: reviewerProvider,
        reviewer_model: reviewerModel || null,
        reviewer_instructions: reviewerInstructions || null,
        max_rounds: maxRounds || 2,
        anchor_item_id: anchorItemId || null,
        parent_thread_id: parentThreadId || null,
      },
    });
    await syncRemoteSnapshot("post-workflow-start", true);
    return true;
  } catch (error) {
    renderLog(`Remote Code Flow start failed: ${error.message}`);
    throw error;
  }
}

// Fetch the reviewer panel's dedicated, UNCOMPACTED data (review cards + reviewer threads
// + revision) over the broker `fetch_reviews` action — decoupled from the byte-budgeted
// snapshot so the panel survives live-turn compaction. Read-only; no session claim.
export async function fetchRemoteReviews() {
  const result = await dispatchOrRecover("fetch_reviews", {});
  return result?.reviews || null;
}

export async function fetchRemoteWorkflows() {
  const result = await dispatchOrRecover("fetch_workflows", {});
  return result?.workflows || null;
}

export async function fetchRemoteDevices() {
  const result = await dispatchOrRecover("fetch_devices", {});
  return result?.devices || null;
}

export async function resolveRemoteReview(reviewJobId) {
  renderLog("Stopping the blocked reviewer…");
  try {
    await dispatchOrRecover("resolve_review", { review_job_id: reviewJobId });
    await syncRemoteSnapshot("post-review-resolve", true);
    return true;
  } catch (error) {
    renderLog(`Remote resolve failed: ${error.message}`);
    return false;
  }
}

export async function resolveRemoteWorkflow(workflowRunId) {
  renderLog("Stopping the blocked Code Flow…");
  try {
    await dispatchOrRecover("resolve_workflow", { workflow_run_id: workflowRunId });
    await syncRemoteSnapshot("post-workflow-resolve", true);
    return true;
  } catch (error) {
    renderLog(`Remote Code Flow resolve failed: ${error.message}`);
    return false;
  }
}

export async function deleteRemoteReview(reviewId) {
  if (!reviewId) {
    renderLog("No review to delete.");
    return false;
  }
  renderLog("Deleting review…");
  try {
    await dispatchOrRecover("delete_review", { review_id: reviewId });
    await syncRemoteSnapshot("post-review-delete", true);
    return true;
  } catch (error) {
    renderLog(`Remote delete failed: ${error.message}`);
    return false;
  }
}

// Load a reviewer thread's transcript so the Reviewer tab can show its findings.
// Reuses the standard transcript page fetch (fetch_thread_transcript).
export async function fetchRemoteThreadTranscript(threadId) {
  if (!threadId) {
    return [];
  }
  const page = await fetchTranscriptPage({ threadId, before: null });
  return page?.entries || [];
}

export function clearSessionRuntime() {
  invalidateViewOnlyNavigation();
  state.realSession = null;
  clearTranscriptHydration(state);
  // Thread ids are only unique within one relay, so a repair marked in flight (or failed)
  // against thread X here would attach itself to a different relay's thread X after a
  // switch or a re-pair — a button stuck spinning, or someone else's error under it.
  // The verdict itself needs no clearing: it rides the snapshot, so the new relay's first
  // one replaces it.
  state.workspaceRepairByThread = new Map();
  publishWorkspaceRepair();
}

async function sendHeartbeat() {
  const liveSession = state.session?.view_only ? state.realSession : state.session;
  if (
    !liveSession?.active_thread_id
    || !isCurrentDeviceActiveController(liveSession)
  ) {
    return;
  }

  try {
    await dispatchRemoteActionWithoutReply("heartbeat", {
      input: {},
    });
  } catch (error) {
    renderLog(`Remote heartbeat failed: ${error.message}`);
  }
}

async function hydrateActiveTranscript(snapshot) {
  return hydrateRemoteTranscript(state, snapshot, {
    fetchPage: fetchTranscriptPage,
    onProgress(hydratedSnapshot) {
      applyRenderedSession(hydratedSnapshot, {
        hydrateTranscript: false,
      });
    },
    onError(error) {
      renderLog(`Remote full transcript sync failed: ${error.message}`);
    },
  });
}

export async function maybeLoadOlderTranscriptHistory() {
  // The IntersectionObserver in react-app.js fires when the sentinel comes
  // within ~600px of the top edge, so we drop the manual scrollTop check
  // here — the observer's rootMargin is the prefetch trigger.
  const transcript = remoteUiRefs.remoteTranscript;
  if (!transcript) {
    return null;
  }

  return loadOlderRemoteTranscript(state, {
    fetchPage: fetchTranscriptPage,
    onProgress(hydratedSnapshot) {
      applyRenderedSession(hydratedSnapshot, {
        hydrateTranscript: false,
      });
    },
    onError(error) {
      renderLog(`Remote older transcript sync failed: ${error.message}`);
    },
  });
}

export async function fetchTranscriptEntryDetail(threadId, itemId) {
  return fetchTranscriptEntryDetailRequest({
    itemId,
    threadId,
  });
}

function applyRenderedSession(
  session,
  { hydrateTranscript = true, hydrationSnapshot = session } = {}
) {
  const previousThreadId = state.session?.active_thread_id || "-";
  renderSession(session);
  const message = `[session-state] renderSession prev=${previousThreadId} next=${session?.active_thread_id || "-"} state=${state.session?.active_thread_id || "-"} entries=${session?.transcript?.length || 0} hydrate=${hydrateTranscript ? "1" : "0"} hydration_input=${hydrationSnapshot?.active_thread_id || "-"}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once session rendering is stable.
  console.log(message);
  scheduleClaimRefresh();
  if (hydrateTranscript) {
    void hydrateActiveTranscript(hydrationSnapshot);
  }
}

export { sendHeartbeat };
