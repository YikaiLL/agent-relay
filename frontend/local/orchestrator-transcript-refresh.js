import { threadActivityFor } from "../shared/thread-activity.js";
import { shouldRefreshViewedThread } from "../shared/viewed-thread-refresh.js";
import {
  resolveViewOnlyPinWasWorking,
  resolveViewOnlyPinWasWorkingAfterFetch,
} from "./view-only-thread.js";

/**
 * Should the Tasks Orchestrator pane refetch its transcript page?
 *
 * Mirrors the view-only pin policy with two Orchestrator-specific guards:
 * - A delta-raised `orchestratorWasWorking` must survive `thread_activity` that
 *   omits the Orchestrator, but must not be mistaken for an observed idle edge
 *   on the first render after the delta lands.
 * - A refused delta's `orchestratorTailGap` must not wait behind an ordinary
 *   page load, but only one tail-gap repair may be in flight at a time.
 */
export function orchestratorTranscriptRefreshDecision(state, session, orchId) {
  const orchIsActive = Boolean(orchId && session?.active_thread_id === orchId);
  const orchWorking = Boolean(threadActivityFor(session, orchId).phase);
  if (!orchId || orchIsActive) {
    return { refresh: false, terminal: false, repair: false, orchWorking };
  }

  const lastActivityWorking = Boolean(state.orchestratorLastActivityWorking);
  const activityIdleEdge = lastActivityWorking && !orchWorking;
  const suppressDeltaTerminal =
    Boolean(state.orchestratorDeltaRaisedWorking)
    && !lastActivityWorking
    && !orchWorking;

  const tailGap = Boolean(state.orchestratorTailGap);
  const tailGapRepairing = Boolean(state.orchestratorTailGapRepairing);
  const needsTailGapRepair = tailGap && !tailGapRepairing;

  const terminalRefresh =
    !suppressDeltaTerminal
    && shouldRefreshViewedThread({
      elapsedMs: Date.now() - (state.orchestratorLastRefreshAt || 0),
      loading: Boolean(state.orchestratorEntriesLoading),
      needsRepair: false,
      wasWorking: activityIdleEdge || Boolean(state.orchestratorWasWorking),
      working: orchWorking,
    });

  const refresh = needsTailGapRepair || terminalRefresh;
  return {
    refresh,
    terminal: terminalRefresh && !needsTailGapRepair,
    repair: needsTailGapRepair,
    orchWorking,
  };
}

export function nextOrchestratorWasWorking(state, orchWorking) {
  return resolveViewOnlyPinWasWorking({
    prior: { wasWorking: state.orchestratorWasWorking },
    isWorking: orchWorking,
  });
}

export function nextOrchestratorRefreshObservations(state, orchWorking) {
  return {
    orchestratorLastActivityWorking: orchWorking,
    orchestratorDeltaRaisedWorking: false,
  };
}

export function orchestratorWasWorkingAfterFetch(state, session, threadId, { terminal = false } = {}) {
  const isWorking = Boolean(threadActivityFor(session, threadId).phase);
  return resolveViewOnlyPinWasWorkingAfterFetch({
    prior: {
      wasWorking: state.orchestratorWasWorking,
      deltaDuringFetch: state.orchestratorDeltaDuringFetch,
    },
    isWorking,
    terminal,
  });
}

/**
 * Settle the flags a completed load owns, success or failure alike.
 *
 * Both answers below read `orchestratorDeltaDuringFetch`, so both are resolved
 * BEFORE any flag is cleared — clearing first made
 * `orchestratorWasWorkingAfterFetch` read its own erasure.
 *
 * The tail gap is settled here and nowhere else. The loader's success branch
 * cannot answer it: the page it merged was built on the server, so a delta the
 * reducer refused after that point is a hole the page never covered. Same rule
 * the view-only pin applies (view-only-refresh-ops.js:139-142) — keep the gap
 * only when this fetch was in flight for the refusal, otherwise clear it, since
 * an uncleared gap re-fetches on every frame (there is no throttle).
 */
export function applyOrchestratorLoadFinally(state, generation, threadId, session, { terminal = false } = {}) {
  if (generation !== state.orchestratorLoadGeneration) {
    return false;
  }
  const wasWorking = orchestratorWasWorkingAfterFetch(state, session, threadId, { terminal });
  const tailGap = Boolean(state.orchestratorTailGap) && Boolean(state.orchestratorDeltaDuringFetch);
  state.orchestratorEntriesLoading = false;
  state.orchestratorTailGapRepairing = false;
  state.orchestratorDeltaDuringFetch = false;
  state.orchestratorTailGap = tailGap;
  state.orchestratorWasWorking = wasWorking;
  return true;
}
