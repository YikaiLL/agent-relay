import * as dom from "./dom.js";
import { clearPairingQueryFromUrl, decryptJson, encryptJson, parsePairingPayload } from "./crypto.js";
import {
  configureRenderHandlers,
  isCurrentDeviceActiveController,
  renderDeviceMeta,
  renderEmptyState,
  renderLog,
  renderSession,
  renderThreads,
  resetRemoteSurface,
  setRemoteSessionPanelOpen,
  updateStatusBadge,
} from "./render.js";
import {
  CLAIM_REFRESH_FLOOR_MS,
  CLAIM_REFRESH_SKEW_MS,
  clearSessionClaim,
  connectionTarget,
  CONTROL_HEARTBEAT_MS,
  hasUsableSessionClaim,
  LEASE_EXPIRY_REFRESH_SKEW_MS,
  loadDeviceLabel,
  normalizedDeviceLabel,
  saveDeviceLabel,
  saveRemoteAuth,
  setSessionClaim,
  state,
} from "./state.js";
import { shortId } from "./utils.js";
import { escapeHtml } from "./utils.js";

configureRenderHandlers({
  onResumeThread(threadId) {
    void resumeRemoteSession(threadId);
  },
});

dom.pairingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void beginPairing(dom.pairingInput.value);
});

dom.forgetDeviceButton.addEventListener("click", () => {
  forgetCurrentDevice();
});

dom.remoteSessionToggle.addEventListener("click", () => {
  setRemoteSessionPanelOpen(dom.remoteSessionPanel.hidden);
});

dom.remoteStartSessionButton.addEventListener("click", () => {
  void startRemoteSession();
});

dom.remoteThreadsRefreshButton.addEventListener("click", () => {
  void refreshRemoteThreads("manual refresh");
});

dom.remoteTakeOverButton.addEventListener("click", () => {
  void takeOverControl();
});

dom.remoteMessageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendMessage();
});

dom.remoteTranscript.addEventListener("click", (event) => {
  const approvalButton = event.target.closest("[data-approval-decision]");
  if (!approvalButton) {
    return;
  }

  void submitDecision(
    approvalButton.dataset.approvalDecision,
    approvalButton.dataset.approvalScope || "once"
  );
});

void boot();

async function boot() {
  if (!window.crypto?.subtle) {
    renderLog("Secure browser crypto is unavailable. Use HTTPS or localhost for remote pairing.");
  }

  dom.deviceLabelInput.value = loadDeviceLabel();
  setRemoteSessionPanelOpen(false);
  applyPairingQuery();
  renderDeviceMeta();
  renderEmptyState();
  renderThreads([]);

  if (state.remoteAuth || state.pairingTicket) {
    connectBroker("initial boot");
  }
}

function applyPairingQuery() {
  const raw = new URL(window.location.href).searchParams.get("pairing");
  if (!raw) {
    return;
  }

  try {
    state.pairingTicket = parsePairingPayload(raw);
    dom.pairingInput.value = raw;
    renderLog(`Loaded pairing ticket ${state.pairingTicket.pairing_id} from URL.`);
  } catch (error) {
    renderLog(`Invalid pairing URL: ${error.message}`);
  }
}

async function beginPairing(rawValue) {
  const raw = rawValue.trim();
  if (!raw) {
    renderLog("Paste a pairing link or code first.");
    dom.pairingInput.focus();
    return;
  }

  try {
    state.pairingTicket = parsePairingPayload(raw);
    state.remoteAuth = null;
    state.session = null;
    state.threads = [];
    state.currentApprovalId = null;
    clearClaimLifecycle();
    rejectPendingActions("pairing restarted before broker actions completed");
    saveRemoteAuth(null);
    saveDeviceLabel(dom.deviceLabelInput.value);
    renderDeviceMeta();
    renderThreads([]);
    connectBroker("pairing request");
  } catch (error) {
    renderLog(`Pairing input is invalid: ${error.message}`);
  }
}

