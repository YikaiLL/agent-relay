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
  pairingError: null,
  pairingPhase: null,
  pairingTicket: null,
  pendingActions: new Map(),
  remoteAuth: loadRemoteAuth(),
  requestedDeviceId: loadOrCreateRequestedDeviceId(),
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
    };
  }

  if (state.remoteAuth) {
    return {
      brokerUrl: state.remoteAuth.brokerUrl,
      brokerChannelId: state.remoteAuth.brokerChannelId,
    };
  }

  return null;
}

export function clearSessionClaim() {
  if (!state.remoteAuth) {
    return;
  }

  state.remoteAuth.sessionClaim = null;
  state.remoteAuth.sessionClaimExpiresAt = null;
  saveRemoteAuth(state.remoteAuth);
}

export function setSessionClaim(claim, expiresAt) {
  if (!state.remoteAuth) {
    return;
  }

  state.remoteAuth.sessionClaim = claim;
  state.remoteAuth.sessionClaimExpiresAt = expiresAt || null;
  saveRemoteAuth(state.remoteAuth);
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

function loadOrCreateRequestedDeviceId() {
  const existing = window.localStorage.getItem(REMOTE_REQUESTED_DEVICE_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const generated = `mobile-${generateStableId().slice(0, 12)}`;
  window.localStorage.setItem(REMOTE_REQUESTED_DEVICE_ID_STORAGE_KEY, generated);
  return generated;
}

function generateStableId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  if (window.crypto?.getRandomValues) {
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function loadRemoteAuth() {
  const raw = window.localStorage.getItem(REMOTE_AUTH_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      sessionClaim: parsed.sessionClaim || null,
      sessionClaimExpiresAt: parsed.sessionClaimExpiresAt || null,
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

  window.localStorage.setItem(REMOTE_AUTH_STORAGE_KEY, JSON.stringify(value));
}
