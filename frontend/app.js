import {
  allowedRootsForm,
  allowedRootsInput,
  allowedRootsList,
  allowedRootsSummary,
  apiTokenInput,
  apiTokenLabel,
  appShell,
  applyTokenButton,
  archiveThreadButton,
  approvalPolicyInput,
  auditSummary,
  auditTimeline,
  chatShell,
  clientLogRoot,
  closeLaunchSettingsModalButton,
  closeSessionDetailsModalButton,
  closeSettingsModalButton,
  settingsModal,
  iconRailHomeButton,
  iconRailSettingsButton,
  composerAttachments,
  connectionForm,
  controlBanner,
  copyPairingLinkButton,
  cwdInput,
  deleteThreadButton,
  projectContextMenu,
  renameProjectMenuButton,
  deleteProjectMenuButton,
  directoryForm,
  forkSessionDialogRoot,
  forkThreadButton,
  goConsoleHomeButton,
  goConsoleHomeSidebarButton,
  launchStartSessionDialog,
  launchSettingsModal,
  loadDirectoryButton,
  messageEffort,
  messageForm,
  messageInput,
  messageModel,
  modelInput,
  modelInputLabel,
  openLaunchSettingsButton,
  openSessionDetailsButton,
  overviewSecurityBadges,
  pairedDevicesList,
  pairingApprovalList,
  pairingApprovalModal,
  closePairingApprovalModalBtn,
  pendingActionBanner,
  pendingPairingsList,
  providerInput,
  resumeLatestButton,
  sandboxInput,
  saveAllowedRootsButton,
  sendButton,
  sessionDetailsModal,
  sessionHistoryDrawer,
  sessionMeta,
  startEffortInput,
  startEffortLabel,
  startPairingButton,
  startPromptAttachments,
  startPromptInput,
  startSessionButton,
  statusBadge,
  agentWorkingIndicator,
  agentWorkingIndicatorLabel,
  stopButton,
  threadContextMenu,
  threadProjectActions,
  projectsToolbar,
  projectsCreateButton,
  threadsCount,
  threadsList,
  threadsRefreshButton,
  transcript,
  workspaceTitle,
  workspaceSubtitle,
  workspaceDiffModal,
  closeWorkspaceDiffModalButton,
  workspaceDiffTitleMount,
  workspaceDiffMount,
  workspaceChangesMount,
  workspaceDiffChipMount,
  reviewerChipMount,
  sidebarElement,
  sidebarResizeHandle,
  rightRailResizeHandle,
  toggleLeftPanelButton,
  toggleRightPanelButton,
  sidebarTopToggleButton,
  railTopToggleButton,
  newSessionComposeButton,
} from "./local/dom.js";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  createApiFetch,
  createAuthSession,
  deleteAuthSession,
  fetchAuthSession,
  getDevices,
  getReviews,
  getWorkflows,
} from "./local/api.js";
import {
  createWorkspaceDiffStore,
  createWorkspaceDiffSheet,
  mountChangesPanel,
  mountChip,
  mountReviewerChip,
} from "./local/workspace-diff.js";
import { createPanelControl } from "./local/panel-controls.js";
import { setupHeaderBandSync } from "./local/header-band-sync.js";
import {
  createVerbCycler,
  isProgressStalled,
  progressPhaseLabel,
} from "./progress-verbs.js";
import {
  configureSecurityRenderers,
  renderAllowedRoots,
  renderDeviceRecords,
  renderPairingApprovalModal,
  renderPairingPanel,
  renderPendingPairingRequests,
} from "./local/render-security.js";
import { createSessionRenderer } from "./local/render-session.js";
import { createSessionController } from "./local/session-controller.js";
import {
  createLocalUiStore,
  readLocalUiState,
} from "./local/ui-store.js";
import { openSessionStream, sessionStreamUrl } from "./session-stream.js";
import {
  buildNavigationThreadGroups,
} from "./shared/thread-groups.js";
import {
  createThreadListStore,
  readActiveProjectId,
  readThreadListContextMenu,
  readThreadListUi,
  readThreadListViewMode,
} from "./shared/thread-list-store.js";
import { createProjectsStore } from "./shared/projects-store.js";
import { createDevicesCache } from "./shared/devices-cache.js";
import { createReviewsCache } from "./shared/reviews-cache.js";
import { createWorkflowsCache } from "./shared/workflows-cache.js";
import {
  fetchProjectsPayload,
  createProject,
  renameProject,
  deleteProject,
  assignThreadToProject,
  unassignThread,
} from "./local/project-actions.js";
import {
  buildProjectMenuItems,
  pickNewProjectId,
  normalizeProjectName,
  projectsMenuReady,
  projectMenuActionAllowed,
} from "./local/project-menu.js";
import { installThreadListWheelProxy } from "./shared/thread-list-scroll.js";
import { fetchBuildInfo } from "./shared/build-badge.js";
import { providerLabel } from "./shared/provider-labels.js";
import { ForkSessionDialog } from "./shared/fork-session-dialog.js";
import {
  applyForkProviderChange,
  defaultForkFields,
  forkPointIsTranscriptTip,
  resolveForkSourceThread,
  threadIsBusyForFork,
} from "./shared/fork-fields.js";
import {
  buildReviewingThreadSet,
  isReviewInProgressForThread,
  isTerminalReviewStatus,
} from "./shared/review-state.js";
import { buildThreadActivityMap } from "./shared/thread-activity.js";
import { threadAttention } from "./shared/thread-attention.js";
import { isWorkflowInProgressForThread } from "./shared/workflow-state.js";
import {
  buildViewOnlyPin,
  mergeOlderViewOnlyPage,
  mergeRefreshedViewOnlyPage,
  viewOnlyEligible,
  viewOnlyPinNextAction,
  viewOnlySelfHealThreadId,
} from "./local/view-only-thread.js";
import {
  createViewedThreadRefreshLatch,
  shouldRefreshViewedThread,
} from "./shared/viewed-thread-refresh.js";
import { ClientLog } from "./shared/client-log.js";
import { mapRelayLogEntries, mergeLogEntries } from "./shared/client-log-merge.js";
import { SessionTabStrip, buildSessionTabItems } from "./shared/session-tab-strip.js";
import { focusedTab, layoutThreadIds, openThreadIds } from "./shared/tab-layout.js";
import {
  NO_PROJECT_KEY,
  SESSIONS_KEY,
  createTabWorkspaceStore,
} from "./shared/tab-workspace-store.js";
import { browserTabWorkspacePersistence } from "./shared/tab-workspace-prefs.js";
import {
  isRemovedThreadId,
  loadRemovedThreadIds,
  rememberRemovedThreadId,
} from "./shared/removed-threads.js";
import {
  loadLastApprovalPolicy,
  loadLastEffort,
  saveLastApprovalPolicy,
  saveLastEffort,
} from "./shared/last-used-settings.js";
import {
  renderSelectOptions,
  replaceSelectOptions,
} from "./shared/select-options.js";
import { buildModelSelectOptions } from "./shared/composer.js";
import {
  buildReasoningEffortOptions,
  resolveReasoningEffortValue,
} from "./shared/reasoning-efforts.js";
import {
  defaultModelForProvider,
  defaultProvider,
  normalizeProviderList,
  providerOptions,
  providerSettings,
  sandboxOptions,
} from "./shared/provider-settings.js";
import { localQueryClient } from "./local/query-client.js";
import { attachTranscriptHistoryLoader } from "./shared/transcript-history-loader.js";
import { copyTextToClipboard } from "./shared/clipboard.js";
import {
  countReviewerThreadsForParent,
  reviewerChoiceRequestInit,
} from "./shared/reviewer-threads.js";
import {
  formatAttachmentBytes,
  imageFileToDataUrl,
  pastedImageFiles,
  validateImageAttachments,
} from "./local/image-attachments.js";

const DEVICE_STORAGE_KEY = "agent-relay.device-id";
const API_TOKEN_STORAGE_KEY = "agent-relay.api-token";

const state = {
  apiToken: loadApiToken(),
  authRequired: false,
  authenticated: false,
  cookieSession: false,
  controllerHeartbeatTimer: null,
  controllerLeaseRefreshTimer: null,
  currentApprovalId: null,
  currentPairing: null,
  // Client-originated status lines (sends, errors, etc.) kept as {at, text} so
  // they can be merged with the relay's server logs in one #client-log view.
  // These PERSIST across snapshots — a server-log refresh must not wipe them.
  clientLogLines: [{ at: Date.now(), text: "Booting web client..." }],
  // Latest server (relay) log entries, refreshed from each session snapshot.
  relayLogLines: [],
  deviceId: loadOrCreateDeviceId(),
  defaultsSeeded: false,
  selectedCwd: "",
  session: null,
  viewThreadId: readThreadIdFromUrl(),
  // Read-only "view projection" pin for ANY non-active thread the user is looking
  // at (see local/view-only-thread.js). `{ threadId, entries, olderCursor,
  // generation, review, reviewSig, loading }` or null. Loaded by
  // loadViewOnlyTranscript() below; paginated by loadOlderViewOnlyTranscript().
  viewOnlyThread: null,
  viewOnlyGeneration: 0,
  // True while a composer submit is in flight.
  // Freezes the composer and rejects re-entry so a draft edit / navigation /
  // double-submit during the async request can't change or duplicate the send.
  composerSubmitInFlight: false,
  composerImageAttachments: [],
  nextComposerImageAttachmentId: 1,
  newSessionSubmitInFlight: false,
  newSessionImageAttachments: [],
  nextNewSessionImageAttachmentId: 1,
  sessionStream: null,
  streamConnected: false,
  transcriptEntryDetailCache: new Map(),
  transcriptEntryDetailOrder: [],
  transcriptHydrationBaseSnapshot: null,
  transcriptHydrationEntries: new Map(),
  transcriptHydrationLastFetchAt: 0,
  transcriptHydrationOrder: [],
  transcriptHydrationOlderCursor: null,
  transcriptHydrationPromise: null,
  transcriptHydrationSignature: null,
  transcriptHydrationStatus: "idle",
  transcriptHydrationTailReady: false,
  transcriptHydrationThreadId: null,
  transcriptLiveEntryDetails: new Map(),
  transcriptLiveEntryThreadId: null,
  transcriptPreserveScroll: false,
  pendingThreadHistoryScrollTop: null,
  providerModels: {},
  providers: [],
  forkDialog: {
    open: false,
    pending: false,
    sourceThread: null,
    fields: null,
  },
  threadGroups: [],
  projects: [],
  threadProjectId: {},
  projectsLoading: false,
  projectsError: null,
  projectsLoaded: false,
  // When a session is started via a project overview's "New agent" button, this holds
  // that project's id so the freshly-created thread can be auto-assigned to it. Set at
  // "New agent" time, consumed once by the next start, and cleared by any plain
  // new-session opener so a normal launch never inherits a stale project.
  pendingProjectAssignment: null,
  threadHistoryScrollTop: 0,
  // Sessions this browser archived/deleted. History entries outlive threads, so
  // back/forward can land on a `?thread=` that no longer exists; without a tombstone
  // the popstate handler would helpfully re-create a tab for a dead session.
  // Tracked rather than inferred from `state.threads`, which is capped at 120 and
  // would false-negative a live-but-old session. Restored from storage because the
  // stale history entries survive a reload too.
  removedThreadIds: new Set(loadRemovedThreadIds()),
  threadListStore: createThreadListStore(),
  // Per-project open-session tabs. Persistence is browser-local for now; the store
  // takes it as an injected adapter so moving to server-persisted (cross-device)
  // needs no change here or in the UI.
  tabWorkspaceStore: createTabWorkspaceStore({
    persistence: browserTabWorkspacePersistence,
  }),
  localUiStore: createLocalUiStore(),
  streamReconnectTimer: null,
  sessionPollTimer: null,
  threads: [],
  threadsPollTimer: null,
};

const apiFetch = createApiFetch({
  getApiToken() {
    return state.apiToken;
  },
  onUnauthorized(message) {
    handleUnauthorized(message);
  },
});

const devicesCache = createDevicesCache();
const reviewsCache = createReviewsCache();
const workflowsCache = createWorkflowsCache();

const viewedThreadId = () => state.viewThreadId || state.session?.active_thread_id || null;
const workspaceDiffStore = createWorkspaceDiffStore({
  apiFetch,
  surface: "local",
  // Diff follows the session the user is viewing, not whichever thread is active.
  getThreadId: viewedThreadId,
  // Reset identity = viewed thread + its cwd, so a same-thread cwd change also
  // clears the stale diff during loading (not just a thread switch).
  getWorkspaceKey: () => JSON.stringify([viewedThreadId() || "", state.session?.current_cwd || ""]),
});
// Projects ride a dedicated channel off the byte-budgeted snapshot; this store fetches
// the payload when `projects_revision` changes (see createProjectsStore) and feeds it
// into state so the sidebar can group by Project.
const projectsStore = createProjectsStore({
  fetchProjects: () => fetchProjectsPayload(apiFetch),
});
// Monotonic token bumped on every Projects-store transition. A context-menu button
// captures the token at build time; runThreadProjectAction() refuses to act if it has
// since advanced, so a button built from now-stale Project state can't mutate.
let projectsStateSeq = 0;
projectsStore.subscribe((projectsState) => {
  state.projects = projectsState.projects;
  state.threadProjectId = projectsState.threadProjectId;
  state.projectsLoading = projectsState.loading;
  state.projectsError = projectsState.error;
  state.projectsLoaded = projectsState.loaded;
  projectsStateSeq += 1;
  // Re-render on ANY change (loading/loaded/error transitions) while the Projects
  // view is showing, so its loading/error placeholder resolves to the grouping.
  // `renderThreads`/`renderSession` are module consts defined below; this callback
  // only ever fires asynchronously (after a fetch settles), by which point they are
  // initialized.
  if (readThreadListViewMode(state.threadListStore) === "projects") {
    // Once projects arrive, land on one so the main area shows a card overview
    // instead of the console home.
    ensureActiveProjectSelected();
    renderThreads();
    if (state.session) {
      renderSession(state.session);
    }
  }
  // Keep an OPEN context menu's Project section in sync regardless of view mode —
  // a settled refresh/failure must repopulate (fresh membership) or fall closed
  // (loading/error note) rather than leave stale assign/unassign controls exposed.
  const openContextThreadId = readThreadListContextMenu(state.threadListStore).threadId;
  if (openContextThreadId && threadContextMenu && !threadContextMenu.hidden) {
    populateThreadProjectActions(openContextThreadId);
  }
  // Fail closed: a projects transition (remote rename/delete, add, or a refresh/error)
  // can invalidate the right-clicked project, so drop any open project menu rather than
  // let Rename/Delete act on a now-stale target and clobber a concurrent change.
  closeProjectContextMenu();
});
let clientLogRootHandle = null;
let clientLogRootElement = null;
let forkSessionRoot = null;

// Reviewer-tab actions. Bound late through `state.controller` (assigned after
// the controller is built) so these can be wired into the rail + sheet mounts
// that run at module load; they only ever fire on user interaction.
const reviewerActions = {
  onRequestReview: (values) => state.controller?.requestReview(values),
  onStartWorkflow: (values) => state.controller?.startWorkflow(values),
  onResolveReview: (reviewJobId) => state.controller?.resolveReview(reviewJobId),
  onResolveWorkflow: (workflowRunId) => state.controller?.resolveWorkflow(workflowRunId),
  onDeleteReview: (reviewId) => state.controller?.deleteReview(reviewId),
  fetchReviewerTranscript: (threadId) =>
    Promise.resolve(state.controller?.fetchTranscriptPage(threadId, {})).then(
      (page) => page?.entries || (Array.isArray(page) ? page : [])
    ),
};

