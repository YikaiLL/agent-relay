import {
  allowedRootsInput,
  approvalPolicyInput,
  cwdInput,
  loadDirectoryButton,
  modelInput,
  openLaunchSettingsButton,
  providerInput,
  saveAllowedRootsButton,
  sandboxInput,
  startEffortInput,
  startPromptInput,
  startSessionButton,
} from "./dom.js";
import { renderAllowedRoots } from "./render-security.js";
import { readLocalUiState } from "./ui-store.js";
import { createPollingController } from "./session/polling.js";
import { createStreamController } from "./session/stream.js";
import { createTranscriptController } from "./session/transcript.js";
import { createPairingController } from "./session/pairing.js";
import { createLifecycleController } from "./session/lifecycle.js";
import { createTranscriptFlushScheduler } from "../shared/transcript-flush-scheduler.js";
import { settleTranscriptProjection } from "./transcript/store.js";

export function createSessionController({
  state,
  apiFetch,
  queryClient = null,
  shortId,
  logLine,
  seedDefaults,
  setSelectedCwd,
  setThreadRoute,
  canCurrentDeviceWrite,
  renderSession,
  renderOverviewState,
  renderSessionUnavailable,
  renderThreadListMessage,
  renderThreads,
  renderAuthRequiredState,
  runViewTransition,
  handleUnauthorized,
}) {
  function setStartControlsBusy(busy) {
    [
      loadDirectoryButton,
      startSessionButton,
      openLaunchSettingsButton,
      cwdInput,
      startPromptInput,
      modelInput,
      providerInput,
      approvalPolicyInput,
      sandboxInput,
      startEffortInput,
    ].forEach((element) => {
      if (element) {
        element.disabled = busy;
      }
    });
  }

  function isViewingConversation(session) {
    return Boolean(session?.active_thread_id && state.viewThreadId === session.active_thread_id);
  }

  function liveElement(id, fallback) {
    return document.getElementById(id) || fallback;
  }

  function isCurrentDeviceActiveController(session) {
    if (!session?.active_thread_id || !session.active_controller_device_id) {
      return false;
    }

    return session.active_controller_device_id === state.deviceId;
  }

  async function saveAllowedRoots() {
    const allowed_roots = (allowedRootsInput?.value || "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);

    if (saveAllowedRootsButton) {
      saveAllowedRootsButton.disabled = true;
    }
    if (allowedRootsInput) {
      allowedRootsInput.disabled = true;
    }

    logLine(
      allowed_roots.length
        ? `Saving ${allowed_roots.length} allowed workspace root${allowed_roots.length === 1 ? "" : "s"}.`
        : "Clearing relay workspace restrictions."
    );

    try {
      const response = await apiFetch("/api/allowed-roots", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          allowed_roots,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to save allowed roots");
      }

      state.localUiStore.getState().setAllowedRootsDraftDirty(false);
      renderAllowedRoots(payload.data.allowed_roots || [], {
        draftDirty: readLocalUiState(state.localUiStore).allowedRootsDraftDirty,
      });
      await ctx.loadSession("post-allowed-roots refresh");
      await ctx.loadThreads("post-allowed-roots refresh");
      logLine(payload.data?.message || "Relay workspace restrictions saved.");
    } catch (error) {
      logLine(`Allowed roots update failed: ${error.message}`);
    } finally {
      if (saveAllowedRootsButton) {
        saveAllowedRootsButton.disabled = false;
      }
      if (allowedRootsInput) {
        allowedRootsInput.disabled = false;
      }
    }
  }

  // One pending-render slot shared by the delta stream (session/stream.js) and
  // the snapshot path (session/lifecycle.js) — two instances would leave the
  // double-render bug (a snapshot landing between a delta's state write and
  // its pending frame) exactly in place. See .sealwire/PLAN.md.
  const transcriptFlushScheduler = createTranscriptFlushScheduler({
    // Late-bound through `ctx`, not a captured `renderSession` value: app.js
    // monkey-patches `renderer.renderSession`, and `ctx.renderSession` below is
    // itself a wrapper that clears the pending slot — a flush must go through
    // that same wrapper, not around it.
    render: () => {
      if (state.session) {
        ctx.renderSession(state.session);
      }
    },
  });

  // Invariant: renderSession means "render now, and nothing pending after."
  // This is what makes the many direct renderSession(...) call sites in
  // lifecycle.js / transcript.js / app.js safe to leave alone — any of them
  // can paint at any time and the pending flush is satisfied rather than
  // duplicated. Also why settleTranscriptProjection runs HERE rather than
  // only inside the scheduler's own flush: a direct call builds its own
  // session object by spreading state.session, so settling elsewhere would
  // miss it and paint the stale array with the just-armed token invisible.
  function renderSessionAndClearPendingFlush(session) {
    transcriptFlushScheduler.cancel();
    const settled = settleTranscriptProjection(state);
    if (!settled) {
      return renderSession(session);
    }
    // settleTranscriptProjection materialises into state.session, not
    // necessarily into THIS `session` — most callers pass state.session
    // itself, but some (session_meta_updated, approval_added/resolved) build
    // a fresh `{...state.session, override}` copy captured before the settle
    // above ran, so its `.transcript` is still the stale one. Recognise "the
    // same live thread" by id, not by array identity (a rebuilt array is not
    // a reliable "still pending" signal — see settleTranscriptProjection's
    // doc) and adopt the freshly-settled transcript into it.
    const isLiveThreadSession =
      session
      && state.session
      && session.active_thread_id
      && session.active_thread_id === state.session.active_thread_id;
    return renderSession(
      isLiveThreadSession ? { ...session, transcript: state.session.transcript } : session
    );
  }

  const ctx = {
    state,
    apiFetch,
    queryClient,
    shortId,
    logLine,
    seedDefaults,
    setSelectedCwd,
    setThreadRoute,
    canCurrentDeviceWrite,
    renderSession: renderSessionAndClearPendingFlush,
    transcriptFlushScheduler,
    renderOverviewState,
    renderSessionUnavailable,
    renderThreadListMessage,
    renderThreads,
    renderAuthRequiredState,
    runViewTransition,
    handleUnauthorized,
    setStartControlsBusy,
    liveElement,
    // The launch dialog's field values. The dialog is controlled, so the draft
    // in the UI store — not the markup — is what the start request is built from.
    readSessionDraft: () => readLocalUiState(state.localUiStore).sessionDraft || {},
    focusWorkspaceField: () =>
      document.getElementById("launch-start-session-dialog-cwd")?.focus(),
    isViewingConversation,
    isCurrentDeviceActiveController,
  };

  const polling = createPollingController(ctx);
  const stream = createStreamController(ctx);
  const transcriptController = createTranscriptController(ctx);
  const pairing = createPairingController(ctx);
  const lifecycle = createLifecycleController(ctx);
  const controller = {
    ...polling,
    ...stream,
    ...transcriptController,
    ...pairing,
    ...lifecycle,
    saveAllowedRoots,
  };
  Object.assign(ctx, controller);

  return {
    cancelControllerHeartbeat: controller.cancelControllerHeartbeat,
    cancelControllerLeaseRefresh: controller.cancelControllerLeaseRefresh,
    cancelSessionPoll: controller.cancelSessionPoll,
    cancelStreamReconnect: controller.cancelStreamReconnect,
    cancelThreadsPoll: controller.cancelThreadsPoll,
    // Narrow escape hatch for app.js's `renderer.renderSession` wrap
    // (frontend/app.js:1184), which every direct renderSession(...) call site
    // there goes through instead of ctx.renderSession — without this, those
    // calls paint once immediately and again when a queued delta timer fires.
    // Must settle as well as cancel: a BARE cancel destroys the only
    // scheduled catch-up while leaving state.session.transcript on its stale
    // pre-projection array, so the direct render that follows paints that
    // stale array. app.js re-reads state.session after this call to pick up
    // whatever settling just materialised.
    cancelPendingTranscriptFlush: () => {
      transcriptFlushScheduler.cancel();
      settleTranscriptProjection(state);
    },
    connectSessionStream: controller.connectSessionStream,
    copyPairingLink: controller.copyPairingLink,
    decidePairingRequest: controller.decidePairingRequest,
    ensureConversationTranscript: controller.ensureConversationTranscript,
    loadSession: controller.loadSession,
    loadThreads: controller.loadThreads,
    searchThreads: controller.searchThreads,
    maybeLoadOlderTranscript: controller.maybeLoadOlderTranscript,
    forkSession: controller.forkSession,
    resumeSession: controller.resumeSession,
    revokeOtherDevices: controller.revokeOtherDevices,
    revokePairedDevice: controller.revokePairedDevice,
    saveAllowedRoots: controller.saveAllowedRoots,
    scheduleControllerHeartbeat: controller.scheduleControllerHeartbeat,
    scheduleControllerLeaseRefresh: controller.scheduleControllerLeaseRefresh,
    scheduleSessionPoll: controller.scheduleSessionPoll,
    scheduleThreadsPoll: controller.scheduleThreadsPoll,
    sendMessage: controller.sendMessage,
    requestReview: controller.requestReview,
    startWorkflow: controller.startWorkflow,
    resolveReview: controller.resolveReview,
    resolveWorkflow: controller.resolveWorkflow,
    deleteReview: controller.deleteReview,
    repairWorkspace: controller.repairWorkspace,
    fetchTranscriptPage: controller.fetchTranscriptPage,
    stopActiveTurn: controller.stopActiveTurn,
    startPairing: controller.startPairing,
    startSession: controller.startSession,
    submitAskUserQuestionAnswer: controller.submitAskUserQuestionAnswer,
    submitDecision: controller.submitDecision,
    takeOverControl: controller.takeOverControl,
    toggleTranscriptEntry: controller.toggleTranscriptEntry,
    toggleTranscriptExpandKey: controller.toggleTranscriptExpandKey,
    ensureFileChangeDetail: controller.ensureFileChangeDetail,
    applyFileChange: controller.applyFileChange,
    updateSessionSettings: controller.updateSessionSettings,
  };
}