function connectBroker(reason) {
  const target = connectionTarget();
  if (!target) {
    renderLog("Broker connect skipped because no pairing or saved device is present.");
    return;
  }

  cancelSocketReconnect();
  closeBrokerSocket(false);

  const url = new URL(target.brokerUrl);
  url.pathname = `/ws/${encodeURIComponent(target.brokerChannelId)}`;
  url.searchParams.set("peer_id", state.surfacePeerId);
  url.searchParams.set("role", "surface");

  renderLog(`Connecting to broker (${reason}).`);
  const socket = new WebSocket(url.toString());
  state.socket = socket;

  socket.addEventListener("open", () => {
    if (state.socket !== socket) {
      return;
    }

    state.socketConnected = true;
    updateStatusBadge();
    renderLog("Broker websocket connected.");

    if (state.pairingTicket) {
      void sendPairingRequest();
      return;
    }

    if (state.remoteAuth) {
      void recoverRemoteSession(`broker ${reason}`);
    }
  });

  socket.addEventListener("message", (event) => {
    if (state.socket !== socket) {
      return;
    }

    void handleSocketMessage(event.data);
  });

  socket.addEventListener("close", () => {
    if (state.socket !== socket) {
      return;
    }

    state.socket = null;
    state.socketConnected = false;
    clearClaimLifecycle();
    rejectPendingActions("broker socket disconnected");
    updateStatusBadge();
    renderLog("Broker websocket closed.");
    scheduleSocketReconnect();
  });

  socket.addEventListener("error", () => {
    if (state.socket !== socket) {
      return;
    }

    renderLog("Broker websocket hit an error.");
  });
}

function closeBrokerSocket(resetConnectionState = true) {
  if (!state.socket) {
    if (resetConnectionState) {
      state.socketConnected = false;
      updateStatusBadge();
    }
    return;
  }

  const socket = state.socket;
  state.socket = null;
  socket.close();

  if (resetConnectionState) {
    state.socketConnected = false;
    updateStatusBadge();
  }
}

function scheduleSocketReconnect() {
  if (!connectionTarget()) {
    return;
  }

  cancelSocketReconnect();
  state.socketReconnectTimer = window.setTimeout(() => {
    connectBroker("reconnect");
  }, 1500);
}

function cancelSocketReconnect() {
  if (!state.socketReconnectTimer) {
    return;
  }

  window.clearTimeout(state.socketReconnectTimer);
  state.socketReconnectTimer = null;
}

async function handleSocketMessage(rawData) {
  let frame;
  try {
    frame = JSON.parse(rawData);
  } catch (error) {
    renderLog(`Broker frame parse failed: ${error.message}`);
    return;
  }

  if (frame.type === "welcome") {
    renderLog(`Joined broker channel ${frame.channel_id}.`);
    return;
  }

  if (frame.type === "presence") {
    if (frame.peer?.role === "relay") {
      renderLog(`Relay peer ${frame.peer.peer_id} ${frame.kind}.`);
      if (frame.kind === "joined" && state.remoteAuth) {
        void recoverRemoteSession("relay joined");
      }
    }
    return;
  }

  if (frame.type === "error") {
    renderLog(`Broker error: ${frame.message}`);
    return;
  }

  if (frame.type !== "message") {
    return;
  }

  await handleBrokerPayload(frame.payload);
}

async function handleBrokerPayload(payload) {
  const kind = payload?.kind;

  if (kind === "encrypted_pairing_result") {
    await handleEncryptedPairingResult(payload);
    return;
  }

  if (kind === "encrypted_session_snapshot") {
    await handleEncryptedSessionSnapshot(payload);
    return;
  }

  if (kind === "encrypted_remote_action_result") {
    await handleEncryptedRemoteActionResult(payload);
    return;
  }

  if (kind === "session_snapshot") {
    applySessionSnapshot(payload.snapshot);
    renderLog("Received managed-mode session snapshot from broker.");
    return;
  }

  if (kind === "remote_action_result") {
    handleRemoteActionResult(payload.action_id, payload);
  }
}

async function sendPairingRequest() {
  const ticket = state.pairingTicket;
  if (!ticket) {
    return;
  }

  const payload = {
    kind: "pairing_request",
    pairing_id: ticket.pairing_id,
    envelope: await encryptJson(ticket.pairing_secret, {
      device_id: state.requestedDeviceId,
      device_label: normalizedDeviceLabel(dom.deviceLabelInput.value),
    }),
  };

  sendBrokerFrame(payload);
  renderLog(`Sent pairing request for ${ticket.pairing_id}.`);
}