const workspaceDiffSheet = createWorkspaceDiffSheet({
  store: workspaceDiffStore,
  mount: workspaceDiffMount,
  modal: workspaceDiffModal,
  closeButton: closeWorkspaceDiffModalButton,
  titleMount: workspaceDiffTitleMount,
  reviewer: reviewerActions,
  panelId: "review-panel-sheet",
});
mountChangesPanel({
  store: workspaceDiffStore,
  mount: workspaceChangesMount,
  reviewer: reviewerActions,
  panelId: "review-panel-rail",
});
setupHeaderBandSync({
  chatHeader: document.querySelector(".chat-shell > .chat-header"),
});
mountChip({
  store: workspaceDiffStore,
  mount: workspaceDiffChipMount,
  onTap: () => {
    // Mirror the Reviewer chip below: force the Changes tab rather than opening
    // on whatever tab was last persisted, so tapping the diff chip always shows
    // the diff (not the Reviewer panel under a now-"Reviewer" title).
    workspaceDiffStore.setActiveTab("changes");
    workspaceDiffSheet?.open();
  },
});
mountReviewerChip({
  store: workspaceDiffStore,
  mount: reviewerChipMount,
  onTap: () => {
    // Land the user straight on the Reviewer tab rather than whatever was last open.
    workspaceDiffStore.setActiveTab("reviewer");
    workspaceDiffSheet?.open();
  },
});
void workspaceDiffStore.refresh();

const leftPanelControl = createPanelControl({
  cssVarName: "--sidebar-width",
  widthStorageKey: "agent-relay:local-sidebar-width",
  openWidthStorageKey: "agent-relay:local-sidebar-open-width",
  minOpenWidth: 220,
  maxOpenWidth: 520,
  defaultOpenWidth: 300,
  side: "left",
});
leftPanelControl.attachResizeHandle(sidebarResizeHandle);
leftPanelControl.attachToggleButton(toggleLeftPanelButton);
leftPanelControl.attachToggleButton(sidebarTopToggleButton);
leftPanelControl.subscribe(({ isOpen }) => {
  document.body.classList.toggle("sidebar-collapsed", !isOpen);
});
newSessionComposeButton?.addEventListener("click", () => {
  document.getElementById("launch-start-session-dialog")?.setAttribute("open", "");
});

const rightPanelControl = createPanelControl({
  cssVarName: "--right-rail-width",
  widthStorageKey: "agent-relay:local-rail-width",
  openWidthStorageKey: "agent-relay:local-rail-open-width",
  minOpenWidth: 260,
  maxOpenWidth: 560,
  defaultOpenWidth: 320,
  side: "right",
});
rightPanelControl.attachResizeHandle(rightRailResizeHandle);
rightPanelControl.attachToggleButton(toggleRightPanelButton);
rightPanelControl.attachToggleButton(railTopToggleButton);
rightPanelControl.subscribe(({ isOpen }) => {
  document.body.classList.toggle("rail-collapsed", !isOpen);
});
document.addEventListener("keydown", (event) => {
  const isKeyB = event.key === "b" || event.key === "B" || event.code === "KeyB";
  if (!isKeyB) return;
  const metaLike = event.metaKey || event.ctrlKey;
  if (!metaLike || event.shiftKey) return;
  if (event.altKey) {
    event.preventDefault();
    rightPanelControl.toggle();
  } else {
    event.preventDefault();
    leftPanelControl.toggle();
  }
});

let lastTurnDiffItemId = null;
let lastWorkspaceCwd = null;
let lastViewThreadId = null;
window.addEventListener("agent-relay:session-updated", () => {
  refreshWorkspaceDiffIfChanged();
  // Fetch the dedicated Projects payload when the snapshot's revision changes (a
  // no-op otherwise; unconditional on the first observation).
  projectsStore.syncToRevision(state.session?.projects_revision || 0);
  void devicesCache.sync(
    state.session?.devices_revision,
    () => getDevices(apiFetch),
    () => {
      if (state.session) renderer.renderSession(state.session);
    }
  );
});
function refreshWorkspaceDiffIfChanged() {
  const session = state.session;
  if (!session) return;
  const cwd = session.current_cwd || "";
  // The viewed session id is also part of the key: switching between two threads
  // that share a cwd must still refetch (each has its own workspace state).
  const viewThreadId = state.viewThreadId || session.active_thread_id || null;
  const cwdChanged = lastWorkspaceCwd !== null && cwd !== lastWorkspaceCwd;
  const viewChanged = lastViewThreadId !== null && viewThreadId !== lastViewThreadId;
  if (cwdChanged || viewChanged) {
    lastWorkspaceCwd = cwd;
    lastViewThreadId = viewThreadId;
    lastTurnDiffItemId = null;
    void workspaceDiffStore.refresh();
    return;
  }
  lastWorkspaceCwd = cwd;
  lastViewThreadId = viewThreadId;
  const entries = session.transcript || [];
  let latest = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.tool?.item_type === "turnDiff") {
      latest = entries[i].item_id || null;
      break;
    }
  }
  if (latest && latest !== lastTurnDiffItemId) {
    lastTurnDiffItemId = latest;
    void workspaceDiffStore.refresh();
  } else if (!latest) {
    lastTurnDiffItemId = null;
  }
}

configureSecurityRenderers({
  escapeHtml,
  formatTimestamp,
  shortId,
  workspaceBasename,
});

let controller;

fetchBuildInfo("relay").then((info) => {
  const el = document.querySelector("#build-info-local");
  if (el) {
    el.textContent = info.label;
    el.title = info.title;
  }
});

// --- progress verb cycler --------------------------------------------------
//
// While `session.current_phase` is set we rotate through a small pool of
// gerund verbs every 2.5s so the inline working indicator above the composer
// keeps moving and proves the UI is live. The timer is fully driven by phase
// transitions reported in session snapshots — when phase clears we tear it
// down.

const VERB_CYCLE_MS = 2500;
const verbCycler = createVerbCycler();
let currentProgressVerb = null;
let verbTimer = null;

function syncVerbTimer(session) {
  const phase = session?.current_phase ?? null;
  if (phase) {
    if (!verbTimer) {
      currentProgressVerb = verbCycler.next();
      verbTimer = setInterval(() => {
        currentProgressVerb = verbCycler.next();
        refreshAgentWorkingIndicator();
      }, VERB_CYCLE_MS);
    }
  } else if (verbTimer) {
    clearInterval(verbTimer);
    verbTimer = null;
    currentProgressVerb = null;
    verbCycler.reset();
  }
  refreshAgentWorkingIndicator();
}

function refreshAgentWorkingIndicator() {
  const session = state.session;
  if (!agentWorkingIndicator) return;
  const approval = session?.pending_approvals?.[0] || null;
  const phase = session?.current_phase ?? null;
  // The snapshot's phase describes only the active thread. Show the working
  // indicator solely when the thread being viewed IS that active thread —
  // otherwise the console home (or another thread's page) would light up for
  // work happening elsewhere. Per-thread activity is surfaced by the sidebar
  // badge (session.thread_activity) instead.
  const viewingActive = Boolean(
    session?.active_thread_id && state.viewThreadId === session.active_thread_id
  );
  const offline = !session || approval || !session.provider_connected || !viewingActive || !phase;
  if (offline) {
    agentWorkingIndicator.hidden = true;
    return;
  }
  const stalled = isProgressStalled(session);
  const label = stalled
    ? "Stalled?"
    : progressPhaseLabel(phase, session.current_tool, currentProgressVerb);
  if (!label) {
    agentWorkingIndicator.hidden = true;
    return;
  }
  agentWorkingIndicator.hidden = false;
  const tone = stalled ? "alert" : "ready";
  agentWorkingIndicator.className = `agent-working-indicator agent-working-indicator-${tone}`;
  if (agentWorkingIndicatorLabel) {
    agentWorkingIndicatorLabel.textContent = label;
  }
}

const renderer = createSessionRenderer({
  state,
  renderAllowedRoots,
  renderPairingPanel,
  renderDeviceRecords,
  renderPendingPairingRequests,
  renderPairingApprovalModal,
  resolveActiveThread,
  setSelectedCwd,
  resumeSession(...args) {
    return controller.resumeSession(...args);
  },
  openThreadContextMenu,
  closeThreadContextMenu,
  onRenameProject: renameProjectFromHeader,
  onDeleteProject: deleteProjectFromHeader,
  openProjectContextMenu,
  scheduleControllerHeartbeat(...args) {
    return controller.scheduleControllerHeartbeat(...args);
  },
  scheduleControllerLeaseRefresh(...args) {
    return controller.scheduleControllerLeaseRefresh(...args);
  },
  cancelControllerHeartbeat() {
    return controller?.cancelControllerHeartbeat();
  },
  cancelControllerLeaseRefresh() {
    return controller?.cancelControllerLeaseRefresh();
  },
  logLine,
  renderClientLogLines,
  ingestRelayLogs,
  escapeHtml,
  formatTimestamp,
  formatRelativeTime,
  humanizeLabel,
  shortId,
  workspaceBasename,
  canCurrentDeviceWrite,
  controllerLabel,
  controllerStateLabel,
  sessionControllerState,
  isCurrentDeviceActiveController,
  isViewingConversation,
  approvedDeviceCount,
  securityModeLabel,
  contentVisibilityLabel,
  brokerStatusLabel,
  pairedDeviceCountLabel,
  ensureConversationTranscript(session) {
    return controller?.ensureConversationTranscript(session);
  },
  syncComposerModel(session) {
    syncComposerModelForRenderedSession(session);
  },
  updateSessionSettings(payload) {
    return controller?.updateSessionSettings(payload);
  },
  requestReview(values) {
    return controller?.requestReview(values);
  },
  startWorkflow(values) {
    return controller?.startWorkflow(values);
  },
  setReviewSlice(slice) {
    workspaceDiffStore.setReview(slice);
  },
  reviewsCache,
  workflowsCache,
  // Dedicated, uncompacted reviewer data. The snapshot carries only its revision
  // plus the minimal non-terminal gating projection.
  fetchReviews() {
    // Local is the operator surface (full access): the endpoint resolves reviews with no
    // device scope, so don't append a (dead) ?device_id query.
    return getReviews(apiFetch);
  },
  fetchWorkflows() {
    return getWorkflows(apiFetch);
  },
  // Hoisted module-level declarations below. `viewThread` is shared rather than a
  // method here because several call sites (sidebar rows, tab strip) need the one
  // implementation — they used to each inline a copy of its body.
  viewThread: viewThreadById,
  renderSessionTabs,
  // Projects master-detail: select a project and show its card overview in the main
  // area. Clears any open session so the overview (not a transcript) is what renders;
  // renderSession derives data-view="project-overview" from the selected project.
  enterProjectOverview(projectId) {
    state.threadListStore.getState().setActiveProject(projectId);
    clearThreadRoute();
    if (state.session) {
      renderer.renderSession(state.session);
    }
    renderer.renderThreads();
  },
  // "New agent" from a project overview: open the start-session dialog and remember
  // the project, so the session created by the next Start is auto-assigned to it.
  startProjectAgent(projectId) {
    state.pendingProjectAssignment = projectId || null;
    document.getElementById("launch-start-session-dialog")?.setAttribute("open", "");
  },
});

// Wrap renderer.renderSession so every full render also reconciles the
// liveness verb timer. Patching the object (rather than only the local
// destructured binding) ensures controller callbacks below also flow
// through the wrapper.
const _baseRenderSession = renderer.renderSession;
renderer.renderSession = function wrappedRenderSession(session) {
  if (devicesCache.hasData()) {
    session = { ...session, ...devicesCache.current() };
  }
  const previousLiveSession = state.session;
  const viewedThreadWasLive = Boolean(
    state.viewThreadId
    && previousLiveSession?.active_thread_id === state.viewThreadId
    && session?.active_thread_id !== state.viewThreadId
    && !state.viewOnlyThread
  );
  if (viewedThreadWasLive) {
    const summary =
      (state.threads || []).find((thread) => thread?.id === state.viewThreadId) || null;
    state.viewOnlyThread = buildViewOnlyPin({
      threadId: state.viewThreadId,
      priorEntries: previousLiveSession.transcript || [],
      cwd: summary?.cwd ?? previousLiveSession.current_cwd ?? null,
      provider: summary?.provider ?? previousLiveSession.provider ?? null,
      status: previousLiveSession.current_status || "idle",
      lastRefreshAt: Date.now(),
      lastRefreshServerTime: previousLiveSession.server_time ?? null,
      wasWorking: Boolean(previousLiveSession.active_turn_id),
    });
  }
  // Make the real session current BEFORE reconciling the view-only pin.
  // maybeRefreshViewOnly() (and the loadViewOnlyTranscript it may trigger) read
  // state.session; without this, the very first render after a deep link to a
  // non-active thread runs while state.session is still null, the self-heal load
  // bails, and the one-attempt guard suppresses every retry. _baseRenderSession
  // sets it again (idempotent).
  state.session = session;
  maybeRefreshViewOnly(session);
  _baseRenderSession(session);
  syncVerbTimer(session);
  if (viewedThreadWasLive) {
    void loadViewOnlyTranscript(state.viewThreadId);
  }
};

// A stable signature of the review running on `threadId`, so the read-only view
// re-fetches when the review advances (a new round, a posted-back result) and is
// released when it ends.
function viewOnlyReviewSignature(session, threadId) {
  if (!reviewsCache.hasData()) {
    return null;
  }
  const job = (reviewsCache.current()?.review_jobs || []).find(
    (entry) =>
      entry.parent_thread_id === threadId
      && !isTerminalReviewStatus(entry.status)
  );
  return job ? `${job.status}:${job.round ?? 0}:${job.updated_at ?? 0}` : "none";
}

