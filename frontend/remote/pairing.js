import * as dom from "./dom.js";
import { clearPairingQueryFromUrl, decryptJson, encryptJson, parsePairingPayload } from "./crypto.js";
import { closeBrokerSocket, connectBroker, sendBrokerFrame } from "./broker-client.js";
import {
  clearClaimLifecycle,
  ensureRemoteClaim,
  rejectPendingActions,
} from "./actions.js";
import {
  renderDeviceMeta,
  renderLog,
  renderThreads,
  resetRemoteSurface,
} from "./render.js";
import {
  normalizedDeviceLabel,
  saveDeviceLabel,
  saveRemoteAuth,
  state,
} from "./state.js";
import { clearSessionRuntime } from "./session-ops.js";
import { shortId } from "./utils.js";

export function applyPairingQuery() {
  const raw = new URL(window.location.href).searchParams.get("pairing");
  if (!raw) {
    return null;
  }

  try {
    dom.pairingInput.value = raw;
    const pairingTicket = parsePairingPayload(raw);
    renderLog(`Loaded pairing ticket ${pairingTicket.pairing_id} from URL.`);
    return raw;
  } catch (error) {
    state.pairingPhase = "error";
    state.pairingError = error.message;
    renderLog(`Invalid pairing URL: ${error.message}`);
    renderDeviceMeta();
    return null;
  }
}

export async function beginPairing(rawValue, { auto = false } = {}) {
  const raw = rawValue.trim();
  if (!raw) {
    renderLog("Paste a pairing link or code first.");
    dom.pairingInput.focus();
    return;
  }

  try {
    state.pairingTicket = parsePairingPayload(raw);
    state.pairingPhase = "connecting";
    state.pairingError = null;
    state.remoteAuth = null;
    state.session = null;
    state.threads = [];
    state.currentApprovalId = null;
    clearClaimLifecycle();
    clearSessionRuntime();
    rejectPendingActions("pairing restarted before broker actions completed");
    saveRemoteAuth(null);
    saveDeviceLabel(dom.deviceLabelInput.value);
    renderDeviceMeta();
    renderThreads([]);
    renderLog(
      auto
        ? `Starting pairing for ${state.pairingTicket.pairing_id} from scanned link.`
        : `Starting pairing for ${state.pairingTicket.pairing_id}.`
    );
    connectBroker("pairing request");
  } catch (error) {
    state.pairingPhase = "error";
    state.pairingError = error.message;
    renderDeviceMeta();
    renderLog(`Pairing input is invalid: ${error.message}`);
  }
}

export async function sendPairingRequest() {
  const ticket = state.pairingTicket;
  if (!ticket) {
    return;
  }

  state.pairingPhase = "requesting";
  state.pairingError = null;
  renderDeviceMeta();

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

export async function handleEncryptedPairingResult(payload) {
  if (!state.pairingTicket) {
    return;
  }

  if (
    payload.pairing_id !== state.pairingTicket.pairing_id ||
    payload.target_peer_id !== state.socketPeerId
  ) {
    return;
  }

  const result = await decryptJson(state.pairingTicket.pairing_secret, payload.envelope);
  if (!result.ok) {
    state.pairingPhase = "error";
    state.pairingError = result.error || "unknown pairing error";
    renderDeviceMeta();
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
  state.pairingPhase = null;
  state.pairingError = null;
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

export function forgetCurrentDevice() {
  state.pairingError = null;
  state.pairingPhase = null;
  state.pairingTicket = null;
  state.remoteAuth = null;
  state.session = null;
  state.currentApprovalId = null;
  state.threads = [];
  clearClaimLifecycle();
  clearSessionRuntime();
  rejectPendingActions("device was forgotten before broker actions completed");
  saveRemoteAuth(null);
  clearPairingQueryFromUrl();
  closeBrokerSocket();
  dom.pairingInput.value = "";
  resetRemoteSurface();
  renderLog("Forgot the stored remote device for this browser.");
}