async function handleEncryptedPairingResult(payload) {
  if (!state.pairingTicket) {
    return;
  }

  if (
    payload.pairing_id !== state.pairingTicket.pairing_id ||
    payload.target_peer_id !== state.surfacePeerId
  ) {
    return;
  }

  const result = await decryptJson(state.pairingTicket.pairing_secret, payload.envelope);
  if (!result.ok) {
    renderLog(`Pairing failed: ${result.error || "unknown pairing error"}`);
    return;
  }

  const device = result.device;
  state.remoteAuth = {
    brokerUrl: state.pairingTicket.broker_url,
    brokerChannelId: state.pairingTicket.broker_channel_id,
    relayPeerId: state.pairingTicket.relay_peer_id,
    securityMode: state.pairingTicket.security_mode,
    deviceId: device.device_id,
    deviceLabel: device.label,
    deviceToken: result.device_token,
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  };
  saveRemoteAuth(state.remoteAuth);
  state.pairingTicket = null;
  dom.pairingInput.value = "";
  clearPairingQueryFromUrl();
  renderDeviceMeta();
  renderLog(`Paired remote device ${device.label} (${shortId(device.device_id)}).`);
  await ensureRemoteClaim({
    force: true,
    reason: "post-pairing",
    syncAfterClaim: true,
  });
}

async function handleEncryptedSessionSnapshot(payload) {
  if (
    payload.target_peer_id !== state.surfacePeerId ||
    payload.device_id !== state.remoteAuth?.deviceId
  ) {
    return;
  }

  const snapshot = await decryptJson(state.remoteAuth.deviceToken, payload.envelope);
  applySessionSnapshot(snapshot);
}

async function handleEncryptedRemoteActionResult(payload) {
  if (
    payload.target_peer_id !== state.surfacePeerId ||
    payload.device_id !== state.remoteAuth?.deviceId
  ) {
    return;
  }

  const result = await decryptJson(state.remoteAuth.deviceToken, payload.envelope);
  handleRemoteActionResult(payload.action_id, result);
}

function handleRemoteActionResult(actionId, result) {
  if (result.session_claim && state.remoteAuth) {
    setSessionClaim(result.session_claim, result.session_claim_expires_at || null);
    scheduleClaimRefresh();
    renderDeviceMeta();
  }

  if (result.snapshot) {
    applySessionSnapshot(result.snapshot);
  }

  if (result.threads?.threads) {
    state.threads = result.threads.threads;
    renderThreads(state.threads);
  }

  settlePendingAction(actionId, result);

  if (result.ok) {
    if (result.action === "claim_device") {
      renderLog("Remote device claim is active.");
      return;
    }
    if (result.receipt?.message) {
      renderLog(result.receipt.message);
    } else {
      renderLog(`Remote ${result.action} succeeded.`);
    }
    return;
  }

  if (isSessionClaimError(result.error) && state.remoteAuth) {
    clearSessionClaim();
    scheduleClaimRefresh();
    renderDeviceMeta();
  }

  renderLog(`Remote ${result.action} failed: ${result.error || "unknown error"}`);
}

async function ensureRemoteClaim({ force = false, reason = "claim refresh", syncAfterClaim = false } = {}) {
  if (!state.remoteAuth) {
    throw new Error("this browser is not paired yet");
  }
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    throw new Error("broker socket is not connected");
  }
  if (!force && hasUsableSessionClaim(CLAIM_REFRESH_SKEW_MS)) {
    return state.remoteAuth.sessionClaim;
  }
  if (state.claimPromise) {
    return state.claimPromise;
  }

  const needsRefresh = Boolean(state.remoteAuth.sessionClaim);
  state.claimPromise = (async () => {
    renderLog(
      `${needsRefresh ? "Refreshing" : "Claiming"} remote device (${reason}).`
    );
    const result = await dispatchRemoteAction("claim_device", {});
    if (syncAfterClaim) {
      await syncRemoteSnapshot(`claim sync (${reason})`, true);
    }
    return result.session_claim;
  })().finally(() => {
    state.claimPromise = null;
  });

  return state.claimPromise;
}