// Fetch a non-active thread's transcript tail into state.viewOnlyThread so
// render-session.js can project it read-only (with scroll-up pagination via the
// pin's olderCursor). Works for ANY non-active thread — the review-locked parent
// case is just one flavor (pin.review). For the active thread it clears the
// projection. A generation guard drops stale responses when the user navigates
// again mid-fetch.
async function loadViewOnlyTranscript(threadId) {
  const session = state.session;
  if (!viewOnlyEligible(session, threadId)) {
    if (state.viewOnlyThread) {
      state.viewOnlyThread = null;
      if (state.session) renderer.renderSession(state.session);
    }
    return;
  }

  const review = isReviewInProgressForThread(session, threadId);
  const workflowLocked = isWorkflowInProgressForThread(session, threadId);
  const generation = (state.viewOnlyGeneration = (state.viewOnlyGeneration || 0) + 1);
  const reviewSig = review ? viewOnlyReviewSignature(session, threadId) : null;
  // The viewed thread's own metadata (workspace + provider), so the projection
  // shows them instead of the live thread's for a cross-workspace saved thread.
  const summary = (state.threads || []).find((thread) => thread?.id === threadId) || null;
  const cwd = summary?.cwd ?? null;
  const provider = summary?.provider ?? null;
  const prior = state.viewOnlyThread?.threadId === threadId ? state.viewOnlyThread : null;
  const isWorking = Boolean(
    (session.thread_activity || []).find((entry) => entry?.thread_id === threadId)
  );
  const status = !isWorking && prior?.wasWorking ? "idle" : summary?.status ?? null;
  state.viewOnlyThread = buildViewOnlyPin({
    threadId,
    generation,
    review,
    workflowLocked,
    reviewSig,
    cwd,
    provider,
    status,
    activeTurnId: prior?.activeTurnId || null,
    currentStatus: prior?.currentStatus || null,
    currentPhase: prior?.currentPhase || null,
    currentTool: prior?.currentTool || null,
    lastProgressAt: prior?.lastProgressAt ?? null,
    settings: prior?.settings || null,
    settingsWritable: Boolean(prior?.settingsWritable),
    availableModels: prior?.availableModels || [],
    lastRefreshAt: Date.now(),
    lastRefreshServerTime: prior?.lastRefreshServerTime ?? null,
    wasWorking: isWorking,
    priorEntries: prior?.entries || [],
    priorOlderCursor: prior?.olderCursor ?? null,
    historyExtended: Boolean(prior?.historyExtended),
    loading: true,
  });
  if (state.session) renderer.renderSession(state.session);

  try {
    const page = await controller?.fetchTranscriptPage(threadId, {});
    if (generation !== state.viewOnlyGeneration) return;
    const normalized =
      page && Array.isArray(page.entries)
        ? page
        : { thread_id: threadId, entries: Array.isArray(page) ? page : [], prev_cursor: null };
    if (normalized.thread_id !== threadId) {
      throw new Error(
        `Transcript response thread mismatch (expected ${threadId}, received ${
          normalized.thread_id || "missing"
        })`
      );
    }
    const refreshed = mergeRefreshedViewOnlyPage(prior, normalized);
    const exactReview = Boolean(normalized.thread_state?.review_locked ?? review);
    state.viewOnlyThread = buildViewOnlyPin({
      threadId,
      page: {
        ...normalized,
        entries: refreshed.entries,
        prev_cursor: refreshed.olderCursor,
      },
      generation,
      review: exactReview,
      workflowLocked: Boolean(normalized.thread_state?.workflow_locked ?? workflowLocked),
      reviewSig: exactReview ? viewOnlyReviewSignature(session, threadId) : reviewSig,
      cwd: normalized.thread_state?.current_cwd ?? cwd,
      provider: normalized.thread_state?.provider ?? provider,
      status,
      activeTurnId: normalized.thread_state?.active_turn_id || null,
      currentStatus: normalized.thread_state?.current_status || null,
      currentPhase: normalized.thread_state?.current_phase || null,
      currentTool: normalized.thread_state?.current_tool || null,
      lastProgressAt: normalized.thread_state?.last_progress_at ?? null,
      settings: normalized.thread_state
        ? {
          approval_policy: normalized.thread_state.approval_policy || "",
          sandbox: normalized.thread_state.sandbox || "",
          reasoning_effort: normalized.thread_state.reasoning_effort || "",
          model: normalized.thread_state.model || "",
        }
        : null,
      settingsWritable: Boolean(normalized.thread_state?.settings_writable),
      availableModels: normalized.thread_state?.available_models || [],
      lastRefreshAt: Date.now(),
      lastRefreshServerTime: normalized.server_time ?? null,
      wasWorking: isWorking,
      historyExtended: refreshed.historyExtended,
    });
  } catch (error) {
    if (generation !== state.viewOnlyGeneration) return;
    state.viewOnlyThread = buildViewOnlyPin({
      threadId,
      generation,
      review,
      workflowLocked,
      reviewSig,
      cwd,
      provider,
      status,
      activeTurnId: prior?.activeTurnId || null,
      currentStatus: prior?.currentStatus || null,
      currentPhase: prior?.currentPhase || null,
      currentTool: prior?.currentTool || null,
      lastProgressAt: prior?.lastProgressAt ?? null,
      settings: prior?.settings || null,
      settingsWritable: Boolean(prior?.settingsWritable),
      availableModels: prior?.availableModels || [],
      lastRefreshAt: Date.now(),
      lastRefreshServerTime: prior?.lastRefreshServerTime ?? null,
      wasWorking: isWorking,
      priorEntries: prior?.entries || [],
      priorOlderCursor: prior?.olderCursor ?? null,
      historyExtended: Boolean(prior?.historyExtended),
      // Mark the failure so the self-heal (viewOnlySelfHealThreadId) retries this
      // load after a backoff instead of treating the empty shell as settled.
      error: true,
    });
    logLine(`Couldn't load the read-only session view: ${error.message}`);
  }
  if (state.session) renderer.renderSession(state.session);
}

// Scroll-up pagination for the read-only pin: fetch the page before the pin's
// olderCursor (cache-aware via the transcript page cache) and prepend it.
// Deliberately separate from the active-thread hydration pipeline — that store
// is keyed to the live thread and must not be re-keyed by a view-only visit.
let viewOnlyOlderLoading = false;
const viewOnlyRefreshLatch = createViewedThreadRefreshLatch();
// Returns the same tri-state the active-thread loader uses so the history
// loader can keep prefetching read-only pins within one intersection:
//   true  → a page loaded and more remain
//   false → reached the pin's oldest page (stop for good)
//   null  → nothing loaded right now (in-flight / not viewing / error) — retry
async function loadOlderViewOnlyTranscript() {
  const pin = state.viewOnlyThread;
  if (!pin || state.viewThreadId !== pin.threadId) {
    return null;
  }
  if (pin.olderCursor == null) {
    return false; // no older cursor → this is the oldest page of the pin
  }
  if (pin.loading || viewOnlyOlderLoading) {
    return null; // a load is already in flight; not a definitive stop
  }
  const generation = pin.generation;
  viewOnlyOlderLoading = true;
  try {
    const page = await controller?.fetchTranscriptPage(pin.threadId, {
      before: pin.olderCursor,
    });
    const current = state.viewOnlyThread;
    if (!current || current.generation !== generation || current.threadId !== pin.threadId) {
      return null; // user navigated / pin replaced while the fetch was in flight
    }
    state.viewOnlyThread = mergeOlderViewOnlyPage(current, page);
    if (state.session) renderer.renderSession(state.session);
    return state.viewOnlyThread?.olderCursor != null;
  } catch (error) {
    logLine(`Couldn't load older messages for the read-only view: ${error.message}`);
    return null;
  } finally {
    viewOnlyOlderLoading = false;
    const deferredThreadId = viewOnlyRefreshLatch.take();
    if (
      deferredThreadId
      && state.viewThreadId === deferredThreadId
      && state.viewOnlyThread?.threadId === deferredThreadId
    ) {
      // Re-evaluate against the latest session. The viewed thread may have
      // started working again or the user may have navigated while history was
      // loading, so the deferred signal alone is not authority to fetch.
      maybeRefreshViewOnly(state.session);
    }
  }
}

// Called on every render: keep the pin honest against the latest REAL session.
// Pins stay pinned while viewed and never auto-resume. Review pins refresh when
// their review advances or ends. Also self-heals: deep links / back-button land on a
// non-active thread without going through viewThread(), and a rapid-switch race can
// drop the pin — so re-arm the load here whenever the viewed thread lacks a good pin
// (viewOnlySelfHealThreadId), with a backoff on failures so a failing fetch can't loop.
function maybeRefreshViewOnly(session) {
  const pin = state.viewOnlyThread;
  if (pin && session) {
    const action = viewOnlyPinNextAction(session, pin, {
      viewThreadId: state.viewThreadId,
      reviewSignature: viewOnlyReviewSignature,
    });
    if (action.kind === "release") {
      state.viewOnlyThread = null;
    } else if (action.kind === "refresh") {
      // Review/workflow lifecycle transitions are authoritative and may be the
      // final signal we receive, so do not defer them behind history loading.
      void loadViewOnlyTranscript(pin.threadId);
    } else {
      const working = Boolean(
        (session.thread_activity || []).find((entry) => entry?.thread_id === pin.threadId)
      );
      if (shouldRefreshViewedThread({
        elapsedMs: Date.now() - (pin.lastRefreshAt || 0),
        historyLoading: viewOnlyOlderLoading,
        loading: pin.loading,
        wasWorking: pin.wasWorking,
        working,
      })) {
        if (viewOnlyOlderLoading) {
          // Only the working→idle case passes shouldRefreshViewedThread while
          // history is loading. Let that page land, then re-check the terminal
          // state from the loader's finally block.
          viewOnlyRefreshLatch.defer(pin.threadId);
        } else {
          void loadViewOnlyTranscript(pin.threadId);
        }
      }
    }
  }

  // The viewed thread's cwd/provider come from its thread summary, which on a
  // deep link loads AFTER the session — so a deep-linked pin can be built with
  // them null. Backfill once the summary appears (otherwise the projection shows
  // blank metadata until then).
  const metaPin = state.viewOnlyThread;
  if (metaPin && (metaPin.cwd == null || metaPin.provider == null)) {
    const summary = (state.threads || []).find((thread) => thread?.id === metaPin.threadId) || null;
    if (summary && (summary.cwd != null || summary.provider != null)) {
      state.viewOnlyThread = {
        ...metaPin,
        cwd: metaPin.cwd ?? summary.cwd ?? null,
        provider: metaPin.provider ?? summary.provider ?? null,
      };
    }
  }

  const selfHeal = viewOnlySelfHealThreadId(session, {
    viewThreadId: state.viewThreadId,
    viewOnlyThread: state.viewOnlyThread,
    now: Date.now(),
  });
  if (selfHeal) {
    void loadViewOnlyTranscript(selfHeal);
  }
}

controller = createSessionController({
  state,
  apiFetch,
  queryClient: localQueryClient,
  shortId,
  logLine,
  seedDefaults,
  setSelectedCwd,
  setThreadRoute,
  canCurrentDeviceWrite,
  renderSession: renderer.renderSession,
  renderOverviewState: renderer.renderOverviewState,
  renderSessionUnavailable: renderer.renderSessionUnavailable,
  renderThreadListMessage: renderer.renderThreadListMessage,
  renderThreads: renderer.renderThreads,
  renderAuthRequiredState: renderer.renderAuthRequiredState,
  runViewTransition: renderer.runViewTransition,
  handleUnauthorized,
});
// Stash on state so React render paths (e.g. transcript-react.js's
// AskUserEntry onClick) can call back into the controller without an
// additional prop-drilling layer through every render entrypoint.
state.controller = controller;

const {
  renderAuthRequiredState,
  renderSession,
  renderSessionMeta,
  renderThreads,
  runViewTransition,
  syncThreadHistoryScroll,
  syncThreadSelection,
} = renderer;

const {
  cancelControllerHeartbeat,
  cancelControllerLeaseRefresh,
  cancelSessionPoll,
  cancelStreamReconnect,
  cancelThreadsPoll,
  connectSessionStream,
  copyPairingLink,
  decidePairingRequest,
  forkSession,
  loadSession,
  loadThreads,
  resumeLatestSession,
  resumeSession,
  revokeOtherDevices,
  revokePairedDevice,
  saveAllowedRoots,
  scheduleThreadsPoll,
  sendMessage,
  stopActiveTurn,
  startPairing,
  startSession,
  submitDecision,
  takeOverControl,
  toggleTranscriptEntry,
  toggleTranscriptExpandKey,
  applyFileChange,
} = controller;

threadsList?.addEventListener("scroll", () => {
  state.threadHistoryScrollTop = threadsList.scrollTop;
});

sessionHistoryDrawer?.addEventListener("toggle", () => {
  state.threadListStore.getState().setDrawerOpen(Boolean(sessionHistoryDrawer.open));
});

installThreadListWheelProxy({
  root: sessionHistoryDrawer,
  scrollElement: threadsList,
  shouldProxyWheel() {
    return Boolean(sessionHistoryDrawer?.open);
  },
});

connectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitAuthSession();
});

startPairingButton.addEventListener("click", () => {
  void startPairing();
});

const SETTINGS_TABS = ["providers", "devices", "log", "appearance"];

// Toggle which Settings tab is active (button `is-active` + panel `hidden`).
// Panels are all mounted up front so their ids resolve at dom.js import time.
function setSettingsTab(tab = "providers") {
  const active = SETTINGS_TABS.includes(tab) ? tab : "providers";
  for (const key of SETTINGS_TABS) {
    const btn = document.getElementById(`settings-tab-${key}`);
    btn?.classList.toggle("is-active", key === active);
    btn?.setAttribute("aria-selected", key === active ? "true" : "false");
    const panel = document.querySelector(`[data-settings-panel="${key}"]`);
    if (panel) {
      panel.hidden = key !== active;
    }
  }
}

function openSettingsModal(tab = "providers") {
  // Devices sub-panels are also refreshed on every snapshot, but re-render on open
  // so the modal reflects the latest state immediately. Providers + audit (Log tab)
  // are kept fresh by the render loop (renderProviderStatus / renderAuditTimeline).
  state.localUiStore.getState().setAllowedRootsDraftDirty(false);
  renderAllowedRoots(state.session?.allowed_roots || [], {
    draftDirty: readLocalUiState(state.localUiStore).allowedRootsDraftDirty,
  });
  renderPairingPanel(state.currentPairing);
  renderDeviceRecords(state.session?.device_records || []);
  renderPendingPairingRequests(
    state.session?.pending_pairing_requests || [],
    state.pendingPairingDecisions || {}
  );
  setSettingsTab(tab);
  settingsModal?.showModal();
}

iconRailSettingsButton?.addEventListener("click", () => openSettingsModal());
// Mobile-only header gear (the rail is hidden ≤960px) opens the same Settings modal.
document
  .getElementById("open-settings-header")
  ?.addEventListener("click", () => openSettingsModal());
for (const key of SETTINGS_TABS) {
  document
    .getElementById(`settings-tab-${key}`)
    ?.addEventListener("click", () => setSettingsTab(key));
}

// Sessions/Projects sidebar grouping toggle (static-shell buttons wired by id).
const threadsViewSessionsButton = document.getElementById("threads-view-sessions");
const threadsViewProjectsButton = document.getElementById("threads-view-projects");
// Land on a project (the first, by list order) when Projects mode is active but none
// is validly selected — so the main area shows a card overview rather than the console
// home. Also drops a STALE selection: if the active project was deleted (locally or by
// a remote peer), its id lingers in the store and would keep the view stuck in a
// project-overview for a project that no longer exists (rendering "Select a project"),
// and block newly-created projects from auto-selecting. Re-point to the first remaining
// project, or clear the selection when none remain.
function ensureActiveProjectSelected() {
  const projects = state.projects || [];
  const activeId = readActiveProjectId(state.threadListStore);
  if (activeId && projects.some((project) => project.id === activeId)) {
    return;
  }
  const nextId = projects[0]?.id ?? null;
  if (nextId !== activeId) {
    state.threadListStore.getState().setActiveProject(nextId);
  }
}

function setThreadViewMode(mode) {
  const isProjects = mode === "projects";
  state.threadListStore.getState().setViewMode(isProjects ? "projects" : "sessions");
  threadsViewProjectsButton?.classList.toggle("is-active", isProjects);
  threadsViewSessionsButton?.classList.toggle("is-active", !isProjects);
  // Mode-gate the sidebar's primary actions via CSS: the Projects toolbar shows in
  // Projects mode, the New session / Continue latest launch panel in Sessions mode.
  if (sidebarElement) {
    sidebarElement.dataset.threadView = isProjects ? "projects" : "sessions";
  }
  if (projectsToolbar) {
    projectsToolbar.hidden = !isProjects;
  }
  // Ensure the Projects payload is loaded when switching in (no-op if already current).
  if (isProjects) {
    projectsStore.syncToRevision(state.session?.projects_revision || 0);
    ensureActiveProjectSelected();
  }
  // Each mode owns its own tab workspace, so switching mode switches which sessions
  // are "open" — and the route has to follow. Without this the main area kept showing
  // the previous mode's session while the strip already showed the target mode's tabs
  // (or none), leaving the transcript and the strip describing different things.
  // Runs BEFORE the renders below, and with the transition disabled, so those renders
  // can't skip a pending route update.
  syncRouteToCurrentWorkspace();
  renderThreads();
  // Switch the main area too: entering Projects shows the card overview; leaving it
  // returns to console/conversation. renderSession derives the view from the mode.
  if (state.session) {
    renderSession(state.session);
  }
}
threadsViewSessionsButton?.addEventListener("click", () => setThreadViewMode("sessions"));
threadsViewProjectsButton?.addEventListener("click", () => setThreadViewMode("projects"));

