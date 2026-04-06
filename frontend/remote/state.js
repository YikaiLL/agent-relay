import { ensureDeviceKeypair } from "./crypto.js";

const REMOTE_AUTH_STORAGE_KEY = "agent-relay.remote-auth";
const REMOTE_DEVICE_LABEL_STORAGE_KEY = "agent-relay.remote-device-label";
const REMOTE_REQUESTED_DEVICE_ID_STORAGE_KEY = "agent-relay.remote-device-id";

export const CONTROL_HEARTBEAT_MS = 5000;
export const LEASE_EXPIRY_REFRESH_SKEW_MS = 250;
export const CLAIM_REFRESH_SKEW_MS = 60_000;
export const CLAIM_REFRESH_FLOOR_MS = 5000;

export const state = {
  claimPromise: null,
  claimRefreshTimer: null,
  controllerHeartbeatTimer: null,
  controllerLeaseRefreshTimer: null,
  currentApprovalId: null,
  deviceIdentityPromise: null,
  deviceKeypair: null,
  pairingError: null,
  pairingPhase: null,
  pairingTicket: null,
  pendingActions: new Map(),
  recoverPromise: null,
  recoveredSocketPeerId: null,
  remoteAuth: loadRemoteAuth(),
  requestedDeviceId: null,
  session: null,
  socket: null,
  socketPeerId: null,
  socketConnected: false,
  socketReconnectTimer: null,
  threads: [],
};

export function connectionTarget() {
  if (state.pairingTicket) {
    return {
      brokerUrl: state.pairingTicket.broker_url,
      brokerChannelId: state.pairingTicket.broker_channel_id,
      joinTicket: state.pairingTicket.pairing_join_ticket,
    };
  }

  if (state.remoteAuth && hasUsableDeviceJoinTicket()) {
    return {
      brokerUrl: state.remoteAuth.brokerUrl,
      brokerChannelId: state.remoteAuth.brokerChannelId,
      joinTicket: state.remoteAuth.deviceJoinTicket,
    };
  }

  return null;
}

export function canRefreshDeviceJoinTicket() {
  return Boolean(
    state.remoteAuth?.deviceRefreshMode === "cookie" || state.remoteAuth?.deviceRefreshToken
  );
}

export function hasUsableDeviceJoinTicket(skewMs = 0) {
  const ticket = state.remoteAuth?.deviceJoinTicket;
  if (!ticket) {
    return false;
  }

  const expiresAt = state.remoteAuth?.deviceJoinTicketExpiresAt;
  if (!expiresAt) {
    return true;
  }

  return expiresAt * 1000 > Date.now() + skewMs;
}

export function hasExpiredDeviceJoinTicket() {
  const ticket = state.remoteAuth?.deviceJoinTicket;
  const expiresAt = state.remoteAuth?.deviceJoinTicketExpiresAt;
  return Boolean(ticket && expiresAt && expiresAt * 1000 <= Date.now());
}

export function clearSessionClaim() {
  if (!state.remoteAuth) {
    return;
  }

  state.remoteAuth.sessionClaim = null;
  state.remoteAuth.sessionClaimExpiresAt = null;
}

export function clearRecoveredSocketPeerId() {
  state.recoveredSocketPeerId = null;
}

export function setRecoveredSocketPeerId(value) {
  state.recoveredSocketPeerId = value || null;
}

export function setSessionClaim(claim, expiresAt) {
  if (!state.remoteAuth) {
    return;
  }

  state.remoteAuth.sessionClaim = claim;
  state.remoteAuth.sessionClaimExpiresAt = expiresAt || null;
}

export function setSocketPeerId(value) {
  state.socketPeerId = value || null;
}

export function clearSocketPeerId() {
  state.socketPeerId = null;
}

export function hasUsableSessionClaim(skewMs = 0) {
  const claim = state.remoteAuth?.sessionClaim;
  if (!claim) {
    return false;
  }

  const expiresAt = state.remoteAuth?.sessionClaimExpiresAt;
  if (!expiresAt) {
    return true;
  }

  return expiresAt * 1000 > Date.now() + skewMs;
}

