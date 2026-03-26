const SURFACE_PEER_STORAGE_KEY = "agent-relay.remote-peer-id";
const REMOTE_AUTH_STORAGE_KEY = "agent-relay.remote-auth";
const REMOTE_DEVICE_LABEL_STORAGE_KEY = "agent-relay.remote-device-label";
const REMOTE_REQUESTED_DEVICE_ID_STORAGE_KEY = "agent-relay.remote-device-id";
const CONTROL_HEARTBEAT_MS = 5000;
const LEASE_EXPIRY_REFRESH_SKEW_MS = 250;

const state = {
  controllerHeartbeatTimer: null,
  controllerLeaseRefreshTimer: null,
  currentApprovalId: null,
  pairingTicket: null,
  remoteAuth: loadRemoteAuth(),
  requestedDeviceId: loadOrCreateRequestedDeviceId(),
  session: null,
  socket: null,
  socketConnected: false,
  socketReconnectTimer: null,
  surfacePeerId: loadOrCreateSurfacePeerId(),
  threads: [],
};

const pairingForm = document.querySelector("#pairing-form");
const pairingInput = document.querySelector("#pairing-input");
const deviceLabelInput = document.querySelector("#device-label-input");
const connectButton = document.querySelector("#connect-button");
const forgetDeviceButton = document.querySelector("#forget-device-button");
const remoteSessionToggle = document.querySelector("#remote-session-toggle");
const remoteSessionPanel = document.querySelector("#remote-session-panel");
const remoteStartSessionButton = document.querySelector("#remote-start-session-button");
const remoteCwdInput = document.querySelector("#remote-cwd-input");
const remoteStartPromptInput = document.querySelector("#remote-start-prompt");
const remoteModelInput = document.querySelector("#remote-model-input");
const remoteApprovalPolicyInput = document.querySelector("#remote-approval-policy-input");
const remoteSandboxInput = document.querySelector("#remote-sandbox-input");
const remoteStartEffortInput = document.querySelector("#remote-start-effort");
const remoteThreadsRefreshButton = document.querySelector("#remote-threads-refresh-button");
const remoteThreadsCount = document.querySelector("#remote-threads-count");
const remoteThreadsCwdInput = document.querySelector("#remote-threads-cwd-input");
const remoteThreadsList = document.querySelector("#remote-threads-list");
const deviceMeta = document.querySelector("#device-meta");
const remoteWorkspaceTitle = document.querySelector("#remote-workspace-title");
const remoteWorkspaceSubtitle = document.querySelector("#remote-workspace-subtitle");
const remoteStatusBadge = document.querySelector("#remote-status-badge");
const remoteSessionMeta = document.querySelector("#remote-session-meta");
const remoteControlBanner = document.querySelector("#remote-control-banner");
const remoteControlSummary = document.querySelector("#remote-control-summary");
const remoteControlHint = document.querySelector("#remote-control-hint");
const remoteTakeOverButton = document.querySelector("#remote-take-over-button");
const remoteTranscript = document.querySelector("#remote-transcript");
const remoteMessageForm = document.querySelector("#remote-message-form");
const remoteMessageInput = document.querySelector("#remote-message-input");
const remoteMessageEffort = document.querySelector("#remote-message-effort");
const remoteSendButton = document.querySelector("#remote-send-button");
const remoteClientLog = document.querySelector("#remote-client-log");

pairingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void beginPairing(pairingInput.value);
});

forgetDeviceButton.addEventListener("click", () => {
  forgetCurrentDevice();
});

remoteSessionToggle.addEventListener("click", () => {
  setRemoteSessionPanelOpen(remoteSessionPanel.hidden);
});

remoteStartSessionButton.addEventListener("click", () => {
  void startRemoteSession();
});

remoteThreadsRefreshButton.addEventListener("click", () => {
  void refreshRemoteThreads("manual refresh");
});

remoteTakeOverButton.addEventListener("click", () => {
  void takeOverControl();
});

remoteMessageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendMessage();
});

remoteTranscript.addEventListener("click", (event) => {
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
    logLine("Secure browser crypto is unavailable. Use HTTPS or localhost for remote pairing.");
  }

  deviceLabelInput.value = loadDeviceLabel();
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
    pairingInput.value = raw;
    logLine(`Loaded pairing ticket ${state.pairingTicket.pairing_id} from URL.`);
  } catch (error) {
    logLine(`Invalid pairing URL: ${error.message}`);
  }
}

async function beginPairing(rawValue) {
  const raw = rawValue.trim();
  if (!raw) {
    logLine("Paste a pairing link or code first.");
    pairingInput.focus();
    return;
  }

  try {
    state.pairingTicket = parsePairingPayload(raw);
    state.remoteAuth = null;
    state.threads = [];
    saveRemoteAuth(null);
    saveDeviceLabel(deviceLabelInput.value);
    renderDeviceMeta();
    renderThreads([]);
    connectBroker("pairing request");
  } catch (error) {
    logLine(`Pairing input is invalid: ${error.message}`);
  }
}

function connectBroker(reason) {
  const target = connectionTarget();
  if (!target) {
    logLine("Broker connect skipped because no pairing or saved device is present.");
    return;
  }

  cancelSocketReconnect();
  closeBrokerSocket(false);

  const url = new URL(target.brokerUrl);
  url.pathname = `/ws/${encodeURIComponent(target.brokerChannelId)}`;
  url.searchParams.set("peer_id", state.surfacePeerId);
  url.searchParams.set("role", "surface");

  logLine(`Connecting to broker (${reason}).`);
  const socket = new WebSocket(url.toString());
  state.socket = socket;

  socket.addEventListener("open", () => {
    if (state.socket !== socket) {
      return;
    }

    state.socketConnected = true;
    updateStatusBadge();
    logLine("Broker websocket connected.");

    if (state.pairingTicket) {
      void sendPairingRequest();
      return;
    }

    if (state.remoteAuth) {
      void syncRemoteSnapshot();
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
    updateStatusBadge();
    logLine("Broker websocket closed.");
    scheduleSocketReconnect();
  });

  socket.addEventListener("error", () => {
    if (state.socket !== socket) {
      return;
    }

    logLine("Broker websocket hit an error.");
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
    logLine(`Broker frame parse failed: ${error.message}`);
    return;
  }

  if (frame.type === "welcome") {
    logLine(`Joined broker channel ${frame.channel_id}.`);
    return;
  }

  if (frame.type === "presence") {
    if (frame.peer?.role === "relay") {
      logLine(`Relay peer ${frame.peer.peer_id} ${frame.kind}.`);
    }
    return;
  }

  if (frame.type === "error") {
    logLine(`Broker error: ${frame.message}`);
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
    renderSession(payload.snapshot);
    logLine("Received managed-mode session snapshot from broker.");
    return;
  }

  if (kind === "remote_action_result") {
    handleRemoteActionResult(payload);
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
      device_label: normalizedDeviceLabel(),
    }),
  };

  sendBrokerFrame(payload);
  logLine(`Sent pairing request for ${ticket.pairing_id}.`);
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
    logLine(`Pairing failed: ${result.error || "unknown pairing error"}`);
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
  };
  saveRemoteAuth(state.remoteAuth);
  state.pairingTicket = null;
  pairingInput.value = "";
  clearPairingQueryFromUrl();
  renderDeviceMeta();
  logLine(`Paired remote device ${device.label} (${shortId(device.device_id)}).`);
  await syncRemoteSnapshot();
}

async function handleEncryptedSessionSnapshot(payload) {
  if (
    payload.target_peer_id !== state.surfacePeerId ||
    payload.device_id !== state.remoteAuth?.deviceId
  ) {
    return;
  }

  const snapshot = await decryptJson(state.remoteAuth.deviceToken, payload.envelope);
  renderSession(snapshot);
}