// Prompt for a Project name (trimmed; null aborts). Native prompt mirrors the
// window.confirm flow the archive/delete affordances already use.
function promptProjectName(current = "") {
  return normalizeProjectName(window.prompt("Project name", current));
}

// Create a Project from the Projects toolbar. Membership/list refresh rides the
// snapshot's projects_revision bump (project_action calls notify()), same as an
// API-driven mutation — no manual store.refresh() needed.
async function createProjectFromToolbar() {
  const name = promptProjectName();
  if (!name) {
    return;
  }
  try {
    await createProject(apiFetch, name);
    logLine(`Created project "${name}".`);
  } catch (error) {
    logLine(`Failed to create project: ${error.message}`);
  }
}
projectsCreateButton?.addEventListener("click", () => {
  void createProjectFromToolbar();
});

// Rename a Project from its group header (Projects view). Prompt pre-filled with the
// current name; refresh rides the projects_revision snapshot bump like every mutation.
async function renameProjectFromHeader(projectId, currentName) {
  if (!projectId) {
    return;
  }
  const name = promptProjectName(currentName || "");
  if (!name || name === currentName) {
    return;
  }
  try {
    await renameProject(apiFetch, projectId, name);
    logLine(`Renamed project to "${name}".`);
  } catch (error) {
    logLine(`Failed to rename project: ${error.message}`);
  }
}

// Delete a Project from its group header. Its sessions become Unassigned (the sessions
// themselves are not deleted). Confirm first, mirroring the archive/delete flows.
async function deleteProjectFromHeader(projectId, name) {
  if (!projectId) {
    return;
  }
  const confirmed = window.confirm(
    `Delete project "${name}"?\n\nIts sessions become Unassigned — the sessions themselves are not deleted.`
  );
  if (!confirmed) {
    return;
  }
  try {
    await deleteProject(apiFetch, projectId);
    logLine(`Deleted project "${name}".`);
  } catch (error) {
    logLine(`Failed to delete project: ${error.message}`);
  }
}

// Right-click menu for a project row in the sidebar (Projects mode). Positioned +
// toggled imperatively like #thread-context-menu; the target project is held here so
// the Rename/Delete buttons act on whatever row was right-clicked.
let projectContextTarget = null;
function openProjectContextMenu(projectId, name, clientX, clientY) {
  if (!projectContextMenu || !projectId) {
    return;
  }
  // Don't stack the two menus.
  closeThreadContextMenu({ rerender: false });
  projectContextTarget = { id: projectId, name: name || projectId };
  projectContextMenu.hidden = false;
  const left = Math.max(12, Math.min(clientX, window.innerWidth - 220));
  const top = Math.max(12, Math.min(clientY, window.innerHeight - 96));
  projectContextMenu.style.left = `${left}px`;
  projectContextMenu.style.top = `${top}px`;
}

function closeProjectContextMenu() {
  if (projectContextMenu) {
    projectContextMenu.hidden = true;
  }
  projectContextTarget = null;
}

renameProjectMenuButton?.addEventListener("click", () => {
  const target = projectContextTarget;
  closeProjectContextMenu();
  if (target) {
    void renameProjectFromHeader(target.id, target.name);
  }
});

deleteProjectMenuButton?.addEventListener("click", () => {
  const target = projectContextTarget;
  closeProjectContextMenu();
  if (target) {
    void deleteProjectFromHeader(target.id, target.name);
  }
});

// Run one context-menu Project action for a thread (assign / unassign / new+assign).
// `builtSeq` is the projectsStateSeq captured when the clicked button was built.
async function runThreadProjectAction(threadId, item, builtSeq) {
  closeThreadContextMenu();
  if (!threadId || !item) {
    return;
  }
  // Execution-time freshness guard: refuse to act on a button built from Project state
  // that has since changed or is no longer trustworthy (a newer revision arrived, or a
  // refresh is pending/failed). Otherwise a stale button could overwrite newer
  // membership. The user reopens the menu to act on current state.
  if (
    !projectMenuActionAllowed({
      builtSeq,
      currentSeq: projectsStateSeq,
      projectsLoaded: state.projectsLoaded,
      projectsError: state.projectsError,
      projectsLoading: state.projectsLoading,
    })
  ) {
    logLine("Projects changed — reopen the menu to change membership.");
    return;
  }
  try {
    if (item.kind === "unassign") {
      await unassignThread(apiFetch, threadId);
      logLine(`Removed session ${shortId(threadId)} from its project.`);
      return;
    }
    if (item.kind === "assign") {
      if (item.isCurrent) {
        return; // already there — no-op
      }
      await assignThreadToProject(apiFetch, threadId, item.projectId);
      logLine(`Moved session ${shortId(threadId)} to "${item.label}".`);
      return;
    }
    if (item.kind === "create") {
      const name = promptProjectName();
      if (!name) {
        return;
      }
      const before = state.projects || [];
      const receipt = await createProject(apiFetch, name);
      const projectId = pickNewProjectId(before, receipt?.projects);
      if (!projectId) {
        // Created, but the new id was ambiguous — leave the session unassigned rather
        // than guess. The snapshot refresh still surfaces the new (empty) project.
        logLine(`Created project "${name}" (assign the session from its menu).`);
        return;
      }
      await assignThreadToProject(apiFetch, threadId, projectId);
      logLine(`Created project "${name}" and moved session ${shortId(threadId)} into it.`);
    }
  } catch (error) {
    logLine(`Failed to update project membership: ${error.message}`);
  }
}

// Rebuild the context menu's per-session Project section for `threadId` from the
// current Projects payload. Called each time the menu opens (openThreadContextMenu).
function populateThreadProjectActions(threadId) {
  if (!threadProjectActions) {
    return;
  }
  threadProjectActions.textContent = ""; // drop prior buttons (and their listeners)
  // Fail closed: mirror the sidebar renderer — never present Project membership or
  // mutation controls as authoritative unless we hold a current payload. During a
  // pending/failed/first-load fetch, show a non-interactive note instead of buttons
  // (which would falsely imply "no projects / not a member" or expose stale controls).
  if (
    !projectsMenuReady({
      projectsLoaded: state.projectsLoaded,
      projectsError: state.projectsError,
      projectsLoading: state.projectsLoading,
    })
  ) {
    const note = document.createElement("p");
    note.className = "context-menu-note";
    note.textContent = state.projectsError ? "Projects unavailable" : "Loading projects…";
    threadProjectActions.appendChild(note);
    return;
  }
  const builtSeq = projectsStateSeq; // freshness token for this build
  const currentProjectId = state.threadProjectId?.[threadId] || null;
  const items = buildProjectMenuItems({ projects: state.projects || [], currentProjectId });
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-menu-button context-menu-project-button";
    if (item.isCurrent) {
      button.classList.add("is-current");
      button.setAttribute("aria-current", "true");
    }
    if (item.kind === "create") {
      button.classList.add("context-menu-project-create");
    }
    button.textContent = item.isCurrent ? `✓ ${item.label}` : item.label;
    button.addEventListener("click", () => {
      void runThreadProjectAction(threadId, item, builtSeq);
    });
    threadProjectActions.appendChild(button);
  }
}

closeSettingsModalButton?.addEventListener("click", () => {
  settingsModal?.close();
});

settingsModal?.addEventListener("click", (event) => {
  if (event.target === settingsModal) {
    settingsModal.close();
  }
});

closePairingApprovalModalBtn?.addEventListener("click", () => {
  pairingApprovalModal?.close();
});

pairingApprovalModal?.addEventListener("click", (event) => {
  if (event.target === pairingApprovalModal) {
    pairingApprovalModal.close();
    return;
  }

  const decisionButton = event.target.closest("[data-pairing-id][data-pairing-decision]");
  if (!decisionButton) {
    return;
  }

  void decidePairingRequest(
    decisionButton.dataset.pairingId,
    decisionButton.dataset.pairingDecision
  );
});

openLaunchSettingsButton?.addEventListener("click", () => {
  launchSettingsModal?.showModal();
});

closeLaunchSettingsModalButton?.addEventListener("click", () => {
  launchSettingsModal?.close();
});

launchSettingsModal?.addEventListener("click", (event) => {
  if (event.target === launchSettingsModal) {
    launchSettingsModal.close();
  }
});

openSessionDetailsButton?.addEventListener("click", () => {
  if (state.session) {
    renderSessionMeta(state.session);
  }
  sessionDetailsModal?.showModal();
});

closeSessionDetailsModalButton?.addEventListener("click", () => {
  sessionDetailsModal?.close();
});

sessionDetailsModal?.addEventListener("click", (event) => {
  if (event.target === sessionDetailsModal) {
    sessionDetailsModal.close();
  }
});

copyPairingLinkButton.addEventListener("click", () => {
  void copyPairingLink();
});

allowedRootsInput?.addEventListener("input", () => {
  state.localUiStore.getState().setAllowedRootsDraftDirty(true);
});

allowedRootsForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveAllowedRoots();
});

// Exit the current session back to the list/overview. Bound to the in-conversation
// header back arrow, the legacy sidebar back button, and the icon-rail home (folder).
function goConsoleHome() {
  clearThreadRoute();
  if (state.session) {
    renderSession(state.session);
  }
  renderThreads();
}

goConsoleHomeButton?.addEventListener("click", goConsoleHome);
goConsoleHomeSidebarButton?.addEventListener("click", goConsoleHome);
// The icon rail is always visible, so its folder is the reliable way to bring the
// nav panel back after it's been collapsed: expand the sidebar, then go home.
iconRailHomeButton?.addEventListener("click", () => {
  leftPanelControl.open();
  goConsoleHome();
});

threadsRefreshButton.addEventListener("click", () => {
  void loadThreads("manual refresh");
});

archiveThreadButton?.addEventListener("click", () => {
  void archiveThreadFromContextMenu();
});

forkThreadButton?.addEventListener("click", () => {
  const threadId = readThreadListContextMenu(state.threadListStore).threadId;
  if (threadId) {
    openForkDialogForThread(threadId);
  }
});

deleteThreadButton?.addEventListener("click", () => {
  void deleteThreadFromContextMenu();
});

document.addEventListener("click", (event) => {
  if (projectContextMenu && !projectContextMenu.hidden && !event.target.closest("#project-context-menu")) {
    closeProjectContextMenu();
  }

  if (!threadContextMenu || threadContextMenu.hidden) {
    return;
  }

  if (event.target.closest("#thread-context-menu")) {
    return;
  }

  closeThreadContextMenu();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeThreadContextMenu();
    closeProjectContextMenu();
  }
});

window.addEventListener("blur", () => {
  closeThreadContextMenu();
  closeProjectContextMenu();
});

window.addEventListener("resize", () => {
  closeThreadContextMenu();
  closeProjectContextMenu();
  syncThreadHistoryScroll();
});

window.addEventListener("popstate", () => {
  state.viewThreadId = readThreadIdFromUrl();
  // Back/forward writes viewThreadId directly rather than going through
  // setThreadRoute (it must not push another history entry), so re-open the tab
  // here. Navigating back to a session you had merely CLOSED re-opens it, which keeps
  // the strip and the transcript agreeing.
  // A history entry can name a session that was archived or deleted since; refusing to
  // create its tab is not enough, the route must not be left pointing at it either.
  adoptRoutedThread();
  if (state.session) {
    renderSession(state.session);
  }
  renderThreads();
});

directoryForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  clearThreadRoute();
  setSelectedCwd(cwdInput.value.trim());
  void loadThreads("directory change");
});

resumeLatestButton?.addEventListener("click", () => {
  void resumeLatestSession();
});

// A plain new-session opener (launcher, header compose, empty-state CTA) resets any
// pending project assignment, so a session started from the normal launcher never
// inherits a project the user only glanced at via "New agent".
document.addEventListener("click", (event) => {
  const el = event.target instanceof Element ? event.target : null;
  if (!el) return;
  if (
    el.closest("#open-start-session-dialog") ||
    el.closest("#new-session-compose-button") ||
    el.closest("[data-start-session]")
  ) {
    state.pendingProjectAssignment = null;
  }
});

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  if (!target?.closest("#start-session-button")) {
    return;
  }
  if (state.newSessionSubmitInFlight) {
    return;
  }
  // Consume any pending "New agent" project synchronously (so a failed/cancelled
  // start can't leave it dangling), then assign the freshly-created thread once
  // startSession resolves with its id.
  const assignToProject = state.pendingProjectAssignment;
  state.pendingProjectAssignment = null;
  const imageAttachments = state.newSessionImageAttachments.slice();
  state.newSessionSubmitInFlight = true;
  renderNewSessionImageAttachments();
  void startSession(imageAttachments).then((newThreadId) => {
    if (newThreadId) {
      const sentIds = new Set(imageAttachments.map((attachment) => attachment.id));
      state.newSessionImageAttachments = state.newSessionImageAttachments.filter(
        (attachment) => !sentIds.has(attachment.id)
      );
    }
    if (newThreadId && assignToProject) {
      void assignNewSessionToProject(newThreadId, assignToProject);
    }
  }).finally(() => {
    state.newSessionSubmitInFlight = false;
    renderNewSessionImageAttachments();
  });
});

// Assign a just-started session to the project its "New agent" button belongs to. The
// membership change rides the snapshot's projects_revision bump (assign calls notify),
// same as every other project mutation, so the sidebar/overview refresh on their own.
async function assignNewSessionToProject(threadId, projectId) {
  try {
    await assignThreadToProject(apiFetch, threadId, projectId);
    const name = (state.projects || []).find((project) => project.id === projectId)?.name || "project";
    logLine(`Added the new session to "${name}".`);
  } catch (error) {
    logLine(`Started the session, but couldn't add it to the project: ${error.message}`);
  }
}

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement) && !(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement)) {
    return;
  }
  handleLaunchFieldInput(target.id, target.value);
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement)) {
    return;
  }
  handleLaunchFieldInput(target.id, target.value);
});

controlBanner?.addEventListener("click", (event) => {
  if (!event.target.closest("#take-over-button")) {
    return;
  }

  void takeOverControl();
});

function renderComposerImageAttachments() {
  if (!composerAttachments) return;
  composerAttachments.replaceChildren();
  composerAttachments.hidden = state.composerImageAttachments.length === 0;

  for (const attachment of state.composerImageAttachments) {
    const chip = document.createElement("span");
    chip.className = "composer-attachment";

    const name = document.createElement("span");
    name.className = "composer-attachment-name";
    name.textContent = `${attachment.file.name || "Pasted image"} · ${formatAttachmentBytes(attachment.file.size)}`;
    chip.append(name);

    const remove = document.createElement("button");
    remove.className = "composer-attachment-remove";
    remove.dataset.removeImageAttachment = attachment.id;
    remove.disabled = state.composerSubmitInFlight;
    remove.type = "button";
    remove.title = "Remove image";
    remove.setAttribute("aria-label", `Remove ${attachment.file.name || "pasted image"}`);
    remove.textContent = "×";
    chip.append(remove);

    composerAttachments.append(chip);
  }
}

function clearComposerImageAttachments() {
  if (state.composerImageAttachments.length === 0) return;
  state.composerImageAttachments = [];
  renderComposerImageAttachments();
}

