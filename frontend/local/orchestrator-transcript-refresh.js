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
    prior: { wasWorking: state.orchestratorWasWorking },
    isWorking,
    terminal,
  });
}
