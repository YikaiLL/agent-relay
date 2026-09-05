import { isWorkingThreadStatus } from "./thread-status.js";

export const VIEW_ONLY_CONTROLLER_DEVICE_ID = "__view_only__";

export function selectDisplayedSessionModel({
  liveSession = null,
  viewedThreadId = null,
  viewedThread = null,
  liveActivityServerTime = null,
  viewOnlySessionPatch = null,
} = {}) {
  if (!liveSession) {
    return {
      liveSession,
      viewedThread: null,
      displayedSession: null,
      mode: "none",
    };
  }

  const threadId = stringId(viewedThreadId);
  if (
    !threadId
    || !viewedThread
    || viewedThread.threadId !== threadId
    || threadId === liveSession.active_thread_id
  ) {
    return {
      liveSession,
      viewedThread: null,
      displayedSession: liveSession,
      mode: "live",
    };
  }

  const normalized = normalizeViewedThread(viewedThread, threadId);
  const activity = (liveSession.thread_activity || []).find(
    (entry) => entry?.thread_id === threadId
  );
  const explicitTurnId = normalized.activeTurnId || null;
  const explicitStatus =
    normalized.currentStatus == null ? "" : String(normalized.currentStatus).trim();
  const hasExplicitThreadState = Boolean(explicitTurnId || explicitStatus);
  const explicitWorking = Boolean(
    explicitTurnId || (explicitStatus && isWorkingThreadStatus(explicitStatus))
  );
  const refreshTime = serverTimeSeconds(normalized.refreshServerTime);
  const snapshotTime = serverTimeSeconds(
    liveActivityServerTime ?? liveSession.thread_activity_server_time ?? liveSession.server_time
  );
  const activityFreshEnough = !refreshTime || !snapshotTime || snapshotTime >= refreshTime;
  const isWorking = explicitWorking || Boolean(
    activity && (!hasExplicitThreadState || activityFreshEnough)
  );
  const currentPhase = isWorking
    ? normalized.currentPhase ?? activity?.phase ?? null
    : null;
  const currentTool = isWorking
    ? normalized.currentTool ?? activity?.tool ?? null
    : null;

  const displayedSession = {
    ...liveSession,
    active_thread_id: threadId,
    active_turn_id: explicitTurnId || (isWorking ? `view:${threadId}` : null),
    pending_approvals: filterThreadItems(liveSession.pending_approvals, threadId),
    pending_ask_user_questions: filterThreadItems(
      liveSession.pending_ask_user_questions,
      threadId
    ),
    active_controller_device_id: VIEW_ONLY_CONTROLLER_DEVICE_ID,
    transcript: normalized.entries,
    transcript_truncated: normalized.transcriptTruncated,
    current_status: normalized.currentStatus
      || (isWorking ? "active" : settledThreadStatus(normalized.status)),
    current_phase: currentPhase,
    current_tool: currentTool,
    last_progress_at: normalized.lastProgressAt ?? null,
    current_cwd: normalized.currentCwd ?? "",
    thread_workspace_cwd: normalized.threadWorkspaceCwd ?? "",
    provider: normalized.provider ?? "",
    model: normalized.model ?? "",
    reasoning_effort: normalized.reasoningEffort ?? "",
    approval_policy: normalized.approvalPolicy ?? "",
    sandbox: normalized.sandbox ?? "",
    available_models: normalized.availableModels,
    reviewer_threads: normalized.reviewerThreads,
    review_locked: Boolean(normalized.reviewLocked),
    workflow_locked: Boolean(normalized.workflowLocked),
    settings_writable: Boolean(normalized.settingsWritable),
    view_only: true,
    ...(viewOnlySessionPatch || {}),
  };

  if (normalized.transcriptRevision !== undefined) {
    displayedSession.transcript_revision = normalized.transcriptRevision;
  }

  return {
    liveSession,
    viewedThread: normalized,
    displayedSession,
    mode: "viewed",
  };
}

export function selectDisplayedSession(args = {}) {
  return selectDisplayedSessionModel(args).displayedSession;
}

export function settledThreadStatus(status) {
  const normalized = typeof status === "string" ? status.toLowerCase() : "";
  return normalized === "active" || normalized === "running" || normalized === "working"
    ? "idle"
    : status || "idle";
}

export function serverTimeSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function normalizeViewedThread(viewedThread, threadId) {
  const hasTranscriptTruncated = typeof viewedThread.transcriptTruncated === "boolean";
  return {
    threadId,
    entries: Array.isArray(viewedThread.entries) ? viewedThread.entries : [],
    transcriptRevision: viewedThread.transcriptRevision,
    transcriptTruncated: hasTranscriptTruncated
      ? viewedThread.transcriptTruncated
      : viewedThread.olderCursor != null,
    activeTurnId: viewedThread.activeTurnId || null,
    currentStatus: viewedThread.currentStatus,
    currentPhase: viewedThread.currentPhase ?? null,
    currentTool: viewedThread.currentTool ?? null,
    lastProgressAt: viewedThread.lastProgressAt ?? null,
    currentCwd: viewedThread.currentCwd ?? "",
    threadWorkspaceCwd: viewedThread.threadWorkspaceCwd ?? "",
    provider: viewedThread.provider ?? "",
    model: viewedThread.model ?? "",
    reasoningEffort: viewedThread.reasoningEffort ?? "",
    approvalPolicy: viewedThread.approvalPolicy ?? "",
    sandbox: viewedThread.sandbox ?? "",
    availableModels: viewedThread.availableModels || [],
    reviewerThreads: viewedThread.reviewerThreads || [],
    reviewLocked: Boolean(viewedThread.reviewLocked),
    workflowLocked: Boolean(viewedThread.workflowLocked),
    settingsWritable: Boolean(viewedThread.settingsWritable),
    status: viewedThread.status,
    refreshServerTime: viewedThread.refreshServerTime,
  };
}

function filterThreadItems(items, threadId) {
  return (items || []).filter((entry) => entry?.thread_id === threadId);
}

function stringId(value) {
  return typeof value === "string" && value ? value : null;
}
