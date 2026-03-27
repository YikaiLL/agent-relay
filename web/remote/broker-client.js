import { renderLog, updateStatusBadge } from "./render.js";
import { connectionTarget, state } from "./state.js";

let onBrokerOpen = () => {};
let onBrokerPayload = async () => {};
let onBrokerDisconnect = () => {};
let onRelayPresence = () => {};

export function configureBrokerClient(handlers) {
  onBrokerOpen = handlers.onBrokerOpen || onBrokerOpen;
  onBrokerPayload = handlers.onBrokerPayload || onBrokerPayload;
  onBrokerDisconnect = handlers.onBrokerDisconnect || onBrokerDisconnect;
  onRelayPresence = handlers.onRelayPresence || onRelayPresence;
}

export function connectBroker(reason) {
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
    void onBrokerOpen(reason);
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
    void onBrokerDisconnect();
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

export function closeBrokerSocket(resetConnectionState = true) {
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
