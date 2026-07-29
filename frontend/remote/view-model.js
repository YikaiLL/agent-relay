import {
  buildNavigationThreadGroups,
  isUnassignedProject,
  summarizeThreadGroups,
} from "../shared/thread-groups.js";
import { isReviewInProgressForThread } from "../shared/review-state.js";
import { isWorkflowInProgressForThread } from "../shared/workflow-state.js";
import { canComposeThread } from "../shared/thread-compose.js";
import { providerLabel } from "../shared/provider-labels.js";
import { workspaceBasename } from "./utils.js";

function createActiveSessionThread(session) {
  if (!session?.active_thread_id || !session.current_cwd) {
    return null;
  }

  return {
    cwd: session.current_cwd,
    id: session.active_thread_id,
    name: workspaceBasename(session.current_cwd),
    provider: session.provider || "",
    preview: session.current_status
      ? `Current session · ${session.current_status}`
      : "Current remote session",
    updated_at: Math.floor(Date.now() / 1000),
  };
}

// A frozen thread (under review / Code Flow) is driven by the orchestrator, so
// its AskUser prompts are not the human's to answer — hide them. `sessionView`
// is null until a session exists (fresh remote.html load) and the transcript
// panel renders before then, so this must never assume a model is there.
export function visiblePendingAskUserQuestions(sessionView, pendingAskUserQuestions) {
  return sessionView?.activeThreadFrozen ? [] : pendingAskUserQuestions;
}

export function selectSessionRenderModel({ session, previousSession, hasControllerLease }) {
  const approval = session.pending_approvals?.[0] || null;
  const hasActiveSession = Boolean(session.active_thread_id);
  // The active thread is frozen only when it is itself owned by review/workflow;
  // background work on another thread leaves this conversation usable.
  const activeThreadUnderReview = isReviewInProgressForThread(session, session.active_thread_id);
  const activeThreadUnderWorkflow = isWorkflowInProgressForThread(
    session,
    session.active_thread_id
  );
  const activeThreadFrozen = activeThreadUnderReview || activeThreadUnderWorkflow;
  const canWrite = hasControllerLease && !activeThreadFrozen;
  // Sending to an idle thread is itself the atomic claim. The relay serializes
  // concurrent sends, so no separate take-over step is needed.
  const canCompose = canComposeThread({
    activeTurnId: session.active_turn_id,
    hasActiveSession,
    hasControllerLease,
    reviewLocked: activeThreadFrozen,
  });

  return {
    approval,
    canCompose,
    canWrite,
    composerDisabled: !canCompose,
    currentApprovalId: approval?.request_id || null,
    hasActiveSession,
    hasControllerLease,
    activeThreadFrozen,
    activeThreadUnderWorkflow,
    messagePlaceholder: activeThreadFrozen
      ? activeThreadUnderWorkflow
        ? "This session is locked by Code Flow…"
        : "This session is being reviewed…"
      : !hasActiveSession
      ? "Start a remote session first."
      : canCompose
        // Derive the agent name from the active thread's own provider — a Claude
        // thread must read "Message Claude...", never a hardcoded "Codex".
        ? (providerLabel(session.provider)
          ? `Message ${providerLabel(session.provider)} remotely...`
          : "Message remotely...")
        : "This session is currently running on another device.",
    scrollDebug: {
      thread: session.active_thread_id || "-",
      prevThread: previousSession?.active_thread_id || "-",
      entries: session.transcript?.length || 0,
      truncated: session.transcript_truncated ? "1" : "0",
      status: session.current_status || "-",
    },
  };
}

