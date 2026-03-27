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

export async function beginPairing(rawValue) {
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
    clearSessionRuntime();
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

export async function sendPairingRequest() {
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

export async function handleEncryptedPairingResult(payload) {
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

export function forgetCurrentDevice() {
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
