import { renderLog, updateStatusBadge } from "./render.js";
import {
  brokerControlUrl,
  canRefreshDeviceJoinTicket,
  clearSocketPeerId,
  connectionTarget,
  hasExpiredDeviceJoinTicket,
  setSocketPeerId,
  saveRemoteAuth,
  state,
} from "./state.js";

let onBrokerReady = () => {};
let onBrokerPayload = async () => {};
let onBrokerDisconnect = () => {};
let onRelayPresence = () => {};

export function configureBrokerClient(handlers) {
  onBrokerReady = handlers.onBrokerReady || onBrokerReady;
  onBrokerPayload = handlers.onBrokerPayload || onBrokerPayload;
  onBrokerDisconnect = handlers.onBrokerDisconnect || onBrokerDisconnect;
  onRelayPresence = handlers.onRelayPresence || onRelayPresence;
}

export async function connectBroker(reason) {
  if (!state.pairingTicket && state.remoteAuth && !connectionTarget() && canRefreshDeviceJoinTicket()) {
    try {
      await refreshDeviceJoinTicket(reason);
    } catch (error) {
      renderLog(`Device broker token refresh failed: ${error.message}`);
      return;
    }
  }

  const target = connectionTarget();
  if (!target) {
    if (hasExpiredDeviceJoinTicket()) {
      renderLog(
        canRefreshDeviceJoinTicket()
          ? "Saved device broker access could not be refreshed."
          : "Saved device broker access has expired. Re-pair this device to reconnect."
      );
      return;
    }
    renderLog("Broker connect skipped because no pairing or saved device is present.");
    return;
  }

  cancelSocketReconnect();
  closeBrokerSocket(false);

  const url = new URL(target.brokerUrl);
  url.pathname = `/ws/${encodeURIComponent(target.brokerChannelId)}`;
  url.searchParams.set("role", "surface");
  if (!target.joinTicket) {
    renderLog("Broker connect skipped because no join ticket is stored for this device.");
    return;
  }
  url.searchParams.set("join_ticket", target.joinTicket);

  renderLog(`Connecting to broker (${reason}) via ${url.host}.`);
  const socket = new WebSocket(url.toString());
  state.socket = socket;
  clearSocketPeerId();

  socket.addEventListener("open", () => {
    if (state.socket !== socket) {
      return;
    }

    state.socketConnected = true;
    updateStatusBadge();
    renderLog("Broker websocket connected.");
  });

  socket.addEventListener("message", (event) => {
    if (state.socket !== socket) {
      return;
    }

    void handleSocketMessage(event.data, reason);
  });

  socket.addEventListener("close", (event) => {
    if (state.socket !== socket) {
      return;
    }

    state.socket = null;
    state.socketConnected = false;
    clearSocketPeerId();
    void onBrokerDisconnect();
    updateStatusBadge();
    renderLog(
      `Broker websocket closed${event.code ? ` (${event.code}${event.reason ? `: ${event.reason}` : ""})` : ""}.`
    );
    scheduleSocketReconnect();
  });

  socket.addEventListener("error", () => {
    if (state.socket !== socket) {
      return;
    }

    renderLog("Broker websocket hit an error.");
  });
}

export function closeBrokerSocket(resetConnectionState = true) {
  if (!state.socket) {
    if (resetConnectionState) {
      state.socketConnected = false;
      clearSocketPeerId();
      updateStatusBadge();
    }
    return;
  }

  const socket = state.socket;
  state.socket = null;
  socket.close();

  if (resetConnectionState) {
    state.socketConnected = false;
    clearSocketPeerId();
    updateStatusBadge();
  }
}

export function sendBrokerFrame(payload) {
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

async function handleSocketMessage(rawData, connectReason) {
  let frame;
  try {
    frame = JSON.parse(rawData);
  } catch (error) {
    renderLog(`Broker frame parse failed: ${error.message}`);
    return;
  }

  if (frame.type === "welcome") {
    setSocketPeerId(frame.peer_id || null);
    renderLog(
      `Joined broker channel ${frame.channel_id} as ${frame.peer_id || "unknown-peer"}.`
    );
    void onBrokerReady(frame, connectReason);
    return;
  }

  if (frame.type === "presence") {
    if (frame.peer?.role === "relay") {
      renderLog(`Relay peer ${frame.peer.peer_id} ${frame.kind}.`);
      void onRelayPresence(frame.kind, frame.peer);
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

  await onBrokerPayload(frame.payload);
}

function scheduleSocketReconnect() {
  if (!connectionTarget() && !canRefreshDeviceJoinTicket()) {
    return;
  }

  cancelSocketReconnect();
  state.socketReconnectTimer = window.setTimeout(() => {
    void connectBroker("reconnect");
  }, 1500);
}

function cancelSocketReconnect() {
  if (!state.socketReconnectTimer) {
    return;
  }

  window.clearTimeout(state.socketReconnectTimer);
  state.socketReconnectTimer = null;
}

async function refreshDeviceJoinTicket(reason) {
  if (!state.remoteAuth?.deviceRefreshToken) {
    throw new Error("no device refresh token is stored");
  }

  const url = new URL("/api/public/device/ws-token", brokerControlUrl(state.remoteAuth.brokerUrl));
  renderLog(`Refreshing broker access token (${reason}).`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.remoteAuth.deviceRefreshToken}`,
    },
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || "broker token refresh failed");
  }

  state.remoteAuth.deviceJoinTicket = payload.device_ws_token;
  state.remoteAuth.deviceJoinTicketExpiresAt = payload.device_ws_token_expires_at || null;
  saveRemoteAuth(state.remoteAuth);
  renderLog("Refreshed broker access token for this device.");
}