async function handleEncryptedRemoteActionResult(payload) {
  if (
    payload.target_peer_id !== state.surfacePeerId ||
    payload.device_id !== state.remoteAuth?.deviceId
  ) {
    return;
  }

  const result = await decryptJson(state.remoteAuth.deviceToken, payload.envelope);
  handleRemoteActionResult(result);
}

function handleRemoteActionResult(result) {
  if (result.snapshot) {
    renderSession(result.snapshot);
  }

  if (result.threads?.threads) {
    state.threads = result.threads.threads;
    renderThreads(state.threads);
  }

  if (result.ok) {
    if (result.receipt?.message) {
      logLine(result.receipt.message);
    } else {
      logLine(`Remote ${result.action} succeeded.`);
    }
    return;
  }

  logLine(`Remote ${result.action} failed: ${result.error || "unknown error"}`);
}

async function syncRemoteSnapshot() {
  if (!state.remoteAuth) {
    return;
  }

  await sendRemoteAction("heartbeat", {
    input: {},
  });
  await refreshRemoteThreads("snapshot sync");
}

async function startRemoteSession() {
  const cwd = remoteCwdInput.value.trim();
  if (!cwd) {
    logLine("Choose a workspace before starting a remote session.");
    remoteCwdInput.focus();
    return;
  }

  remoteStartSessionButton.disabled = true;
  logLine(`Starting remote session in ${cwd}.`);

  try {
    await sendRemoteAction("start_session", {
      input: {
        cwd,
        initial_prompt: remoteStartPromptInput.value.trim() || null,
        model: remoteModelInput.value.trim() || null,
        approval_policy: remoteApprovalPolicyInput.value,
        sandbox: remoteSandboxInput.value,
        effort: remoteStartEffortInput.value,
      },
    });
    setRemoteSessionPanelOpen(false);
    await refreshRemoteThreads("post-start refresh");
  } catch (error) {
    logLine(`Remote start failed: ${error.message}`);
  } finally {
    remoteStartSessionButton.disabled = false;
  }
}

async function refreshRemoteThreads(reason) {
  if (!state.remoteAuth) {
    renderThreads([]);
    return;
  }

  remoteThreadsRefreshButton.disabled = true;
  remoteThreadsCount.textContent = "Loading...";
  logLine(`Fetching remote thread list (${reason}).`);

  try {
    await sendRemoteAction("list_threads", {
      query: {
        cwd: remoteThreadsCwdInput.value.trim() || null,
        limit: 80,
      },
    });
  } catch (error) {
    remoteThreadsCount.textContent = "Error";
    remoteThreadsList.innerHTML = `<p class="sidebar-empty">${escapeHtml(error.message)}</p>`;
    logLine(`Remote thread refresh failed: ${error.message}`);
  } finally {
    remoteThreadsRefreshButton.disabled = false;
  }
}

async function resumeRemoteSession(threadId) {
  if (!threadId) {
    return;
  }

  logLine(`Resuming remote thread ${threadId}.`);

  try {
    await sendRemoteAction("resume_session", {
      input: {
        thread_id: threadId,
        approval_policy: remoteApprovalPolicyInput.value,
        sandbox: remoteSandboxInput.value,
        effort: remoteStartEffortInput.value,
      },
    });
    await refreshRemoteThreads("post-resume refresh");
  } catch (error) {
    logLine(`Remote resume failed: ${error.message}`);
  }
}

async function sendMessage() {
  const text = remoteMessageInput.value.trim();
  if (!text) {
    logLine("Message is empty.");
    return;
  }

  remoteSendButton.disabled = true;

  try {
    await sendRemoteAction("send_message", {
      input: {
        text,
        effort: remoteMessageEffort.value,
      },
    });
    remoteMessageInput.value = "";
  } catch (error) {
    logLine(`Remote send failed: ${error.message}`);
  } finally {
    remoteSendButton.disabled = false;
  }
}