export function selectThreadsRenderModel({
  threads,
  activeThreadId,
  error,
  loading,
  remoteAuth,
  relayDirectory,
  session,
  // Projects grouping (mirrors the local surface). Defaults keep the pre-Projects
  // behavior (session/cwd grouping) for any caller that doesn't pass them.
  viewMode = "sessions",
  projects = [],
  threadProjectId = {},
  projectsError = null,
  projectsLoaded = false,
  projectsLoading = false,
}) {
  let normalizedThreads = Array.isArray(threads) ? [...threads] : [];
  if (
    session?.active_thread_id
    && !normalizedThreads.some((thread) => thread?.id === session.active_thread_id)
  ) {
    const activeSessionThread = createActiveSessionThread(session);
    if (activeSessionThread) {
      normalizedThreads = [activeSessionThread, ...normalizedThreads];
    }
  }

  const groupByProject = viewMode === "projects";

  if (!remoteAuth) {
    return {
      activeThreadId,
      viewMode,
      countLabel: "Remote session history",
      emptyMessage: relayDirectory?.length
        ? "Open a relay to view its session history."
        : "Pair a relay, then refresh remote history.",
      groups: [],
    };
  }

  if (error) {
    return {
      activeThreadId,
      viewMode,
      countLabel: "Error",
      emptyMessage: error,
      groups: [],
    };
  }

  // Fail closed: in Projects mode, never present sessions as authoritative membership
  // until the dedicated payload is fresh (mirrors the local renderer/menu guard).
  if (groupByProject && (projectsError || !projectsLoaded || projectsLoading)) {
    return {
      activeThreadId,
      viewMode,
      countLabel: projectsError ? "Projects unavailable" : "Loading projects…",
      emptyMessage: projectsError
        ? `Failed to load projects: ${projectsError}`
        : "Loading projects…",
      groups: [],
    };
  }

  // Projects mode must not surface the "Unassigned" bucket. Shared grouping always
  // creates one for any thread without a project (shared/thread-groups.js:124-126),
  // which flooded the phone's Projects view with every unassigned session. The
  // local sidebar avoids this by listing projects only and moving sessions into a
  // main-area card overview (local/render-session.js:1445); remote has no such
  // main area yet, so it keeps the grouped list and drops the bucket instead —
  // otherwise Projects mode would show rows with no way to open a session.
  const groups = groupByProject
    ? buildNavigationThreadGroups(normalizedThreads, {
        groupBy: "project",
        projects,
        threadProjectId,
      }).filter((group) => !isUnassignedProject(group.key))
    : buildNavigationThreadGroups(normalizedThreads);

  return {
    activeThreadId,
    viewMode,
    countLabel: loading
      ? "Loading..."
      : summarizeThreadGroups(groups, { groupBy: groupByProject ? "project" : "cwd" }),
    emptyMessage: groups.length
      ? null
      : groupByProject
        ? "No projects yet — create one to group sessions."
        : "No remote sessions found yet.",
    groups,
  };
}

export function selectRelayDirectoryRenderModel({ relayDirectory, activeRelayId, nicknames }) {
  const relays = relayDirectory || [];
  const nicknameMap = nicknames || {};

  return {
    countLabel: `${relays.length} ${relays.length === 1 ? "relay" : "relays"}`,
    emptyMessage: relays.length
      ? null
      : "Pair a relay from your local machine to add it here.",
    items: relays.map((relay) => {
      const id = relay.relayId || relay.brokerRoomId || relay.deviceId || "";
      const nickname = nicknameMap[relay.relayId] || null;
      return {
        active: activeRelayId === relay.relayId,
        actionLabel: relay.hasLocalProfile
          ? "Open relay"
          : relay.needsLocalRePairing
            ? "Re-pair relay"
            : "Pair again",
        id,
        isEnabled: Boolean(relay.hasLocalProfile && id),
        meta: nickname ? (relay.relayId || relay.brokerRoomId || relay.deviceId || "") : "",
        relay,
        title:
          nickname
          || relay.relayLabel
          || relay.relayId
          || relay.brokerRoomId
          || relay.deviceLabel
          || relay.deviceId
          || "Unknown relay",
      };
    }),
  };
}

export function selectEmptyStateRenderModel({
  clientAuth,
  pairingTicket,
  relayDirectory,
  remoteAuth,
  relayConnected,
  relayConnectionMessage,
  serverConnectionMessage,
  serverConnectionState,
  socketConnected,
}) {
  const showMissingCredentials = Boolean(
    remoteAuth &&
      (remoteAuth.payloadSecret === null || remoteAuth.deviceSessionExpired === true) &&
      !pairingTicket
  );
  const showServerDisconnected = Boolean(
    remoteAuth
      && !showMissingCredentials
      && (
        serverConnectionState === "disconnected"
        || serverConnectionMessage
        || (socketConnected && !relayConnected && relayConnectionMessage)
      )
  );

  return {
    clientAuth,
    relayDirectory,
    remoteAuth,
    showMissingCredentials,
    showRelayHome: Boolean(!remoteAuth && !pairingTicket),
    showServerDisconnected,
    serverDisconnectedCopy:
      serverConnectionMessage
      || relayConnectionMessage
      || "Server disconnected. Waiting for it to reconnect.",
  };
}