function renderNewSessionImageAttachments() {
  if (!startPromptAttachments) return;
  startPromptAttachments.replaceChildren();
  startPromptAttachments.hidden = state.newSessionImageAttachments.length === 0;

  for (const attachment of state.newSessionImageAttachments) {
    const chip = document.createElement("span");
    chip.className = "composer-attachment";

    const name = document.createElement("span");
    name.className = "composer-attachment-name";
    name.textContent = `${attachment.file.name || "Pasted image"} · ${formatAttachmentBytes(attachment.file.size)}`;
    chip.append(name);

    const remove = document.createElement("button");
    remove.className = "composer-attachment-remove";
    remove.dataset.removeNewSessionImageAttachment = attachment.id;
    remove.disabled = state.newSessionSubmitInFlight;
    remove.type = "button";
    remove.title = "Remove image";
    remove.setAttribute("aria-label", `Remove ${attachment.file.name || "pasted image"}`);
    remove.textContent = "×";
    chip.append(remove);

    startPromptAttachments.append(chip);
  }
}

function clearNewSessionImageAttachments() {
  if (state.newSessionImageAttachments.length === 0) return;
  state.newSessionImageAttachments = [];
  renderNewSessionImageAttachments();
}

// Treat each opening as a fresh attachment draft. In particular, reopening
// after dismissing the dialog or after a failed start cannot silently carry a
// screenshot into an unrelated workspace/session. An in-flight start already
// captured its own attachment slice before the dialog closed.
if (launchStartSessionDialog && typeof MutationObserver === "function") {
  const newSessionDialogObserver = new MutationObserver(() => {
    if (launchStartSessionDialog.hasAttribute("open")) {
      clearNewSessionImageAttachments();
    }
  });
  newSessionDialogObserver.observe(launchStartSessionDialog, {
    attributeFilter: ["open"],
    attributes: true,
  });
}

startPromptInput?.addEventListener("paste", (event) => {
  const files = pastedImageFiles(event.clipboardData);
  if (files.length === 0) return;
  event.preventDefault();

  const { accepted, errors } = validateImageAttachments(
    state.newSessionImageAttachments,
    files
  );
  for (const file of accepted) {
    state.newSessionImageAttachments.push({
      file,
      id: `new-session-image-${state.nextNewSessionImageAttachmentId++}`,
    });
  }
  for (const error of errors) {
    logLine(`New session image rejected: ${error}`);
  }
  if (accepted.length > 0) {
    logLine(
      `Attached ${accepted.length} pasted image${accepted.length === 1 ? "" : "s"} to the new session.`
    );
    renderNewSessionImageAttachments();
  }
});

startPromptAttachments?.addEventListener("click", (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest("[data-remove-new-session-image-attachment]")
      : null;
  if (!button || state.newSessionSubmitInFlight) return;
  state.newSessionImageAttachments = state.newSessionImageAttachments.filter(
    (attachment) => attachment.id !== button.dataset.removeNewSessionImageAttachment
  );
  renderNewSessionImageAttachments();
  startPromptInput.focus();
});

messageInput?.addEventListener("paste", (event) => {
  const files = pastedImageFiles(event.clipboardData);
  if (files.length === 0) return;
  event.preventDefault();

  const { accepted, errors } = validateImageAttachments(
    state.composerImageAttachments,
    files
  );
  for (const file of accepted) {
    state.composerImageAttachments.push({
      file,
      id: `image-${state.nextComposerImageAttachmentId++}`,
    });
  }
  for (const error of errors) {
    logLine(`Image attachment rejected: ${error}`);
  }
  if (accepted.length > 0) {
    logLine(
      `Attached ${accepted.length} pasted image${accepted.length === 1 ? "" : "s"}.`
    );
    renderComposerImageAttachments();
  }
});

composerAttachments?.addEventListener("click", (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest("[data-remove-image-attachment]")
      : null;
  if (!button || state.composerSubmitInFlight) return;
  state.composerImageAttachments = state.composerImageAttachments.filter(
    (attachment) => attachment.id !== button.dataset.removeImageAttachment
  );
  renderComposerImageAttachments();
  messageInput.focus();
});

// Drive a composer submit. The draft text and the target thread are captured
// synchronously at submit time and the composer is frozen, so a draft edit /
// navigation / second submit during the async send can't change or duplicate it.
// The send carries the target thread id; the relay starts the turn directly on
// that thread and moves control after success.
async function runComposerSubmit() {
  const text = messageInput.value;
  const imageAttachments = state.composerImageAttachments.slice();
  const pin = state.viewOnlyThread;
  if (pin?.review) {
    // A thread mid-review can't be sent to (the relay rejects resume/send for it).
    if (text.trim() || imageAttachments.length > 0) {
      logLine("This session is being reviewed — you can’t send to it right now.");
    }
    return;
  }
  if (!text.trim() && imageAttachments.length === 0) {
    void sendMessage(text); // empty → sendMessage logs the parity message
    return;
  }
  // The thread the user is looking at (the read-only pin's thread, else active).
  const targetThreadId = pin?.threadId || state.session?.active_thread_id || null;
  state.composerSubmitInFlight = true;
  renderComposerImageAttachments();
  if (state.session) renderer.renderSession(state.session); // freeze the composer
  try {
    const images = await Promise.all(
      imageAttachments.map(async (attachment) => ({
        data_url: await imageFileToDataUrl(attachment.file),
      }))
    );
    const sent = await sendMessage(text, targetThreadId, images);
    if (sent) {
      const sentIds = new Set(imageAttachments.map((attachment) => attachment.id));
      state.composerImageAttachments = state.composerImageAttachments.filter(
        (attachment) => !sentIds.has(attachment.id)
      );
    }
  } catch (error) {
    logLine(`Image attachment failed: ${error.message}`);
  } finally {
    state.composerSubmitInFlight = false;
    renderComposerImageAttachments();
    if (state.session) renderer.renderSession(state.session); // unfreeze
  }
}

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.composerSubmitInFlight) {
    return; // a submit is already in flight — ignore the re-entry (double click)
  }
  void runComposerSubmit();
});

providerInput?.addEventListener("change", () => {
  void selectLaunchProvider(providerInput.value);
});

modelInput?.addEventListener("change", () => {
  const provider = providerInput?.value || state.session?.provider || "codex";
  const models = modelsForProvider(provider, state.session?.available_models || []);
  syncEffortSuggestions(startEffortInput, models, modelInput.value, startEffortInput.value, provider);
});

messageModel?.addEventListener("change", () => {
  // Effort is no longer in the composer; the popover owns it. Just react
  // to model changes so an effort default can still be persisted for this
  // provider+model pair.
  const provider = state.session?.provider;
  if (!provider) return;
  const models = state.session?.available_models || [];
  const resolved = resolveReasoningEffortValue(
    models,
    messageModel.value,
    loadLastEffort(provider) || state.session?.reasoning_effort || ""
  );
  if (resolved) saveLastEffort(provider, resolved);
});

stopButton?.addEventListener("click", () => {
  void stopActiveTurn();
});

transcript.addEventListener("click", (event) => {
  const copyButton = event.target.closest("[data-copy-message]");
  if (copyButton) {
    void copyTextToClipboard(copyButton.dataset.copyMessage || "", copyButton);
    return;
  }

  const forkButton = event.target.closest("[data-fork-from-item]");
  if (forkButton) {
    const threadId = state.viewThreadId || state.session?.active_thread_id || null;
    openForkDialogForThread(threadId, forkButton.dataset.forkFromItem || "");
    return;
  }

  const approvalButton = event.target.closest("[data-approval-decision]");
  if (approvalButton) {
    void submitDecision(
      approvalButton.dataset.approvalDecision,
      approvalButton.dataset.approvalScope || "once"
    );
    return;
  }

  const transcriptGroupToggleButton = event.target.closest("[data-transcript-toggle='group']");
  if (transcriptGroupToggleButton) {
    toggleTranscriptExpandKey(transcriptGroupToggleButton.dataset.expandKey || "");
    return;
  }

  const transcriptToggleButton = event.target.closest("[data-transcript-toggle='entry']");
  if (transcriptToggleButton) {
    void toggleTranscriptEntry(transcriptToggleButton.dataset.itemId);
    return;
  }

  const fileChangeActionButton = event.target.closest("[data-file-change-action]");
  if (fileChangeActionButton) {
    void applyFileChange(
      fileChangeActionButton.dataset.itemId,
      fileChangeActionButton.dataset.fileChangeAction
    );
    return;
  }

  const suggestionButton = event.target.closest("[data-suggestion]");
  if (suggestionButton) {
    messageInput.value = suggestionButton.dataset.suggestion || "";
    messageInput.focus();
    return;
  }

  // Standby "start a task" actions (#9): open the real New session dialog, seeding its
  // initial-prompt field when the starter carries one. This is the actionable path — the
  // composer is disabled with no active thread, so prefilling it (data-suggestion) dead-ends.
  const startSessionAction = event.target.closest("[data-start-session]");
  if (startSessionAction) {
    const seedPrompt = startSessionAction.dataset.startPrompt || "";
    if (seedPrompt) {
      state.localUiStore.getState().setSessionDraftField("initialPrompt", seedPrompt);
      const promptInput = document.getElementById("start-prompt");
      if (promptInput) promptInput.value = seedPrompt;
    }
    document.getElementById("launch-start-session-dialog")?.setAttribute("open", "");
    return;
  }

  const openThreadButton = event.target.closest("[data-open-thread-id]");
  if (openThreadButton) {
    const threadId = openThreadButton.dataset.openThreadId;
    if (threadId) {
      // Was a line-for-line copy of controller.viewThread. Routed through the one
      // implementation so every way of opening a session shares its behaviour —
      // including landing in the tab strip.
      viewThreadById(threadId);
    }
    return;
  }

  const goHomeButton = event.target.closest("[data-go-console-home]");
  if (goHomeButton) {
    void runViewTransition(() => {
      clearThreadRoute();
      if (state.session) {
        renderSession(state.session);
      }
      syncThreadSelection();
    });
    return;
  }

});

// IntersectionObserver-driven prefetch: when the zero-height history sentinel
// (the first child of TranscriptContent) gets within ~600px of the top edge of
// the scroller, we kick off the next older-page fetch. Compared to the old
// `addEventListener("scroll")` path, this (a) starts loading *before* the
// user reaches the top, hiding the network round-trip, and (b) doesn't fire
// dozens of times per second while scrolling. `sync()` is called after each
// renderSession because the sentinel is part of the React tree and may be
// replaced when the active branch swaps.
const transcriptHistoryLoader = attachTranscriptHistoryLoader({
  onLoad: () => {
    // A pinned read-only view paginates through its own pin (the hydration
    // pipeline is keyed to the live thread); everything else takes the normal
    // active-thread path, which no-ops while a pin is showing.
    const pin = state.viewOnlyThread;
    if (pin && state.viewThreadId === pin.threadId) {
      return loadOlderViewOnlyTranscript();
    }
    return controller?.maybeLoadOlderTranscript();
  },
  scrollElement: transcript,
});
renderer.setTranscriptHistorySync(() => transcriptHistoryLoader.sync());

pendingActionBanner?.addEventListener("click", (event) => {
  const approvalButton = event.target.closest("[data-approval-decision]");
  if (approvalButton) {
    void submitDecision(
      approvalButton.dataset.approvalDecision,
      approvalButton.dataset.approvalScope || "once"
    );
    return;
  }

  const openPairingApproval = event.target.closest("[data-open-pairing-approval]");
  if (openPairingApproval) {
    if (pairingApprovalModal && !pairingApprovalModal.open) {
      try {
        pairingApprovalModal.showModal();
      } catch {}
    }
    return;
  }

  const openSecurity = event.target.closest("[data-open-security]");
  if (openSecurity) {
    openSettingsModal("devices");
  }
});

pairedDevicesList.addEventListener("click", (event) => {
  const revokeOthersButton = event.target.closest("[data-revoke-others-except-device-id]");
  if (revokeOthersButton) {
    void revokeOtherDevices(revokeOthersButton.dataset.revokeOthersExceptDeviceId);
    return;
  }

  const revokeButton = event.target.closest("[data-revoke-device-id]");
  if (!revokeButton) {
    return;
  }

  void revokePairedDevice(revokeButton.dataset.revokeDeviceId);
});

pendingPairingsList.addEventListener("click", (event) => {
  const decisionButton = event.target.closest("[data-pairing-id][data-pairing-decision]");
  if (!decisionButton) {
    return;
  }

  void decidePairingRequest(
    decisionButton.dataset.pairingId,
    decisionButton.dataset.pairingDecision
  );
});

void boot();

async function boot() {
  apiTokenInput.value = state.apiToken;
  updateConnectionForm();

  await refreshAuthSession("initial boot");
  if (state.apiToken && state.authRequired && !state.authenticated) {
    await signInWithApiToken(state.apiToken, "stored token migration");
  }
  if (state.authRequired && !state.authenticated) {
    clearStoredApiToken();
    state.apiToken = "";
    apiTokenInput.value = "";
    updateConnectionForm();
    renderAuthRequiredState("Enter RELAY_API_TOKEN to access the local relay.");
    return;
  }

  await loadSession("initial boot");
  await loadThreads("initial boot");
  // A `?thread=` deep link (address bar, restored tab, reload) sets viewThreadId
  // directly, without going through viewThread. Same reconciliation as back/forward:
  // launching straight onto a deleted session must not create a dead tab.
  adoptRoutedThread();
  // Nothing else renders between here and the first snapshot, so refresh the strip.
  renderSessionTabs();
  connectSessionStream();
  scheduleThreadsPoll();
}

async function refreshAuthSession(reason) {
  try {
    const data = await fetchAuthSession();
    applyAuthSessionState(data);
    return data;
  } catch (error) {
    logLine(`Auth session check failed (${reason}): ${error.message}`);
    return null;
  }
}

async function submitAuthSession() {
  if (!state.authRequired) {
    logLine("This relay does not require an API token on the current bind host.");
    return;
  }

  const token = apiTokenInput.value.trim();
  if (token) {
    await signInWithApiToken(token, "manual sign-in");
    return;
  }

  if (!state.authenticated) {
    logLine("Enter RELAY_API_TOKEN to sign in.");
    apiTokenInput.focus();
    return;
  }

  await signOutAuthSession("manual sign-out");
}

async function signInWithApiToken(token, reason) {
  setConnectionFormBusy(true);

  try {
    const data = await createAuthSession(token);
    clearStoredApiToken();
    state.apiToken = "";
    apiTokenInput.value = "";
    applyAuthSessionState(data);
    logLine(`Local relay sign-in succeeded (${reason}).`);
    await resumeAfterAuthChange("sign-in");
  } catch (error) {
    clearStoredApiToken();
    state.apiToken = "";
    logLine(`Local relay sign-in failed: ${error.message}`);
  } finally {
    setConnectionFormBusy(false);
  }
}

async function signOutAuthSession(reason) {
  setConnectionFormBusy(true);

  try {
    const data = await deleteAuthSession();
    clearStoredApiToken();
    state.apiToken = "";
    apiTokenInput.value = "";
    applyAuthSessionState(data);
    logLine(`Local relay sign-out succeeded (${reason}).`);
    await resumeAfterAuthChange("sign-out");
  } catch (error) {
    logLine(`Local relay sign-out failed: ${error.message}`);
  } finally {
    setConnectionFormBusy(false);
  }
}

function applyAuthSessionState(view) {
  state.authRequired = Boolean(view?.auth_required);
  state.authenticated = Boolean(view?.authenticated);
  state.cookieSession = Boolean(view?.cookie_session);
  if (state.authenticated || !state.authRequired) {
    clearStoredApiToken();
    state.apiToken = "";
  }
  updateConnectionForm();
}