function scheduleClaimRefresh() {
  cancelClaimRefresh();

  if (!state.socketConnected || !state.remoteAuth?.sessionClaimExpiresAt) {
    return;
  }

  const expiresAtMs = state.remoteAuth.sessionClaimExpiresAt * 1000;
  const delayMs = Math.max(
    CLAIM_REFRESH_FLOOR_MS,
    expiresAtMs - Date.now() - CLAIM_REFRESH_SKEW_MS
  );
  state.claimRefreshTimer = window.setTimeout(() => {
    void ensureRemoteClaim({
      force: true,
      reason: "scheduled refresh",
      syncAfterClaim: false,
    }).catch((error) => {
      renderLog(`Scheduled claim refresh failed: ${error.message}`);
    });
  }, delayMs);
}

function cancelClaimRefresh() {
  if (!state.claimRefreshTimer) {
    return;
  }

  window.clearTimeout(state.claimRefreshTimer);
  state.claimRefreshTimer = null;
}

function clearClaimLifecycle() {
  cancelClaimRefresh();
  state.claimPromise = null;
}

async function recoverRemoteSession(reason) {
  try {
    await ensureRemoteClaim({
      force: true,
      reason,
      syncAfterClaim: true,
    });
  } catch (error) {
    renderLog(`Remote recovery failed: ${error.message}`);
  }
}

async function syncRemoteSnapshot(reason, silent = false) {
  if (!silent) {
    renderLog(`Syncing remote session (${reason}).`);
  }

  try {
    await dispatchOrRecover("heartbeat", {
      input: {},
    });
  } catch (error) {
    renderLog(`Remote heartbeat sync failed: ${error.message}`);
  }

  try {
    await refreshRemoteThreads(reason, { silent: true });
  } catch (error) {
    renderLog(`Remote thread sync failed: ${error.message}`);
  }
}

async function startRemoteSession() {
  const cwd = dom.remoteCwdInput.value.trim();
  if (!cwd) {
    renderLog("Choose a workspace before starting a remote session.");
    dom.remoteCwdInput.focus();
    return;
  }

  dom.remoteStartSessionButton.disabled = true;
  renderLog(`Starting remote session in ${cwd}.`);

  try {
    await dispatchOrRecover("start_session", {
      input: {
        cwd,
        initial_prompt: dom.remoteStartPromptInput.value.trim() || null,
        model: dom.remoteModelInput.value.trim() || null,
        approval_policy: dom.remoteApprovalPolicyInput.value,
        sandbox: dom.remoteSandboxInput.value,
        effort: dom.remoteStartEffortInput.value,
      },
    });
    setRemoteSessionPanelOpen(false);
    await refreshRemoteThreads("post-start refresh", { silent: true });
  } catch (error) {
    renderLog(`Remote start failed: ${error.message}`);
  } finally {
    dom.remoteStartSessionButton.disabled = false;
  }
}

async function refreshRemoteThreads(reason, options = {}) {
  const { silent = false } = options;
  if (!state.remoteAuth) {
    renderThreads([]);
    return;
  }

  dom.remoteThreadsRefreshButton.disabled = true;
  dom.remoteThreadsCount.textContent = "Loading...";
  if (!silent) {
    renderLog(`Fetching remote thread list (${reason}).`);
  }

  try {
    await dispatchOrRecover("list_threads", {
      query: {
        cwd: dom.remoteThreadsCwdInput.value.trim() || null,
        limit: 80,
      },
    });
  } catch (error) {
    dom.remoteThreadsCount.textContent = "Error";
    dom.remoteThreadsList.innerHTML = `<p class="sidebar-empty">${escapeHtml(error.message)}</p>`;
    if (!silent) {
      renderLog(`Remote thread refresh failed: ${error.message}`);
    }
    throw error;
  } finally {
    dom.remoteThreadsRefreshButton.disabled = false;
  }
}

async function resumeRemoteSession(threadId) {
  if (!threadId) {
    return;
  }

  renderLog(`Resuming remote thread ${threadId}.`);

  try {
    await dispatchOrRecover("resume_session", {
      input: {
        thread_id: threadId,
        approval_policy: dom.remoteApprovalPolicyInput.value,
        sandbox: dom.remoteSandboxInput.value,
        effort: dom.remoteStartEffortInput.value,
      },
    });
    await refreshRemoteThreads("post-resume refresh", { silent: true });
  } catch (error) {
    renderLog(`Remote resume failed: ${error.message}`);
  }
}

