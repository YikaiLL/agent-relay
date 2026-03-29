import { decryptJson, encryptJson, signClaimProof } from "./crypto.js";
import { renderDeviceMeta, renderLog, renderThreads } from "./render.js";
import {
  CLAIM_REFRESH_FLOOR_MS,
  CLAIM_REFRESH_SKEW_MS,
  clearSessionClaim,
  ensureDeviceIdentity,
  hasUsableSessionClaim,
  setSessionClaim,
  state,
} from "./state.js";
import { sendBrokerFrame } from "./broker-client.js";

let onApplySessionSnapshot = () => {};
let onSyncRemoteSnapshot = async () => {};

export function configureRemoteActions(handlers) {
  onApplySessionSnapshot = handlers.onApplySessionSnapshot || onApplySessionSnapshot;
  onSyncRemoteSnapshot = handlers.onSyncRemoteSnapshot || onSyncRemoteSnapshot;
}

export async function handleRemoteBrokerPayload(payload) {
  const kind = payload?.kind;

  if (kind === "encrypted_session_snapshot") {
    await handleEncryptedSessionSnapshot(payload);
    return;
  }

  if (kind === "encrypted_remote_action_result") {
    await handleEncryptedRemoteActionResult(payload);
    return;
  }

  if (kind === "session_snapshot") {
    onApplySessionSnapshot(payload.snapshot);
    renderLog("Received managed-mode session snapshot from broker.");
    return;
  }

  if (kind === "remote_action_result") {
    handleRemoteActionResult(payload.action_id, payload);
  }
}

export async function ensureRemoteClaim({
  force = false,
  reason = "claim refresh",
  syncAfterClaim = false,
} = {}) {
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
    renderLog(`${needsRefresh ? "Refreshing" : "Claiming"} remote device (${reason}).`);
    const result = await dispatchRemoteAction("claim_device", {});
    if (syncAfterClaim) {
      await onSyncRemoteSnapshot(`claim sync (${reason})`, true);
    }
    return result.session_claim;
  })().finally(() => {
    state.claimPromise = null;
  });

  return state.claimPromise;
}

export async function recoverRemoteSession(reason) {
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

export async function dispatchOrRecover(actionType, request, options = {}) {
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

export function scheduleClaimRefresh() {
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

export function clearClaimLifecycle() {
  cancelClaimRefresh();
  state.claimPromise = null;
}

export function rejectPendingActions(message) {
  if (!state.pendingActions.size) {
    return;
  }

  const error = new Error(message);
  for (const pending of state.pendingActions.values()) {
    pending.reject(error);
  }
  state.pendingActions.clear();
}

async function handleEncryptedSessionSnapshot(payload) {
  if (
    payload.target_peer_id !== state.socketPeerId ||
    payload.device_id !== state.remoteAuth?.deviceId
  ) {
    return;
  }

  const snapshot = await decryptJson(state.remoteAuth.deviceToken, payload.envelope);
  onApplySessionSnapshot(snapshot);
}

async function handleEncryptedRemoteActionResult(payload) {
  if (
    payload.target_peer_id !== state.socketPeerId ||
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
    onApplySessionSnapshot(result.snapshot);
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
  if (!state.socketPeerId) {
    throw new Error("broker peer id is not ready yet");
  }
  const deviceKeypair = await ensureDeviceIdentity();

  const claimProof = await signClaimProof(
    actionId,
    state.remoteAuth.deviceId,
    state.socketPeerId,
    deviceKeypair
  );

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
        proof: claimProof,
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
      proof: claimProof,
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

function cancelClaimRefresh() {
  if (!state.claimRefreshTimer) {
    return;
  }

  window.clearTimeout(state.claimRefreshTimer);
  state.claimRefreshTimer = null;
}

function isSessionClaimError(message) {
  return typeof message === "string" && message.toLowerCase().includes("session claim");
}

function makeActionId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}