function updateConnectionForm() {
  if (!apiTokenLabel || !applyTokenButton) {
    return;
  }

  connectionForm.hidden = !state.authRequired;

  if (!state.authRequired) {
    apiTokenLabel.textContent = "Local Access";
    apiTokenInput.value = "";
    apiTokenInput.disabled = true;
    apiTokenInput.placeholder = "No API token required on this relay";
    applyTokenButton.textContent = "Ready";
    applyTokenButton.disabled = true;
    return;
  }

  apiTokenLabel.textContent = state.cookieSession ? "Local Session" : "API Token";
  apiTokenInput.disabled = false;
  applyTokenButton.disabled = false;

  if (state.authenticated) {
    apiTokenInput.placeholder = "Signed in. Submit an empty field to sign out.";
    applyTokenButton.textContent = "Sign Out";
  } else {
    apiTokenInput.placeholder = "Enter RELAY_API_TOKEN to sign in";
    applyTokenButton.textContent = "Sign In";
  }
}

function setConnectionFormBusy(busy) {
  apiTokenInput.disabled = busy || !state.authRequired;
  applyTokenButton.disabled = busy || !state.authRequired;
}

async function resumeAfterAuthChange(reason) {
  state.streamConnected = false;
  cancelStreamReconnect();
  cancelSessionPoll();
  cancelThreadsPoll();
  if (state.sessionStream) {
    state.sessionStream.close();
    state.sessionStream = null;
  }

  if (state.authRequired && !state.authenticated) {
    renderAuthRequiredState("Enter RELAY_API_TOKEN to access the local relay.");
    return;
  }

  await loadSession(reason);
  await loadThreads(reason);
  connectSessionStream();
}

function handleUnauthorized(message) {
  const alreadySignedOut = state.authRequired && !state.authenticated;
  clearStoredApiToken();
  state.apiToken = "";
  apiTokenInput.value = "";
  state.authenticated = false;
  state.cookieSession = false;
  state.streamConnected = false;
  cancelStreamReconnect();
  cancelSessionPoll();
  cancelThreadsPoll();
  if (state.sessionStream) {
    state.sessionStream.close();
    state.sessionStream = null;
  }
  updateConnectionForm();
  renderAuthRequiredState(message);
  if (!alreadySignedOut) {
    logLine(message);
  }
}

function seedDefaults(session) {
  void refreshProviderCatalogs(session);
  const activeProvider = session.provider || defaultProvider(state.providers);
  const launchProvider = providerInput?.value || activeProvider;
  const launchModels = modelsForProvider(launchProvider, session.available_models || []);

  syncModelSuggestions(
    messageModel,
    session.available_models || [],
    messageModel?.value || session.model,
    true,
    true
  );

  if (!state.defaultsSeeded) {
    if (messageModel) {
      messageModel.value = session.model || defaultModelForProvider(activeProvider);
    }
    state.defaultsSeeded = true;
  }

  // Effort is no longer rendered in the composer (it lives in the settings
  // popover and persists via localStorage). If a stale messageEffort element
  // is still in the DOM, keep it in sync for backwards-compat.
  if (messageEffort) {
    syncEffortSuggestions(
      messageEffort,
      session.available_models || [],
      messageModel?.value || session.model,
      messageEffort.value || session.reasoning_effort,
      session.provider || ""
    );
  }

  syncLaunchSettingsModal(session, launchProvider, launchModels, activeProvider);

  if (!state.selectedCwd && session.current_cwd) {
    setSelectedCwd(session.current_cwd);
  }
}

async function refreshProviderCatalogs(session) {
  try {
    const launchDraft = readLocalUiState(state.localUiStore).sessionDraft || {};
    const liveProviderInput = document.getElementById("provider-input") || providerInput;
    const selectedProvider = launchDraft.provider || liveProviderInput?.value || session.provider;
    if (!state.providers.length) {
      const providersResponse = await apiFetch("/api/providers");
      const providersPayload = await providersResponse.json();
      if (providersResponse.ok && providersPayload.ok) {
        state.providers = normalizeProviderList(providersPayload.data);
        syncProviderSuggestions(liveProviderInput, state.providers, selectedProvider);
      }
    }
    await Promise.all(state.providers.map(async (provider) => {
      if (state.providerModels[provider]?.length) return;
      const response = await apiFetch(`/api/providers/${encodeURIComponent(provider)}/models`);
      const payload = await response.json();
      if (response.ok && payload.ok) {
        state.providerModels[provider] = payload.data || [];
      }
    }));
    const provider = selectedProvider || defaultProvider(state.providers);
    const liveModelInput = document.getElementById("model-input") || modelInput;
    const liveStartEffortInput = document.getElementById("start-effort") || startEffortInput;
    syncLaunchSettingLabels(provider);
    syncModelSuggestions(
      liveModelInput,
      modelsForProvider(provider, session.available_models || []),
      liveModelInput?.value || defaultModelForProvider(provider)
    );
    syncEffortSuggestions(
      liveStartEffortInput,
      modelsForProvider(provider, session.available_models || []),
      liveModelInput?.value || defaultModelForProvider(provider),
      liveStartEffortInput?.value || "",
      provider
    );
  } catch (error) {
    logLine(`Provider model refresh failed: ${error.message}`);
  }
}

function syncModelSuggestions(
  select,
  models,
  selectedModel,
  allowForeign = false,
  replaceExisting = false
) {
  if (!select) {
    return;
  }

  // Drop hidden models + keep the current selection representable (snapping a
  // stale foreign value to the provider default when !allowForeign). Shared with
  // the composer/dialog pickers via buildModelOptions, so the filtering rule has
  // a single tested definition.
  const { options, value: currentValue } = buildModelSelectOptions(
    models,
    selectedModel || select.value || "",
    { allowForeign }
  );

  const renderedOptions = options.map((model) => ({
    label: model.display_name || model.model,
    value: model.model,
  }));
  if (replaceExisting) {
    replaceSelectOptions(select, renderedOptions, currentValue);
  } else {
    renderSelectOptions(select, renderedOptions, currentValue);
  }
}

function syncComposerModelForRenderedSession(session) {
  if (!messageModel || !session?.active_thread_id) {
    return;
  }

  const models = session.available_models || [];
  const currentModel = models.some((model) => model.model === messageModel.value)
    ? messageModel.value
    : session.model || messageModel.value;

  // The rendered session may be a client-local view-only projection for a
  // provider different from the relay's live session. Use that projection's
  // catalog, reject a foreign current value in view-only mode, and reassert the
  // projection after every live snapshot. Preserve a manual selection whenever
  // it still belongs to the rendered provider's catalog.
  syncModelSuggestions(
    messageModel,
    models,
    currentModel,
    !session.view_only,
    true
  );
}

function syncProviderSuggestions(select, providers, selectedProvider) {
  if (!select) {
    return;
  }
  const options = providerOptions(providers);
  renderSelectOptions(select, options, selectedProvider || defaultProvider(providers));
}

function modelsForProvider(provider, fallbackModels = []) {
  const normalized = provider || "codex";
  return state.providerModels[normalized]?.length
    ? state.providerModels[normalized]
    : fallbackModels;
}

function handleLaunchFieldInput(id, value) {
  const fieldById = {
    "approval-policy-input": "approvalPolicy",
    "cwd-input": "cwd",
    "model-input": "model",
    "provider-input": "provider",
    "sandbox-input": "sandbox",
    "start-effort": "effort",
    "start-prompt": "initialPrompt",
  };
  const field = fieldById[id];
  if (!field) {
    return;
  }
  state.localUiStore.getState().setSessionDraftField(field, value);
  const draftProvider = readLocalUiState(state.localUiStore).sessionDraft?.provider || "codex";
  if (field === "effort") saveLastEffort(draftProvider, value);
  if (field === "approvalPolicy") saveLastApprovalPolicy(draftProvider, value);
  if (field !== "provider") {
    return;
  }

  const session = state.session || {};
  void refreshProviderCatalogs(session);
  const nextModels = modelsForProvider(value, session.available_models || []);
  const liveModelInput = document.getElementById("model-input") || modelInput;
  const liveStartEffortInput = document.getElementById("start-effort") || startEffortInput;
  const liveApprovalInput = document.getElementById("approval-policy-input") || approvalPolicyInput;
  const nextModel = defaultModelForProvider(value);
  const storedEffort = loadLastEffort(value);
  const storedApproval = loadLastApprovalPolicy(value);
  if (storedApproval) {
    state.localUiStore.getState().setSessionDraftField("approvalPolicy", storedApproval);
    if (liveApprovalInput) liveApprovalInput.value = storedApproval;
  }
  if (storedEffort) {
    state.localUiStore.getState().setSessionDraftField("effort", storedEffort);
  }
  syncLaunchSettingLabels(value);
  syncModelSuggestions(liveModelInput, nextModels, nextModel);
  syncEffortSuggestions(
    liveStartEffortInput,
    nextModels,
    nextModel,
    storedEffort || liveStartEffortInput?.value || "",
    value
  );
}

function syncLaunchSettingsModal(session, provider, launchModels, activeProvider) {
  const prov = provider || activeProvider || "codex";
  const models = launchModels?.length ? launchModels : (session?.available_models || []);
  const settings = providerSettings(prov);
  const launchDraft = readLocalUiState(state.localUiStore).sessionDraft || {};
  const fields = {
    approvalPolicy: launchDraft.approvalPolicy || session?.approval_policy || "untrusted",
    cwd: session?.current_cwd || state.selectedCwd || "",
    effort: launchDraft.effort || session?.reasoning_effort || "medium",
    initialPrompt: launchDraft.initialPrompt || "",
    model: launchDraft.model || session?.model || defaultModelForProvider(prov),
    provider: prov,
    sandbox: launchDraft.sandbox || session?.sandbox || "workspace-write",
  };
  const liveCwdInput = document.getElementById("cwd-input") || cwdInput;
  const liveStartPromptInput = document.getElementById("start-prompt") || startPromptInput;
  const liveProviderInput = document.getElementById("provider-input") || providerInput;
  const liveModelInput = document.getElementById("model-input") || modelInput;
  const liveApprovalPolicyInput = document.getElementById("approval-policy-input") || approvalPolicyInput;
  const liveSandboxInput = document.getElementById("sandbox-input") || sandboxInput;
  const liveStartEffortInput = document.getElementById("start-effort") || startEffortInput;

  if (liveCwdInput && !liveCwdInput.value) liveCwdInput.value = fields.cwd;
  if (liveStartPromptInput) liveStartPromptInput.value = fields.initialPrompt;
  syncProviderSuggestions(liveProviderInput, state.providers, fields.provider);
  syncLaunchSettingLabels(fields.provider);
  syncModelSuggestions(liveModelInput, models, fields.model);
  renderSelectOptions(liveApprovalPolicyInput, settings.approvalOptions, fields.approvalPolicy);
  renderSelectOptions(liveSandboxInput, sandboxOptions(), fields.sandbox);
  syncEffortSuggestions(liveStartEffortInput, models, fields.model, fields.effort, fields.provider);
}

function syncLaunchSettingLabels(provider) {
  const settings = providerSettings(provider);
  if (modelInputLabel) {
    modelInputLabel.textContent = settings.modelLabel;
  }
  if (startEffortLabel) {
    startEffortLabel.textContent = settings.effortLabel;
  }
  renderSelectOptions(
    approvalPolicyInput,
    settings.approvalOptions,
    approvalPolicyInput?.value || "untrusted"
  );
  renderSelectOptions(
    sandboxInput,
    sandboxOptions(),
    sandboxInput?.value || "workspace-write"
  );
}

async function selectLaunchProvider(provider) {
  const selected = provider || defaultProvider(state.providers);
  syncLaunchSettingLabels(selected);
  if (!state.providerModels[selected]?.length) {
    await refreshProviderCatalogs(state.session || { provider: selected, available_models: [] });
  }
  const models = modelsForProvider(selected, state.session?.available_models || []);
  const model = models.find((option) => option.is_default)?.model
    || models[0]?.model
    || defaultModelForProvider(selected);
  syncModelSuggestions(modelInput, models, model);
  syncEffortSuggestions(startEffortInput, models, model, startEffortInput?.value || "", selected);
}

function syncEffortSuggestions(select, models, selectedModel, selectedEffort, provider = "") {
  if (!select) {
    return;
  }

  const resolvedEffort = resolveReasoningEffortValue(models, selectedModel, selectedEffort);
  renderSelectOptions(
    select,
    buildReasoningEffortOptions(models, selectedModel, provider),
    resolvedEffort
  );
}

function setSelectedCwd(cwd) {
  state.threadListStore.getState().setSelectedCwd(cwd);
  state.selectedCwd = readThreadListUi(state.threadListStore).selectedCwd;
  cwdInput.value = state.selectedCwd;
}

function resolveActiveThread(threadId) {
  if (!threadId) {
    return null;
  }

  return state.threads.find((thread) => thread.id === threadId) || null;
}

function renderForkSessionDialog() {
  if (!forkSessionDialogRoot) {
    return;
  }
  if (!forkSessionRoot) {
    forkSessionRoot = createRoot(forkSessionDialogRoot);
  }
  const dialogState = state.forkDialog;
  if (!dialogState.open || !dialogState.sourceThread) {
    flushSync(() => forkSessionRoot.render(null));
    return;
  }

  const fields = dialogState.fields || defaultForkFields(dialogState.sourceThread);
  const provider = fields.provider || defaultProvider(state.providers);
  const models = modelsForProvider(provider, state.session?.available_models || []);
  const settings = providerSettings(provider);
  const selectedModel = fields.model || defaultModelForProvider(provider);
  const dialog = React.createElement(ForkSessionDialog, {
    id: "local-fork-session-dialog",
    sourceThread: dialogState.sourceThread,
    fields,
    pending: dialogState.pending,
    error: dialogState.error || "",
    providerOptions: providerOptions(state.providers),
    models: models.length
      ? models
      : [{ model: selectedModel, display_name: selectedModel }],
    modelsStatus: models.length ? "ready" : "loading",
    approvalOptions: settings.approvalOptions,
    effortOptions: buildReasoningEffortOptions(models, selectedModel, provider),
    forkCapabilities: state.session?.provider_fork_capabilities || [],
    onFieldChange: handleForkDialogFieldChange,
    onFork: submitForkDialog,
    onRequestClose: closeForkDialog,
  });

  flushSync(() => forkSessionRoot.render(dialog));
  const element = document.getElementById("local-fork-session-dialog");
  if (element && !element.open) {
    element.showModal();
  }
}

function threadIsBusy(thread) {
  return threadIsBusyForFork(thread, state.session);
}