export function loadDeviceLabel() {
  return (
    window.localStorage.getItem(REMOTE_DEVICE_LABEL_STORAGE_KEY)?.trim() ||
    defaultDeviceLabel()
  );
}

export function saveDeviceLabel(value) {
  const label = value.trim();
  if (!label) {
    window.localStorage.removeItem(REMOTE_DEVICE_LABEL_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(REMOTE_DEVICE_LABEL_STORAGE_KEY, label);
}

export function normalizedDeviceLabel(rawValue) {
  const label = rawValue.trim() || defaultDeviceLabel();
  saveDeviceLabel(label);
  return label;
}

function defaultDeviceLabel() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "Browser";
  return `${platform} Remote`;
}

export async function ensureDeviceIdentity() {
  if (state.deviceKeypair && state.requestedDeviceId) {
    return state.deviceKeypair;
  }
  if (state.deviceIdentityPromise) {
    return state.deviceIdentityPromise;
  }

  state.deviceIdentityPromise = (async () => {
    const deviceKeypair = await ensureDeviceKeypair();
    state.deviceKeypair = deviceKeypair;
    state.requestedDeviceId = loadOrCreateRequestedDeviceId(deviceKeypair.verifyKey);
    return deviceKeypair;
  })();

  try {
    return await state.deviceIdentityPromise;
  } finally {
    state.deviceIdentityPromise = null;
  }
}

export function candidateDeviceTokens() {
  return state.remoteAuth?.payloadSecret ? [state.remoteAuth.payloadSecret] : [];
}

function loadOrCreateRequestedDeviceId(verifyKey) {
  const existing = window.localStorage.getItem(REMOTE_REQUESTED_DEVICE_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const fingerprint = verifyKey
    .replaceAll("/", "")
    .replaceAll("+", "")
    .replaceAll("=", "")
    .toLowerCase();
  const generated = `mobile-${fingerprint.slice(0, 12)}`;
  window.localStorage.setItem(REMOTE_REQUESTED_DEVICE_ID_STORAGE_KEY, generated);
  return generated;
}

function loadRemoteAuth() {
  const raw = window.localStorage.getItem(REMOTE_AUTH_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed?.brokerUrl ||
      !parsed?.brokerChannelId ||
      !parsed?.deviceId ||
      !parsed?.payloadSecret
    ) {
      window.localStorage.removeItem(REMOTE_AUTH_STORAGE_KEY);
      return null;
    }
    return {
      brokerUrl: parsed.brokerUrl,
      brokerChannelId: parsed.brokerChannelId,
      relayPeerId: parsed.relayPeerId || null,
      securityMode: parsed.securityMode || "private",
      deviceId: parsed.deviceId,
      deviceLabel: parsed.deviceLabel || defaultDeviceLabel(),
      payloadSecret: parsed.payloadSecret,
      deviceRefreshMode: parsed.deviceRefreshMode === "cookie" ? "cookie" : null,
      deviceRefreshToken: parsed.deviceRefreshToken || null,
      deviceJoinTicket: null,
      deviceJoinTicketExpiresAt: null,
      sessionClaim: null,
      sessionClaimExpiresAt: null,
    };
  } catch {
    window.localStorage.removeItem(REMOTE_AUTH_STORAGE_KEY);
    return null;
  }
}

export function saveRemoteAuth(value) {
  if (!value) {
    window.localStorage.removeItem(REMOTE_AUTH_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(
    REMOTE_AUTH_STORAGE_KEY,
    JSON.stringify({
      brokerUrl: value.brokerUrl,
      brokerChannelId: value.brokerChannelId,
      relayPeerId: value.relayPeerId || null,
      securityMode: value.securityMode || "private",
      deviceId: value.deviceId,
      deviceLabel: value.deviceLabel || null,
      payloadSecret: value.payloadSecret,
      deviceRefreshMode: value.deviceRefreshMode === "cookie" ? "cookie" : null,
    })
  );
}

export function brokerControlUrl(brokerUrl) {
  const url = new URL(brokerUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}