async function sendMessage() {
  const text = dom.remoteMessageInput.value.trim();
  if (!text) {
    renderLog("Message is empty.");
    return;
  }

  dom.remoteSendButton.disabled = true;

  try {
    await dispatchOrRecover("send_message", {
      input: {
        text,
        effort: dom.remoteMessageEffort.value,
      },
    });
    dom.remoteMessageInput.value = "";
  } catch (error) {
    renderLog(`Remote send failed: ${error.message}`);
  } finally {
    dom.remoteSendButton.disabled = false;
  }
}

async function takeOverControl() {
  try {
    await dispatchOrRecover("take_over", {
      input: {},
    });
  } catch (error) {
    renderLog(`Take over failed: ${error.message}`);
  }
}

async function submitDecision(decision, scope) {
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

async function dispatchOrRecover(actionType, request, options = {}) {
  const allowClaimRetry = options.allowClaimRetry !== false;
  const skipPreclaim = options.skipPreclaim === true;

  if (actionType !== "claim_device" && !skipPreclaim) {
    await ensureRemoteClaim({
      force: !hasUsableSessionClaim(CLAIM_REFRESH_SKEW_MS),
      reason: `${actionType} preflight`,
      syncAfterClaim: false,
    });
  }

  try {
    return await dispatchRemoteAction(actionType, request);
  } catch (error) {
    if (allowClaimRetry && actionType !== "claim_device" && isSessionClaimError(error.message)) {
      clearSessionClaim();
      renderDeviceMeta();
      renderLog(`Session claim expired during ${actionType}; re-claiming and retrying once.`);
      await ensureRemoteClaim({
        force: true,
        reason: `${actionType} retry`,
        syncAfterClaim: false,
      });
      return dispatchOrRecover(actionType, request, {
        ...options,
        allowClaimRetry: false,
        skipPreclaim: true,
      });
    }

    throw error;
  }
}

async function dispatchRemoteAction(actionType, request) {
  if (!state.remoteAuth) {
    throw new Error("this browser is not paired yet");
  }
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    throw new Error("broker socket is not connected");
  }

  const actionId = makeActionId(actionType);
  const resultPromise = registerPendingAction(actionId, actionType);

  try {
    if (actionType === "claim_device") {
      sendBrokerFrame(await buildClaimDevicePayload(actionId, request));
      return await resultPromise;
    }

    if (!state.remoteAuth.sessionClaim) {
      throw new Error("device is not claimed yet");
    }

    sendBrokerFrame(await buildClaimedActionPayload(actionId, actionType, request));
    return await resultPromise;
  } catch (error) {
    state.pendingActions.delete(actionId);
    throw error;
  }
}

async function buildClaimDevicePayload(actionId, request) {
  if (state.remoteAuth.securityMode === "managed") {
    return {
      kind: "remote_action",
      action_id: actionId,
      auth: {
        device_id: state.remoteAuth.deviceId,
        device_token: state.remoteAuth.deviceToken,
      },
      request: {
        type: "claim_device",
        ...request,
      },
    };
  }

  return {
    kind: "encrypted_remote_action",
    action_id: actionId,
    device_id: state.remoteAuth.deviceId,
    envelope: await encryptJson(state.remoteAuth.deviceToken, {
      type: "claim_device",
      ...request,
    }),
  };
}

async function buildClaimedActionPayload(actionId, actionType, request) {
  if (state.remoteAuth.securityMode === "managed") {
    return {
      kind: "remote_action",
      action_id: actionId,
      session_claim: state.remoteAuth.sessionClaim,
      device_id: state.remoteAuth.deviceId,
      request: {
        type: actionType,
        ...request,
      },
    };
  }

  return {
    kind: "encrypted_remote_action",
    action_id: actionId,
    session_claim: state.remoteAuth.sessionClaim,
    device_id: state.remoteAuth.deviceId,
    envelope: await encryptJson(state.remoteAuth.deviceToken, {
      type: actionType,
      ...request,
    }),
  };
}