function openForkDialogForThread(threadId, upToItemId = "") {
  // Falls back to the viewed session snapshot: on a deep link the transcript
  // (and its fork buttons) render before the sidebar thread list exists, and
  // the list is paged so an older thread may never appear in it.
  const thread = resolveForkSourceThread({
    threadId,
    threads: state.threads,
    session: state.session,
    viewedThread: state.viewOnlyThread,
  });
  if (!thread) {
    logLine(`Cannot fork unknown session ${threadId}`);
    return;
  }
  // A thread mid-turn is rejected by the relay (the transcript is still being
  // written), so refuse here instead of letting the user fill in the whole
  // dialog first. Background threads count — they have their own live runtime.
  if (threadIsBusy(thread)) {
    logLine("Cannot fork a session while a turn is in progress.");
    return;
  }
  const models = modelsForProvider(thread.provider, state.session?.available_models || []);
  state.forkDialog = {
    open: true,
    pending: false,
    sourceThread: thread,
    fields: {
      ...defaultForkFields({ thread, models, session: state.session }),
      cwd: thread.cwd || state.session?.current_cwd || state.selectedCwd || "",
      upToItemId: upToItemId || "",
      // Branching at the tip drops nothing, so the relay collapses it to a
      // whole-thread fork — which keeps a tip-only native fork native.
      // The entries ACTUALLY on screen: while viewing a saved thread,
      // `state.session` is still the live session (same trap as
      // resolveForkSourceThread), so its transcript would answer for the
      // wrong thread.
      forkPointIsTip: forkPointIsTranscriptTip(
        state.viewOnlyThread?.threadId === threadId
          ? state.viewOnlyThread.entries || []
          : state.session?.transcript || [],
        upToItemId || ""
      ),
    },
  };
  closeThreadContextMenu();
  renderForkSessionDialog();
  // The source thread's catalog is usually not the active session's, so fetch
  // it before the user can submit a model that belongs to another provider.
  void ensureForkProviderModels(thread.provider);
}

function closeForkDialog() {
  state.forkDialog = {
    open: false,
    pending: false,
    sourceThread: null,
    fields: null,
    error: "",
  };
  renderForkSessionDialog();
}

// Fetch a provider's model catalog so the fork dialog can offer that
// provider's own models. Without this a cross-provider fork sits on
// "Loading models..." forever and can submit a foreign model id.
async function ensureForkProviderModels(provider) {
  if (!provider) return;
  if (modelsForProvider(provider, state.session?.available_models || []).length) return;
  try {
    await refreshProviderCatalogs(
      state.session || { provider, available_models: [] }
    );
  } catch (error) {
    logLine(`Could not load ${providerLabel(provider) || provider} models: ${error.message}`);
  }
  renderForkSessionDialog();
}

function handleForkDialogFieldChange(field, value) {
  const current = state.forkDialog.fields;
  let next = { ...current, [field]: value };
  if (field === "provider") {
    const models = modelsForProvider(value, state.session?.available_models || []);
    next = applyForkProviderChange(next, value, models);
    void ensureForkProviderModels(value);
  }
  state.forkDialog = { ...state.forkDialog, fields: next, error: "" };
  renderForkSessionDialog();
}

// `submittedFields` are the dialog's NORMALIZED fields — the values actually on
// screen. Submitting `dialogState.fields` instead would send the raw state,
// which after a provider change can still hold the withdrawn empty "inherit"
// value: the user sees a concrete model and the relay resolves its own.
async function submitForkDialog(submittedFields = null) {
  const dialogState = state.forkDialog;
  if (!dialogState.sourceThread?.id || dialogState.pending) {
    return;
  }
  state.forkDialog = { ...dialogState, pending: true };
  renderForkSessionDialog();
  const result = await forkSession({
    ...(submittedFields || dialogState.fields),
    sourceThreadId: dialogState.sourceThread.id,
  });
  if (result?.ok) {
    closeForkDialog();
    return;
  }
  // Surface the failure IN the dialog. Reporting only through logLine left the
  // button silently re-enabling with no visible reason, so users retried.
  state.forkDialog = {
    ...state.forkDialog,
    pending: false,
    error: result?.error || "Failed to fork session.",
  };
  renderForkSessionDialog();
}

function openThreadContextMenu(threadId, clientX, clientY) {
  if (!threadContextMenu || !archiveThreadButton || !deleteThreadButton || !threadId) {
    return;
  }

  state.threadListStore.getState().openContextMenu(threadId, clientX, clientY);
  const isActive = state.session?.active_thread_id === threadId;
  const isRunningActiveSession =
    isActive && Boolean(state.session?.active_turn_id);
  if (forkThreadButton) {
    // Background threads can be mid-turn too, and the relay rejects those as
    // well — gate on the same rule the server uses, not just "is active".
    const contextThread =
      resolveActiveThread(threadId)
      || state.threads.find((entry) => entry.id === threadId)
      || null;
    const forkBlocked = threadIsBusy(contextThread);
    forkThreadButton.disabled = forkBlocked;
    forkThreadButton.textContent = forkBlocked
      ? "Running session cannot be forked"
      : "Fork session";
  }
  archiveThreadButton.disabled = isRunningActiveSession;
  archiveThreadButton.textContent = isRunningActiveSession
    ? "Running session cannot be archived"
    : "Archive session";
  deleteThreadButton.disabled = isRunningActiveSession;
  deleteThreadButton.textContent = isRunningActiveSession
    ? "Running session cannot be deleted"
    : "Delete permanently";
  // Per-session Project assignment — rebuilt from the current Projects payload each
  // open so the marked "current" project and the list stay fresh.
  populateThreadProjectActions(threadId);

  threadContextMenu.hidden = false;
  const left = Math.max(12, Math.min(clientX, window.innerWidth - 220));
  const top = Math.max(12, Math.min(clientY, window.innerHeight - 64));
  threadContextMenu.style.left = `${left}px`;
  threadContextMenu.style.top = `${top}px`;

  // Re-render the thread list so the `is-context-target` highlight lands via
  // React (driven by the store's context-menu target we just set). Opening the
  // menu is otherwise a store-only mutation with no subscriber, so without this
  // the class would only appear on the NEXT incidental render (an SSE/activity
  // tick or the 12s poll). Painting it imperatively here instead is fragile: any
  // React re-render in that window recomputes the row className from frozen props
  // (contextMenuThreadId=null) and strips it — the flake the delete-thread e2e hit.
  renderThreads();
}

// `rerender` re-renders the thread list so React drops the `is-context-target`
// highlight (mirrors openThreadContextMenu). Callers that are already inside
// renderThreads() — or that render their own thread-list content immediately
// after — pass `{ rerender: false }` to avoid a redundant/re-entrant render.
function closeThreadContextMenu({ rerender = true } = {}) {
  // Only worth a re-render if a menu was actually open — Escape/blur/resize call
  // this unconditionally, and we don't want to re-render the thread list on every
  // one of those when there's no highlight to clear.
  const wasOpen = readThreadListContextMenu(state.threadListStore).threadId != null;
  state.threadListStore.getState().closeContextMenu();
  if (threadContextMenu) {
    threadContextMenu.hidden = true;
  }
  if (forkThreadButton) {
    forkThreadButton.disabled = false;
    forkThreadButton.textContent = "Fork session";
  }
  if (archiveThreadButton) {
    archiveThreadButton.disabled = false;
    archiveThreadButton.textContent = "Archive session";
  }
  if (deleteThreadButton) {
    deleteThreadButton.disabled = false;
    deleteThreadButton.textContent = "Delete permanently";
  }
  if (rerender && wasOpen) {
    renderThreads();
  }
}

async function reviewerThreadsForDestructiveAction() {
  if (reviewsCache.hasData()) {
    return reviewsCache.current().reviewer_threads || [];
  }
  try {
    const reviews = await getReviews(apiFetch);
    return reviews?.reviewer_threads || [];
  } catch (_error) {
    // The backend still performs the authoritative reviewer cleanup. If this
    // read fails, continue without a client-side count prompt.
    return [];
  }
}

async function archiveThreadFromContextMenu() {
  const threadId = readThreadListContextMenu(state.threadListStore).threadId;
  closeThreadContextMenu();

  if (!threadId) {
    return;
  }

  const thread = resolveActiveThread(threadId) || state.threads.find((entry) => entry.id === threadId);
  const title = thread?.name || thread?.preview || shortId(threadId);
  if (!window.confirm(`Archive "${title}" from local history?`)) {
    return;
  }

  // If this thread is the parent of hidden reviewer thread(s), ask what to do with
  // them. Reviewer threads have no archived state of their own, so the choice is
  // delete vs keep-as-normal — same prompt as permanent delete. Default (OK) deletes
  // them; Cancel keeps them as normal threads.
  const reviewerCount = countReviewerThreadsForParent(
    await reviewerThreadsForDestructiveAction(),
    threadId
  );
  let deleteReviewers;
  if (reviewerCount > 0) {
    deleteReviewers = window.confirm(
      `This conversation has ${reviewerCount} reviewer session${reviewerCount === 1 ? "" : "s"}.\n\n` +
        "OK: delete the reviewer session(s) too.\n" +
        "Cancel: keep them as normal sessions (they'll appear in your session list)."
    );
  }

  try {
    const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/archive`, {
      method: "POST",
      ...reviewerChoiceRequestInit(deleteReviewers),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to archive session");
    }

    state.threads = state.threads.filter((entry) => entry.id !== threadId);
    // A tab pointing at a deleted session is dead — drop it before re-rendering.
    state.removedThreadIds.add(threadId);
    rememberRemovedThreadId(threadId);
    state.tabWorkspaceStore.getState().closeThreadEverywhere(threadId);
    // Archiving the session you were VIEWING has to move the route as well, or the
    // main area keeps rendering a session the strip no longer has a tab for. The
    // permanent-delete path below does this via its own fallback logic.
    if (threadId === state.viewThreadId) {
      syncRouteToCurrentWorkspace();
    }
    state.threadGroups = buildNavigationThreadGroups(state.threads);
    renderThreads();
    await loadSession("post-archive refresh");
    await loadThreads("post-archive refresh");
    logLine(payload.data?.message || `Archived local session ${shortId(threadId)}.`);
  } catch (error) {
    logLine(`Failed to archive local session: ${error.message}`);
  }
}

async function deleteThreadFromContextMenu() {
  const threadId = readThreadListContextMenu(state.threadListStore).threadId;
  closeThreadContextMenu();

  if (!threadId) {
    return;
  }

  const thread = resolveActiveThread(threadId) || state.threads.find((entry) => entry.id === threadId);
  const shouldPreserveConversation = state.viewThreadId === threadId;
  const fallbackThreadId = shouldPreserveConversation ? findAdjacentThreadId(threadId) : null;
  const title = thread?.name || thread?.preview || shortId(threadId);
  // Name the thread's own provider — the old ternary mislabeled every
  // non-Claude provider (incl. future ones) as "Codex".
  const providerName = providerLabel(thread?.provider) || "agent";
  const confirmed = window.confirm(
    `Permanently delete "${title}" from local ${providerName} storage?\n\nThis removes the local session file and related local index/state entries. This cannot be undone.`
  );
  if (!confirmed) {
    return;
  }

  // If this thread is the parent of hidden reviewer thread(s), ask what to do with
  // them. Default (OK) deletes them too; Cancel keeps them as normal threads.
  const reviewerCount = countReviewerThreadsForParent(
    await reviewerThreadsForDestructiveAction(),
    threadId
  );
  let deleteReviewers;
  if (reviewerCount > 0) {
    deleteReviewers = window.confirm(
      `This conversation has ${reviewerCount} reviewer session${reviewerCount === 1 ? "" : "s"}.\n\n` +
        "OK: delete the reviewer session(s) too.\n" +
        "Cancel: keep them as normal sessions (they'll appear in your session list)."
    );
  }

  try {
    const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/delete`, {
      method: "POST",
      ...reviewerChoiceRequestInit(deleteReviewers),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to permanently delete session");
    }

    state.threads = state.threads.filter((entry) => entry.id !== threadId);
    // A tab pointing at a deleted session is dead — drop it before re-rendering.
    state.removedThreadIds.add(threadId);
    rememberRemovedThreadId(threadId);
    state.tabWorkspaceStore.getState().closeThreadEverywhere(threadId);
    state.threadGroups = buildNavigationThreadGroups(state.threads);
    renderThreads();
    await loadThreads("post-delete refresh");
    if (shouldPreserveConversation) {
      const canResumeFallback =
        fallbackThreadId && state.threads.some((entry) => entry.id === fallbackThreadId);
      if (canResumeFallback) {
        setThreadRoute(fallbackThreadId, { replace: true });
        await loadViewOnlyTranscript(fallbackThreadId);
      } else {
        clearThreadRoute({ replace: true });
        await loadSession("post-delete refresh");
      }
    } else {
      await loadSession("post-delete refresh");
    }
    logLine(payload.data?.message || `Deleted local session ${shortId(threadId)} permanently.`);
  } catch (error) {
    logLine(`Failed to permanently delete local session: ${error.message}`);
  }
}

function findAdjacentThreadId(threadId) {
  const index = state.threads.findIndex((entry) => entry.id === threadId);
  if (index === -1) {
    return state.threads.find((entry) => entry.id !== threadId)?.id || null;
  }

  return (
    state.threads[index + 1]?.id ||
    state.threads[index - 1]?.id ||
    state.threads.find((entry) => entry.id !== threadId)?.id ||
    null
  );
}

function metaChip(label, value) {
  return `
    <span class="meta-chip">
      <strong>${escapeHtml(label)}:</strong>
      <span>${escapeHtml(value)}</span>
    </span>
  `;
}

function overviewBadge(label, value) {
  return `
    <span class="overview-badge">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(value)}</span>
    </span>
  `;
}

function sessionStatusLabel(session, approval) {
  if (approval) {
    return "Approval required";
  }

  if (!session?.provider_connected) {
    return "Offline";
  }

  if (!session?.active_thread_id) {
    return "Standby";
  }

  return "Live";
}

function securityModeLabel(session) {
  if (session?.security_mode === "managed") {
    return "Managed policy";
  }
  return "Private";
}

function contentVisibilityLabel(session) {
  if (session?.broker_can_read_content) {
    return session.audit_enabled ? "Broker-readable with audit" : "Broker-readable";
  }
  return session?.e2ee_enabled ? "End-to-end encrypted" : "Broker cannot read content";
}

function brokerStatusLabel(session) {
  if (!session?.broker_channel_id) {
    return "Disabled";
  }

  const state = session.broker_connected ? "Connected" : "Offline";
  const channel = shortId(session.broker_channel_id);
  return session.broker_peer_id
    ? `${state} · ${channel} · ${shortId(session.broker_peer_id)}`
    : `${state} · ${channel}`;
}

function pairedDeviceCountLabel(session) {
  const count = approvedDeviceCount(session);
  return count === 0 ? "None" : `${count} paired`;
}

function approvedDeviceCount(session) {
  if (Array.isArray(session?.paired_devices)) {
    return session.paired_devices.length;
  }

  if (!Array.isArray(session?.device_records)) {
    return 0;
  }

  return session.device_records.filter((record) => record.lifecycle_state === "approved").length;
}