async function takeOverControl() {
  try {
    await sendRemoteAction("take_over", {
      input: {},
    });
  } catch (error) {
    logLine(`Take over failed: ${error.message}`);
  }
}

async function submitDecision(decision, scope) {
  if (!state.currentApprovalId) {
    logLine("No pending approval to submit.");
    return;
  }

  try {
    await sendRemoteAction("decide_approval", {
      request_id: state.currentApprovalId,
      input: {
        decision,
        scope,
      },
    });
  } catch (error) {
    logLine(`Approval failed: ${error.message}`);
  }
}

async function sendRemoteAction(actionType, request) {
  if (!state.remoteAuth) {
    throw new Error("this browser is not paired yet");
  }
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    throw new Error("broker socket is not connected");
  }

  const actionId = `act-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

  if (state.remoteAuth.securityMode === "managed") {
    sendBrokerFrame({
      kind: "remote_action",
      action_id: actionId,
      auth: {
        device_id: state.remoteAuth.deviceId,
        device_token: state.remoteAuth.deviceToken,
      },
      request: {
        type: actionType,
        ...request,
      },
    });
    return actionId;
  }

  sendBrokerFrame({
    kind: "encrypted_remote_action",
    action_id: actionId,
    device_id: state.remoteAuth.deviceId,
    envelope: await encryptJson(state.remoteAuth.deviceToken, {
      type: actionType,
      ...request,
    }),
  });
  return actionId;
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

function renderSession(session) {
  state.session = session;
  const approval = session.pending_approvals?.[0] || null;
  const hasActiveSession = Boolean(session.active_thread_id);
  const canWrite = canCurrentDeviceWrite(session);
  state.currentApprovalId = approval?.request_id || null;

  if (session.current_cwd && !remoteThreadsCwdInput.value.trim()) {
    remoteThreadsCwdInput.value = session.current_cwd;
  }

  remoteWorkspaceTitle.textContent = hasActiveSession
    ? shortId(session.active_thread_id)
    : "Remote surface ready";
  remoteWorkspaceSubtitle.textContent = hasActiveSession
    ? session.current_cwd
    : "Pair this browser and either wait for a live session or start one from the sidebar.";

  if (approval) {
    remoteStatusBadge.textContent = "Approval required";
    remoteStatusBadge.className = "status-badge status-badge-alert";
  } else if (!state.socketConnected || !session.codex_connected) {
    remoteStatusBadge.textContent = "Offline";
    remoteStatusBadge.className = "status-badge status-badge-offline";
  } else {
    remoteStatusBadge.textContent = session.current_status || "Ready";
    remoteStatusBadge.className = "status-badge status-badge-ready";
  }

  renderSessionMeta(session);
  renderControlBanner(session);
  renderTranscript(session.transcript || [], approval);
  renderLogs(session.logs || []);
  renderThreads(state.threads);
  scheduleControllerHeartbeat(session);
  scheduleControllerLeaseRefresh(session);

  remoteSendButton.disabled = !hasActiveSession || !canWrite;
  remoteMessageInput.disabled = !hasActiveSession || !canWrite;
  remoteMessageInput.placeholder = !hasActiveSession
    ? "Start a remote session first."
    : canWrite
      ? "Message Codex remotely..."
      : "Another device has control. Take over to reply.";
}

function renderThreads(threads) {
  const filterValue = remoteThreadsCwdInput.value.trim();
  const activeThreadId = state.session?.active_thread_id || null;

  if (!state.remoteAuth) {
    remoteThreadsCount.textContent = "Remote session history";
    remoteThreadsList.innerHTML = `<p class="sidebar-empty">Pair a device, then refresh remote history.</p>`;
    return;
  }

  remoteThreadsCount.textContent = `${threads.length} ${threads.length === 1 ? "session" : "sessions"}`;

  if (!threads.length) {
    remoteThreadsList.innerHTML = filterValue
      ? `<p class="sidebar-empty">No remote sessions found for this workspace filter.</p>`
      : `<p class="sidebar-empty">No remote sessions found yet.</p>`;
    return;
  }

  remoteThreadsList.innerHTML = threads
    .map((thread) => {
      const title = thread.name || thread.preview || shortId(thread.id);
      const activeClass = activeThreadId === thread.id ? " is-active" : "";

      return `
        <button class="conversation-item${activeClass}" type="button" data-thread-id="${escapeHtml(thread.id)}">
          <span class="conversation-title">${escapeHtml(title)}</span>
          <span class="conversation-preview">${escapeHtml(thread.preview || "No preview yet.")}</span>
          <span class="conversation-meta">${escapeHtml(formatTimestamp(thread.updated_at))}</span>
        </button>
      `;
    })
    .join("");

  remoteThreadsList.querySelectorAll("[data-thread-id]").forEach((button) => {
    button.addEventListener("click", () => {
      void resumeRemoteSession(button.dataset.threadId);
    });
  });
}

function renderSessionMeta(session) {
  remoteSessionMeta.innerHTML = [
    metaChip("Security", securityModeLabel(session)),
    metaChip("Visibility", contentVisibilityLabel(session)),
    metaChip("Broker", brokerStatusLabel(session)),
    metaChip("Device", state.remoteAuth?.deviceLabel || "Unpaired"),
    metaChip(
      "Control",
      session.active_controller_device_id
        ? controllerLabel(session.active_controller_device_id)
        : "Unclaimed"
    ),
    session.active_thread_id
      ? metaChip("Thread", shortId(session.active_thread_id))
      : `<span class="meta-empty">No live session yet.</span>`,
  ].join("");
}

function renderControlBanner(session) {
  if (!session.active_thread_id) {
    remoteControlBanner.hidden = true;
    return;
  }

  remoteControlBanner.hidden = false;

  if (!session.active_controller_device_id) {
    remoteControlSummary.textContent = "No device currently has control";
    remoteControlHint.textContent = "The next paired device to send a message will claim control.";
    remoteTakeOverButton.hidden = true;
    return;
  }

  if (isCurrentDeviceActiveController(session)) {
    remoteControlSummary.textContent = "This remote device has control";
    remoteControlHint.textContent = "You can type here. Other paired devices can still approve pending actions.";
    remoteTakeOverButton.hidden = true;
    return;
  }

  remoteControlSummary.textContent = `Another device has control (${controllerLabel(session.active_controller_device_id)})`;
  remoteControlHint.textContent = "You can still approve from this browser. Take over when you want to type.";
  remoteTakeOverButton.hidden = false;
}

function renderTranscript(entries, approval) {
  if (!entries.length && !approval) {
    renderEmptyState();
    return;
  }

  const items = entries.map(renderEntry);
  if (approval) {
    items.push(renderApprovalCard(approval));
  }

  remoteTranscript.innerHTML = `<div class="thread-content">${items.join("")}</div>`;
  remoteTranscript.scrollTop = remoteTranscript.scrollHeight;
}

function renderEntry(entry) {
  const role = entry.role || "system";

  if (role === "user") {
    return `
      <article class="chat-message chat-message-user">
        <div class="message-card">
          <div class="message-meta">
            <strong>You</strong>
            <span>${escapeHtml(entry.status || "completed")}</span>
          </div>
          <div class="message-body">${escapeHtml(entry.text || "(empty)")}</div>
        </div>
      </article>
    `;
  }

  if (role === "assistant") {
    return `
      <article class="chat-message chat-message-assistant">
        <div class="message-avatar">C</div>
        <div class="message-card">
          <div class="message-meta">
            <strong>Codex</strong>
            <span>${escapeHtml(entry.status || "completed")}</span>
            <span>${escapeHtml(shortId(entry.turn_id || ""))}</span>
          </div>
          <div class="message-body">${escapeHtml(entry.text || "(empty)")}</div>
        </div>
      </article>
    `;
  }

  return `
    <article class="chat-message chat-message-system">
      <div class="message-card message-card-system">
        <div class="message-meta">
          <strong>${escapeHtml(roleLabel(role))}</strong>
          <span>${escapeHtml(entry.status || "completed")}</span>
        </div>
        <pre class="message-pre">${escapeHtml(entry.text || "(empty)")}</pre>
      </div>
    </article>
  `;
}

function renderApprovalCard(approval) {
  return `
    <article class="chat-message chat-message-system">
      <div class="message-card message-card-approval">
        <div class="message-meta">
          <strong>Approval required</strong>
          <span>${escapeHtml(approval.kind)}</span>
        </div>
        <h3 class="approval-title">${escapeHtml(approval.summary)}</h3>
        <p class="approval-copy">${escapeHtml(approval.detail || "Codex is waiting for a remote approval.")}</p>
        ${approval.cwd ? `<p class="approval-copy">cwd: ${escapeHtml(approval.cwd)}</p>` : ""}
        ${approval.command ? `<pre class="message-pre">${escapeHtml(approval.command)}</pre>` : ""}
        ${
          approval.requested_permissions
            ? `<pre class="message-pre">${escapeHtml(JSON.stringify(approval.requested_permissions, null, 2))}</pre>`
            : ""
        }
        <div class="approval-actions">
          <button class="approval-button approval-button-primary" type="button" data-approval-decision="approve" data-approval-scope="once">
            Approve
          </button>
          ${
            approval.supports_session_scope
              ? `<button class="approval-button" type="button" data-approval-decision="approve" data-approval-scope="session">Approve Session</button>`
              : ""
          }
          <button class="approval-button approval-button-danger" type="button" data-approval-decision="deny" data-approval-scope="once">
            Deny
          </button>
        </div>
      </div>
    </article>
  `;
}

function renderLogs(entries) {
  remoteClientLog.textContent = entries
    .map(
      (entry) =>
        `${new Date(entry.created_at * 1000).toLocaleTimeString()}  [${entry.kind}] ${entry.message}`
    )
    .join("\n");
}

function renderDeviceMeta() {
  if (!state.remoteAuth && !state.pairingTicket) {
    deviceMeta.innerHTML = `<p class="sidebar-empty">No paired remote device stored in this browser.</p>`;
    return;
  }

  const rows = [];

  if (state.pairingTicket) {
    rows.push(`
      <article class="paired-device-card">
        <div class="paired-device-copy">
          <strong>Pending Pairing</strong>
          <p class="paired-device-meta">${escapeHtml(shortId(state.pairingTicket.pairing_id))} · expires ${escapeHtml(formatTimestamp(state.pairingTicket.expires_at))}</p>
        </div>
      </article>
    `);
  }

  if (state.remoteAuth) {
    rows.push(`
      <article class="paired-device-card">
        <div class="paired-device-copy">
          <strong>${escapeHtml(state.remoteAuth.deviceLabel)}</strong>
          <p class="paired-device-meta">${escapeHtml(shortId(state.remoteAuth.deviceId))} · ${escapeHtml(state.remoteAuth.securityMode)}</p>
          <p class="paired-device-meta">${escapeHtml(state.remoteAuth.brokerChannelId)} · ${escapeHtml(shortId(state.remoteAuth.relayPeerId))}</p>
        </div>
      </article>
    `);
  }

  deviceMeta.innerHTML = rows.join("");
}

function renderEmptyState() {
  remoteTranscript.innerHTML = `
    <div class="thread-empty">
      <h2>No remote session yet</h2>
      <p>After pairing, this page will stream the live relay transcript through the broker.</p>
    </div>
  `;
}

function setRemoteSessionPanelOpen(open) {
  remoteSessionPanel.hidden = !open;
  remoteSessionToggle.setAttribute("aria-expanded", String(open));
  remoteSessionToggle.textContent = open ? "Close Remote Session Setup" : "Start Remote Session";
}

function forgetCurrentDevice() {
  state.pairingTicket = null;
  state.remoteAuth = null;
  state.session = null;
  state.currentApprovalId = null;
  state.threads = [];
  saveRemoteAuth(null);
  clearPairingQueryFromUrl();
  cancelControllerHeartbeat();
  cancelControllerLeaseRefresh();
  closeBrokerSocket();
  renderDeviceMeta();
  renderThreads([]);
  renderEmptyState();
  remoteSessionMeta.innerHTML = `<span class="meta-empty">Pair a remote device to start streaming session details.</span>`;
  remoteControlBanner.hidden = true;
  remoteWorkspaceTitle.textContent = "Pair this browser";
  remoteWorkspaceSubtitle.textContent = "Open a pairing QR from your local relay to control Codex remotely.";
  pairingInput.value = "";
  updateStatusBadge();
  logLine("Forgot the stored remote device for this browser.");
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
    await sendRemoteAction("heartbeat", {
      input: {},
    });
  } catch (error) {
    logLine(`Remote heartbeat failed: ${error.message}`);
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
    renderSession(next);
    logLine("Remote control lease expired locally. The next sender can reclaim control.");
  }, delayMs);
}

function cancelControllerLeaseRefresh() {
  if (!state.controllerLeaseRefreshTimer) {
    return;
  }

  window.clearTimeout(state.controllerLeaseRefreshTimer);
  state.controllerLeaseRefreshTimer = null;
}

function updateStatusBadge() {
  if (state.session) {
    if (state.session.pending_approvals?.length) {
      remoteStatusBadge.textContent = "Approval required";
      remoteStatusBadge.className = "status-badge status-badge-alert";
      return;
    }

    if (!state.socketConnected || !state.session.codex_connected) {
      remoteStatusBadge.textContent = "Offline";
      remoteStatusBadge.className = "status-badge status-badge-offline";
      return;
    }

    remoteStatusBadge.textContent = state.session.current_status || "Ready";
    remoteStatusBadge.className = "status-badge status-badge-ready";
    return;
  }

  if (state.socketConnected) {
    remoteStatusBadge.textContent = "Connected";
    remoteStatusBadge.className = "status-badge status-badge-ready";
    return;
  }

  remoteStatusBadge.textContent = connectionTarget() ? "Connecting" : "Offline";
  remoteStatusBadge.className = "status-badge status-badge-offline";
}

function connectionTarget() {
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

function loadOrCreateSurfacePeerId() {
  const existing = window.localStorage.getItem(SURFACE_PEER_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const generated = `surface-${window.crypto.randomUUID()}`;
  window.localStorage.setItem(SURFACE_PEER_STORAGE_KEY, generated);
  return generated;
}

function loadOrCreateRequestedDeviceId() {
  const existing = window.localStorage.getItem(REMOTE_REQUESTED_DEVICE_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const generated = `mobile-${window.crypto.randomUUID().slice(0, 12)}`;
  window.localStorage.setItem(REMOTE_REQUESTED_DEVICE_ID_STORAGE_KEY, generated);
  return generated;
}

function loadRemoteAuth() {
  const raw = window.localStorage.getItem(REMOTE_AUTH_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    window.localStorage.removeItem(REMOTE_AUTH_STORAGE_KEY);
    return null;
  }
}

function saveRemoteAuth(value) {
  if (!value) {
    window.localStorage.removeItem(REMOTE_AUTH_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(REMOTE_AUTH_STORAGE_KEY, JSON.stringify(value));
}

function loadDeviceLabel() {
  return (
    window.localStorage.getItem(REMOTE_DEVICE_LABEL_STORAGE_KEY)?.trim() ||
    defaultDeviceLabel()
  );
}

function saveDeviceLabel(value) {
  const label = value.trim();
  if (!label) {
    window.localStorage.removeItem(REMOTE_DEVICE_LABEL_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(REMOTE_DEVICE_LABEL_STORAGE_KEY, label);
}

function normalizedDeviceLabel() {
  const label = deviceLabelInput.value.trim() || defaultDeviceLabel();
  saveDeviceLabel(label);
  return label;
}

function defaultDeviceLabel() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "Browser";
  return `${platform} Remote`;
}

function parsePairingPayload(rawInput) {
  let raw = rawInput.trim();

  try {
    const url = new URL(raw);
    raw = url.searchParams.get("pairing") || raw;
  } catch {
    if (raw.startsWith("pairing=")) {
      raw = raw.slice("pairing=".length);
    }
  }

  const json = new TextDecoder().decode(base64UrlToBytes(raw));
  const payload = JSON.parse(json);

  if (!payload.pairing_id || !payload.pairing_secret || !payload.broker_url) {
    throw new Error("pairing payload is missing required fields");
  }

  return payload;
}

function clearPairingQueryFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("pairing")) {
    return;
  }
  url.searchParams.delete("pairing");
  window.history.replaceState({}, "", url);
}

async function encryptJson(secret, value) {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const key = await importSecretKey(secret);
  const nonce = window.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
    },
    key,
    plaintext
  );

  return {
    nonce: bytesToBase64(new Uint8Array(nonce)),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptJson(secret, envelope) {
  const key = await importSecretKey(secret);
  const plaintext = await window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(envelope.nonce),
    },
    key,
    base64ToBytes(envelope.ciphertext)
  );

  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function importSecretKey(secret) {
  const digest = await window.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret)
  );
  return window.crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary);
}

function base64ToBytes(value) {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64UrlToBytes(value) {
  const padding = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/") + padding;
  return base64ToBytes(normalized);
}

function metaChip(label, value) {
  return `
    <span class="meta-chip">
      <strong>${escapeHtml(label)}:</strong>
      <span>${escapeHtml(value)}</span>
    </span>
  `;
}

function securityModeLabel(session) {
  return session?.security_mode === "managed" ? "Managed" : "Private";
}

function contentVisibilityLabel(session) {
  if (session?.broker_can_read_content) {
    return session.audit_enabled ? "Org-readable + audit" : "Readable";
  }
  return session?.e2ee_enabled ? "E2EE broker-blind" : "Broker-blind";
}

function brokerStatusLabel(session) {
  if (!session?.broker_channel_id) {
    return state.socketConnected ? "Connected" : "Connecting";
  }

  const brokerState = session.broker_connected ? "Connected" : "Offline";
  const channel = shortId(session.broker_channel_id);
  return session.broker_peer_id
    ? `${brokerState} · ${channel} · ${shortId(session.broker_peer_id)}`
    : `${brokerState} · ${channel}`;
}

function canCurrentDeviceWrite(session) {
  if (!session?.active_thread_id) {
    return false;
  }

  return (
    !session.active_controller_device_id ||
    session.active_controller_device_id === state.remoteAuth?.deviceId
  );
}

function isCurrentDeviceActiveController(session) {
  return Boolean(
    session?.active_thread_id &&
      session.active_controller_device_id &&
      session.active_controller_device_id === state.remoteAuth?.deviceId
  );
}

function controllerLabel(deviceId) {
  if (!deviceId) {
    return "Unclaimed";
  }

  if (deviceId === state.remoteAuth?.deviceId) {
    return `This device (${shortId(deviceId)})`;
  }

  return shortId(deviceId);
}

function roleLabel(role) {
  return role === "command" ? "Command" : role;
}

function shortId(value) {
  return value ? value.slice(0, 8) : "unknown";
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

function logLine(message) {
  const time = new Date().toLocaleTimeString();
  remoteClientLog.textContent = `${time}  ${message}\n${remoteClientLog.textContent}`.trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