function sendBrokerFrame(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    throw new Error("broker socket is not connected");
  }

  state.socket.send(
    JSON.stringify({
      type: "publish",
      payload,
    })
  );
}

function registerPendingAction(actionId, actionType) {
  return new Promise((resolve, reject) => {
    state.pendingActions.set(actionId, {
      actionType,
      reject,
      resolve,
    });
  });
}

function settlePendingAction(actionId, result) {
  if (!actionId) {
    return;
  }

  const pending = state.pendingActions.get(actionId);
  if (!pending) {
    return;
  }

  state.pendingActions.delete(actionId);
  if (result.ok) {
    pending.resolve(result);
    return;
  }

  pending.reject(new Error(result.error || `${pending.actionType} failed`));
}

function rejectPendingActions(message) {
  if (!state.pendingActions.size) {
    return;
  }

  const error = new Error(message);
  for (const pending of state.pendingActions.values()) {
    pending.reject(error);
  }
  state.pendingActions.clear();
}

function applySessionSnapshot(snapshot) {
  renderSession(snapshot);
  scheduleControllerHeartbeat(snapshot);
  scheduleControllerLeaseRefresh(snapshot);
  scheduleClaimRefresh();
}

function scheduleControllerHeartbeat(session) {
  cancelControllerHeartbeat();

  if (!session?.active_thread_id || !isCurrentDeviceActiveController(session)) {
    return;
  }

  state.controllerHeartbeatTimer = window.setTimeout(() => {
    void sendHeartbeat();
  }, CONTROL_HEARTBEAT_MS);
}

async function sendHeartbeat() {
  if (!state.session?.active_thread_id || !isCurrentDeviceActiveController(state.session)) {
    return;
  }

  try {
    await dispatchOrRecover("heartbeat", {
      input: {},
    });
  } catch (error) {
    renderLog(`Remote heartbeat failed: ${error.message}`);
  } finally {
    if (state.session?.active_thread_id && isCurrentDeviceActiveController(state.session)) {
      scheduleControllerHeartbeat(state.session);
    }
  }
}

function cancelControllerHeartbeat() {
  if (!state.controllerHeartbeatTimer) {
    return;
  }

  window.clearTimeout(state.controllerHeartbeatTimer);
  state.controllerHeartbeatTimer = null;
}

function scheduleControllerLeaseRefresh(session) {
  cancelControllerLeaseRefresh();

  if (
    !session?.active_thread_id ||
    !session.active_controller_device_id ||
    isCurrentDeviceActiveController(session) ||
    !session.controller_lease_expires_at
  ) {
    return;
  }

  const delayMs = Math.max(
    LEASE_EXPIRY_REFRESH_SKEW_MS,
    session.controller_lease_expires_at * 1000 - Date.now() + LEASE_EXPIRY_REFRESH_SKEW_MS
  );

  state.controllerLeaseRefreshTimer = window.setTimeout(() => {
    const next = {
      ...state.session,
      active_controller_device_id: null,
      active_controller_last_seen_at: null,
      controller_lease_expires_at: null,
    };
    applySessionSnapshot(next);
    renderLog("Remote control lease expired locally. The next sender can reclaim control.");
  }, delayMs);
}

function cancelControllerLeaseRefresh() {
  if (!state.controllerLeaseRefreshTimer) {
    return;
  }

  window.clearTimeout(state.controllerLeaseRefreshTimer);
  state.controllerLeaseRefreshTimer = null;
}

function forgetCurrentDevice() {
  state.pairingTicket = null;
  state.remoteAuth = null;
  state.session = null;
  state.currentApprovalId = null;
  state.threads = [];
  clearClaimLifecycle();
  rejectPendingActions("device was forgotten before broker actions completed");
  saveRemoteAuth(null);
  clearPairingQueryFromUrl();
  cancelControllerHeartbeat();
  cancelControllerLeaseRefresh();
  closeBrokerSocket();
  dom.pairingInput.value = "";
  resetRemoteSurface();
  renderLog("Forgot the stored remote device for this browser.");
}

function isSessionClaimError(message) {
  return typeof message === "string" && message.toLowerCase().includes("session claim");
}

function makeActionId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}