function formatTimestamp(seconds) {
  if (!seconds) {
    return "unknown";
  }

  return new Date(seconds * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelativeTime(seconds) {
  if (!seconds) {
    return "now";
  }

  const diffSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(seconds));
  if (diffSeconds < 60) {
    return "now";
  }
  if (diffSeconds < 3600) {
    return `${Math.floor(diffSeconds / 60)}m`;
  }
  if (diffSeconds < 86400) {
    return `${Math.floor(diffSeconds / 3600)}h`;
  }
  if (diffSeconds < 604800) {
    return `${Math.floor(diffSeconds / 86400)}d`;
  }
  if (diffSeconds < 2592000) {
    return `${Math.floor(diffSeconds / 604800)}w`;
  }
  if (diffSeconds < 31536000) {
    return `${Math.floor(diffSeconds / 2592000)}mo`;
  }
  return `${Math.floor(diffSeconds / 31536000)}y`;
}

function humanizeLabel(value) {
  return String(value)
    .replaceAll(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function classifyAuditEntry(entry) {
  const text = `${entry?.kind || ""} ${entry?.message || ""}`.toLowerCase();

  if (
    text.includes("failed") ||
    text.includes("denied") ||
    text.includes("rejected") ||
    text.includes("revoked") ||
    text.includes("offline") ||
    text.includes("disconnected")
  ) {
    return "alert";
  }

  if (
    text.includes("approved") ||
    text.includes("accepted") ||
    text.includes("started") ||
    text.includes("resumed") ||
    text.includes("connected") ||
    text.includes("saved")
  ) {
    return "ready";
  }

  return "neutral";
}

function shouldShowAuditEntry(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  const message = String(entry?.message || "");

  if (kind !== "codex") {
    return true;
  }

  return /approval|pair|revoke|connected|disconnected|take over|control|broker|session/i.test(message);
}

function isCurrentDeviceActiveController(session) {
  if (!session?.active_thread_id || !session.active_controller_device_id) {
    return false;
  }

  return session.active_controller_device_id === state.deviceId;
}

function canCurrentDeviceWrite(session) {
  if (!session?.active_thread_id) {
    return false;
  }

  return !session.active_controller_device_id || session.active_controller_device_id === state.deviceId;
}

function sessionControllerState(session) {
  if (!session?.active_thread_id) {
    return "none";
  }

  if (!session.active_controller_device_id) {
    return "unclaimed";
  }

  return session.active_controller_device_id === state.deviceId ? "this_device" : "other_device";
}

function controllerLabel(deviceId) {
  if (!deviceId) {
    return "Unclaimed";
  }

  if (deviceId === state.deviceId) {
    return `This device (${shortId(deviceId)})`;
  }

  return shortId(deviceId);
}

function controllerStateLabel(session) {
  if (session?.view_only) {
    return "View only";
  }
  if (session?.active_thread_id && !session.active_turn_id) {
    return "Available";
  }
  switch (sessionControllerState(session)) {
    case "this_device":
      return "This device";
    case "other_device":
      return controllerLabel(session.active_controller_device_id);
    case "unclaimed":
      return "Unclaimed";
    default:
      return "None";
  }
}

function readThreadIdFromUrl() {
  const url = new URL(window.location.href);
  return url.searchParams.get("thread") || null;
}

function setThreadRoute(threadId, options = {}) {
  const nextThreadId = threadId || null;
  const threadChanged = state.viewThreadId !== nextThreadId;
  const url = new URL(window.location.href);
  if (threadId) {
    url.searchParams.set("thread", threadId);
  } else {
    url.searchParams.delete("thread");
  }

  const next = url.pathname + url.search + url.hash;
  if (options.replace) {
    window.history.replaceState({}, "", next);
  } else {
    window.history.pushState({}, "", next);
  }
  state.viewThreadId = nextThreadId;
  // The single choke point for "which session am I viewing", so it's also the right
  // place to guarantee that session has a tab — covering starting a session, a
  // fallback route after a delete, and anything else that navigates without going
  // through viewThread. Clearing the route (null) opens nothing.
  openSessionTab(nextThreadId);
  if (threadChanged) {
    clearComposerImageAttachments();
  }
}

function clearThreadRoute(options = {}) {
  setThreadRoute(null, options);
}

function isViewingConversation(session) {
  return Boolean(session?.active_thread_id && state.viewThreadId === session.active_thread_id);
}

function workspaceBasename(cwd) {
  if (!cwd) {
    return "workspace";
  }

  const trimmed = String(cwd).replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || trimmed || "workspace";
}

function shortId(value) {
  return value ? value.slice(0, 8) : "unknown";
}

function loadOrCreateDeviceId() {
  const existing = window.localStorage.getItem(DEVICE_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const generated = window.crypto?.randomUUID?.()
    ? window.crypto.randomUUID()
    : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(DEVICE_STORAGE_KEY, generated);
  return generated;
}

function loadApiToken() {
  return window.localStorage.getItem(API_TOKEN_STORAGE_KEY)?.trim() || "";
}

function clearStoredApiToken() {
  window.localStorage.removeItem(API_TOKEN_STORAGE_KEY);
}

function logLine(message) {
  state.clientLogLines = [{ at: Date.now(), text: message }, ...state.clientLogLines].slice(0, 400);
  renderClientLog();
}

// Refresh the relay's server logs from a session snapshot. Replaces (rather than
// appends) so repeated snapshots don't duplicate, and re-renders the merged view
// WITHOUT discarding client-originated lines (e.g. "Prompt failed: ...").
function ingestRelayLogs(entries) {
  state.relayLogLines = mapRelayLogEntries(entries);
  renderClientLog();
}

// Merge client + server log entries into the single #client-log surface, newest
// first. Server-log refreshes and client status lines previously clobbered each
// other (last writer won); merging keeps both visible. The merge/cap logic lives
// in client-log-merge.js (unit-tested); only the locale-dependent timestamp
// formatting stays here.
function renderClientLog() {
  const combined = mergeLogEntries(state.clientLogLines, state.relayLogLines).map(
    (entry) => `${new Date(entry.at).toLocaleTimeString()}  ${entry.text}`
  );
  renderClientLogLines(combined);
}

function renderClientLogLines(lines) {
  if (!clientLogRoot) {
    return;
  }

  if (clientLogRootElement !== clientLogRoot) {
    clientLogRootHandle?.unmount();
    clientLogRootHandle = createRoot(clientLogRoot);
    clientLogRootElement = clientLogRoot;
  }

  flushSync(() => {
    clientLogRootHandle.render(React.createElement(ClientLog, { lines }));
  });
}

// ── Session tabs ────────────────────────────────────────────────────────────
// The strip lives in the static shell, so like #client-log-root it needs its own
// React sub-root to be data-driven. Tabs are scoped to the active project; with no
// project selected they fall back to a shared bucket so Sessions mode keeps tabs.
//
// Focusing a tab goes through `viewThread`, the view-only path. It must NOT call
// resume_session, which moves the relay's single active thread for EVERY connected
// client — a tab is a per-client view, not a claim on the relay.
let sessionTabsRootHandle = null;
let sessionTabsRootElement = null;

function currentTabProjectId() {
  // The bucket is a function of BOTH the view mode and the selected project.
  // Reading `activeProjectId` alone was wrong twice over: switching back to Sessions
  // leaves the last project set (so Sessions shared that project's tabs), and
  // Projects mode before any project is selected has no id at all (so it shared
  // Sessions'). Sessions therefore gets an explicit key of its own.
  const viewMode = state.threadListStore.getState().viewMode;
  if (viewMode !== "projects") {
    return SESSIONS_KEY;
  }
  return readActiveProjectId(state.threadListStore) || NO_PROJECT_KEY;
}

function resolveTabThread(threadId) {
  const thread = (state.threads || []).find((entry) => entry.id === threadId);
  if (!thread) {
    // A tab can outlive its thread (deleted elsewhere, or a stale stored
    // workspace); label it rather than rendering a blank tab.
    return { title: shortId(threadId), tooltip: threadId };
  }
  return {
    title: thread.name || thread.preview || shortId(thread.id),
    tooltip: thread.cwd || thread.name || thread.id,
  };
}

function renderSessionTabs() {
  const mount = document.getElementById("session-tab-strip-mount");
  if (!mount) {
    return;
  }

  if (sessionTabsRootElement !== mount) {
    sessionTabsRootHandle?.unmount();
    sessionTabsRootHandle = createRoot(mount);
    sessionTabsRootElement = mount;
  }

  const projectId = currentTabProjectId();
  const tabs = state.tabWorkspaceStore.getState();
  // Render-only: opening tabs is never a side effect of rendering. Starting a
  // session already routes through setThreadRoute (local/session/lifecycle.js), so
  // the strip needs no "adopt the active thread" fallback — and having one was
  // actively wrong. It fired whenever the route was empty, which is exactly what
  // closing the last tab and entering a project overview both do, so it resurrected
  // the tab the user just closed and stamped the global active thread into every
  // project workspace visited.
  const workspace = tabs.ensureWorkspace(projectId);
  const items = buildSessionTabItems({
    workspace,
    layoutThreadIds,
    resolveThread: resolveTabThread,
    threadActivity: buildThreadActivityMap(state.session),
    threadAttention: threadAttention.snapshotMap(),
    threadReviewing: buildReviewingThreadSet(state.session, reviewsCache.current()),
  });

  sessionTabsRootHandle.render(
    React.createElement(SessionTabStrip, {
      items,
      // The highlight means "this session is on screen", and the ONLY thing that puts
      // a session on screen is the view route: with no `?thread=` the renderer shows
      // the console home or a project overview, not the active conversation — home
      // even offers an explicit "Open live conversation" button (render-session.js).
      //
      // So no fallbacks here. Falling back to `workspace.focusedTabId` let a tab claim
      // focus while the main area showed something else; falling back to
      // `active_thread_id` did the same on Home and in a project overview.
      focusedTabId: items.find((item) => item.threadId === state.viewThreadId)?.tabId || null,
      // NOTE on the missing trailing renderSessionTabs() in the navigating paths:
      // viewThreadById defers its route update into runViewTransition. Re-rendering
      // this React root synchronously afterwards makes the browser skip that pending
      // transition, and its callback — which is what actually writes the route —
      // never runs. The tab would move but the URL and viewThreadId would not, so
      // the next close saw a stale "viewed" thread. viewThreadById already refreshes
      // the strip through openSessionTab, so navigation owns the re-render.
      onFocus(tabId) {
        const item = items.find((entry) => entry.tabId === tabId);
        tabs.focusTabId(projectId, tabId);
        if (item?.threadId) {
          viewThreadById(item.threadId);
        } else {
          renderSessionTabs();
        }
      },
      onClose(tabId) {
        const item = items.find((entry) => entry.tabId === tabId);
        const next = tabs.closeTabId(projectId, tabId);
        // Closing a tab you weren't viewing changes nothing about the transcript.
        if (item?.threadId !== state.viewThreadId) {
          renderSessionTabs();
          return;
        }

        // Closing the tab you WERE viewing has to move the transcript too, onto the
        // neighbour the model picked (or the console home when nothing is left).
        const nextThreadId = next.focusedTabId
          ? layoutThreadIds(next.tabs.find((tab) => tab.id === next.focusedTabId)?.layout)[0]
          : null;
        if (nextThreadId) {
          viewThreadById(nextThreadId);
          return;
        }
        clearThreadRoute();
        if (state.session) {
          renderSession(state.session);
        }
        renderSessionTabs();
      },
      onTogglePin(tabId, pinned) {
        tabs.setPinned(projectId, tabId, pinned);
        renderSessionTabs();
      },
      onMove(tabId, toIndex) {
        tabs.moveTabId(projectId, tabId, toIndex);
        renderSessionTabs();
      },
      emptyMessage: "No open sessions. Pick one from the sidebar.",
    })
  );
}

/**
 * View-only navigation: update the URL/viewThreadId WITHOUT calling the backend
 * resume_session, which is mutating (it moves the relay's single active thread for
 * EVERY connected client). Any non-active thread renders from the client-local pin;
 * an idle viewed thread can be sent to directly.
 *
 * Module-level so every entry point shares it — the sidebar row handler and the tab
 * strip previously each carried their own copy of this body.
 */
function viewThreadById(threadId, { transition = true, replace = false } = {}) {
  // Viewing a session is what puts it in the tab strip: the strip records "what I
  // have open", so it has to cover however the user got here (sidebar click, deep
  // link, tab click).
  openSessionTab(threadId);
  const update = () => {
    setThreadRoute(threadId, { replace });
    if (state.session) {
      renderer.renderSession(state.session);
    }
    renderer.syncThreadSelection();
  };
  // `transition: false` for callers that must keep rendering afterwards. A pending
  // view transition is skipped by any synchronous re-render, and its callback — the
  // thing that writes the route — then never runs, silently desyncing the URL.
  if (transition) {
    void runViewTransition(update);
  } else {
    update();
  }
  // Fetch the viewed thread's transcript so it renders read-only (instead of
  // falling back to the console home). No-op / clears the projection when the
  // thread is the active one.
  void loadViewOnlyTranscript(threadId);
}

/**
 * The session the CURRENT workspace considers focused, or null when it has no tabs.
 * Used to keep the route and the main area in step with whichever workspace is in
 * scope — switching mode or removing a session must not leave the transcript showing
 * something the strip no longer holds.
 */
function focusedThreadIdForCurrentWorkspace() {
  const workspace = state.tabWorkspaceStore.getState().ensureWorkspace(currentTabProjectId());
  const focused = focusedTab(workspace);
  return focused ? layoutThreadIds(focused.layout)[0] || null : null;
}

/**
 * Point the route (and therefore the main area) at whatever the current workspace
 * has focused, clearing it when that workspace is empty. Renders are left to the
 * caller so a navigation's view transition isn't skipped by a trailing re-render.
 */
function syncRouteToCurrentWorkspace({ replace = false } = {}) {
  const nextThreadId = focusedThreadIdForCurrentWorkspace();
  if (nextThreadId === (state.viewThreadId || null)) {
    return;
  }
  if (nextThreadId) {
    viewThreadById(nextThreadId, { transition: false, replace });
  } else {
    clearThreadRoute({ replace });
  }
}

/**
 * Give the currently routed session a tab, unless that session has been archived or
 * deleted — in which case the route is settled onto whatever this workspace has
 * focused (or Home when it has nothing) instead.
 *
 * Shared by EVERY entry point that adopts a route it did not create: the initial load
 * (`?thread=` straight from the address bar, a restored tab, a reload) and
 * back/forward. Having only the popstate path do this left the launch path resurrecting
 * dead tabs, so the reconciliation lives in one place rather than being duplicated.
 */
function adoptRoutedThread() {
  // Another window may have removed a session that this one still has open. Refusing to
  // re-create a dead tab is not enough on its own — the already-open copy has to go
  // too, or this window keeps showing a tab for a session that no longer exists.
  // Swept here (on navigation) rather than via a storage event: navigation is when a
  // stale tab can actually be acted on, and it keeps the read-through model with no
  // listener lifecycle to get wrong.
  sweepRemovedTabs();
  // Read-through, so a deletion made in another window of this profile counts; the
  // in-session set is the fallback for when storage can't persist at all.
  if (isRemovedThreadId(state.viewThreadId, state.removedThreadIds)) {
    state.viewThreadId = null;
    syncRouteToCurrentWorkspace({ replace: true });
    return;
  }
  openSessionTab(state.viewThreadId);
}

/**
 * Close any open tab whose session has since been archived or deleted — including
 * removals performed by another window of this profile, which this window only learns
 * about by reading the shared tombstones.
 *
 * Only the loaded workspaces need sweeping: the removing window already rewrote the
 * persisted copies, so a workspace this window has not opened yet arrives clean.
 */
function sweepRemovedTabs() {
  const tabs = state.tabWorkspaceStore.getState();
  const openIds = new Set(
    Object.values(tabs.workspaces).flatMap((workspace) => openThreadIds(workspace))
  );
  if (!openIds.size) {
    return;
  }

  const tombstoned = new Set([...loadRemovedThreadIds(), ...state.removedThreadIds]);
  for (const threadId of openIds) {
    if (tombstoned.has(threadId)) {
      tabs.closeThreadEverywhere(threadId);
    }
  }
}

/**
 * Open (or focus) a tab for a session in the current project's workspace.
 *
 * Mutates the store ONLY — it deliberately does not render. React's root.render() is
 * asynchronous, so a render scheduled here lands after any `startViewTransition` the
 * caller goes on to start, which makes the browser skip that transition; its callback
 * is what writes the route, so the URL silently stopped following the tabs. Every
 * caller already re-renders through renderThreads/renderSession (or calls
 * renderSessionTabs itself), so the strip still refreshes.
 */
function openSessionTab(threadId) {
  if (!threadId) {
    return;
  }
  state.tabWorkspaceStore.getState().openThread(currentTabProjectId(), threadId);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
