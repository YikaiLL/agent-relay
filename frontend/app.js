const DEVICE_STORAGE_KEY = "agent-relay.device-id";
const API_TOKEN_STORAGE_KEY = "agent-relay.api-token";
const CONTROL_HEARTBEAT_MS = 5000;
const LEASE_EXPIRY_REFRESH_SKEW_MS = 250;

const state = {
  apiToken: loadApiToken(),
  controllerHeartbeatTimer: null,
  controllerLeaseRefreshTimer: null,
  currentApprovalId: null,
  currentPairing: null,
  deviceId: loadOrCreateDeviceId(),
  defaultsSeeded: false,
  newSessionPanelOpen: false,
  selectedCwd: "",
  session: null,
  sessionStream: null,
  streamConnected: false,
  streamReconnectTimer: null,
  sessionPollTimer: null,
  threads: [],
  threadsPollTimer: null,
};

const transcript = document.querySelector("#transcript");
const clientLog = document.querySelector("#client-log");
const connectionForm = document.querySelector("#connection-form");
const apiTokenInput = document.querySelector("#api-token-input");
const startPairingButton = document.querySelector("#start-pairing-button");
const pairingPanel = document.querySelector("#pairing-panel");
const pairingQr = document.querySelector("#pairing-qr");
const pairingExpiry = document.querySelector("#pairing-expiry");
const pairingLinkInput = document.querySelector("#pairing-link-input");
const copyPairingLinkButton = document.querySelector("#copy-pairing-link-button");
const pendingPairingsList = document.querySelector("#pending-pairings-list");
const refreshButton = document.querySelector("#refresh-button");
const threadsRefreshButton = document.querySelector("#threads-refresh-button");
const sendButton = document.querySelector("#send-button");
const messageForm = document.querySelector("#message-form");
const messageInput = document.querySelector("#message-input");
const messageEffort = document.querySelector("#message-effort");
const directoryForm = document.querySelector("#directory-form");
const loadDirectoryButton = document.querySelector("#load-directory-button");
const newSessionToggleButton = document.querySelector("#new-session-toggle");
const newSessionPanel = document.querySelector("#new-session-panel");
const startSessionButton = document.querySelector("#start-session-button");
const cwdInput = document.querySelector("#cwd-input");
const startPromptInput = document.querySelector("#start-prompt");
const modelInput = document.querySelector("#model-input");
const approvalPolicyInput = document.querySelector("#approval-policy-input");
const sandboxInput = document.querySelector("#sandbox-input");
const startEffortInput = document.querySelector("#start-effort");
const threadsList = document.querySelector("#threads-list");
const threadsCount = document.querySelector("#threads-count");
const pairedDevicesList = document.querySelector("#paired-devices-list");
const workspaceTitle = document.querySelector("#workspace-title");
const workspaceSubtitle = document.querySelector("#workspace-subtitle");
const statusBadge = document.querySelector("#status-badge");
const sessionMeta = document.querySelector("#session-meta");
const controlBanner = document.querySelector("#control-banner");
const controlSummary = document.querySelector("#control-summary");
const controlHint = document.querySelector("#control-hint");
const takeOverButton = document.querySelector("#take-over-button");

connectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  applyApiToken(apiTokenInput.value);
});

startPairingButton.addEventListener("click", () => {
  void startPairing();
});

copyPairingLinkButton.addEventListener("click", () => {
  void copyPairingLink();
});

refreshButton.addEventListener("click", () => {
  void loadSession("manual refresh");
});

threadsRefreshButton.addEventListener("click", () => {
  void loadThreads("manual refresh");
});

directoryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  setSelectedCwd(cwdInput.value.trim());
  void loadThreads("directory change");
});

newSessionToggleButton.addEventListener("click", () => {
  setNewSessionPanelOpen(!state.newSessionPanelOpen);
});

startSessionButton.addEventListener("click", () => {
  void startSession();
});

takeOverButton.addEventListener("click", () => {
  void takeOverControl();
});

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendMessage();
});

transcript.addEventListener("click", (event) => {
  const approvalButton = event.target.closest("[data-approval-decision]");
  if (!approvalButton) {
    return;
  }

  void submitDecision(
    approvalButton.dataset.approvalDecision,
    approvalButton.dataset.approvalScope || "once"
  );
});

pairedDevicesList.addEventListener("click", (event) => {
  const revokeButton = event.target.closest("[data-revoke-device-id]");
  if (!revokeButton) {
    return;
  }

  void revokePairedDevice(revokeButton.dataset.revokeDeviceId);
});

pendingPairingsList.addEventListener("click", (event) => {
  const decisionButton = event.target.closest("[data-pairing-id][data-pairing-decision]");
  if (!decisionButton) {
    return;
  }

  void decidePairingRequest(
    decisionButton.dataset.pairingId,
    decisionButton.dataset.pairingDecision
  );
});

void boot();

async function boot() {
  apiTokenInput.value = state.apiToken;
  setNewSessionPanelOpen(false);
  await loadSession("initial boot");
  if (state.selectedCwd) {
    await loadThreads("initial boot");
  } else {
    renderThreads([]);
  }
  connectSessionStream();
  scheduleThreadsPoll();
}

async function loadSession(reason) {
  logLine(`Fetching session snapshot (${reason})`);

  try {
    const response = await apiFetch("/api/session");
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to load session");
    }

    seedDefaults(payload.data);
    renderSession(payload.data);
  } catch (error) {
    state.session = null;
    cancelControllerHeartbeat();
    cancelControllerLeaseRefresh();
    statusBadge.textContent = "Offline";
    statusBadge.className = "status-badge status-badge-offline";
    sessionMeta.innerHTML = `<span class="meta-empty">${escapeHtml(error.message)}</span>`;
    transcript.innerHTML = `
      <div class="thread-empty">
        <h2>Relay unavailable</h2>
        <p>${escapeHtml(error.message)}</p>
      </div>
    `;
    logLine(`Session fetch failed: ${error.message}`);
  } finally {
    if (!state.streamConnected) {
      scheduleSessionPoll();
    }
  }
}

async function loadThreads(reason) {
  if (!state.selectedCwd) {
    state.threads = [];
    renderThreads([]);
    logLine("History skipped because no directory is selected.");
    return;
  }

  threadsCount.textContent = "Loading...";
  threadsCount.title = state.selectedCwd;
  logLine(`Fetching thread list for ${state.selectedCwd} (${reason})`);

  try {
    const url = new URL("/api/threads", window.location.origin);
    url.searchParams.set("cwd", state.selectedCwd);
    url.searchParams.set("limit", "80");

    const response = await apiFetch(url);
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to load threads");
    }

    state.threads = payload.data.threads;
    renderThreads(payload.data.threads);
  } catch (error) {
    threadsCount.textContent = "Error";
    threadsList.innerHTML = `<p class="sidebar-empty">${escapeHtml(error.message)}</p>`;
    logLine(`Thread fetch failed: ${error.message}`);
  } finally {
    scheduleThreadsPoll();
  }
}

async function startSession() {
  const cwd = cwdInput.value.trim();

  if (!cwd) {
    logLine("Choose a directory before starting a session.");
    cwdInput.focus();
    return;
  }

  setSelectedCwd(cwd);
  setStartControlsBusy(true);
  logLine(`Starting a new Codex thread in ${cwd}`);

  try {
    const response = await apiFetch("/api/session/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cwd,
        initial_prompt: startPromptInput.value.trim() || null,
        model: modelInput.value.trim() || null,
        approval_policy: approvalPolicyInput.value,
        sandbox: sandboxInput.value,
        effort: startEffortInput.value,
        device_id: state.deviceId,
      }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to start session");
    }

    state.defaultsSeeded = false;
    setSelectedCwd(payload.data.current_cwd || cwd);
    seedDefaults(payload.data);
    renderSession(payload.data);
    await loadThreads("post-start refresh");
    setNewSessionPanelOpen(false);
    logLine("Started a new Codex thread");
  } catch (error) {
    logLine(`Session start failed: ${error.message}`);
  } finally {
    setStartControlsBusy(false);
  }
}

async function resumeSession(threadId) {
  logLine(`Resuming thread ${threadId}`);

  try {
    const response = await apiFetch("/api/session/resume", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        thread_id: threadId,
        device_id: state.deviceId,
      }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to resume session");
    }

    state.defaultsSeeded = false;
    setSelectedCwd(payload.data.current_cwd || state.selectedCwd);
    seedDefaults(payload.data);
    renderSession(payload.data);
    await loadThreads("post-resume refresh");
    setNewSessionPanelOpen(false);
    logLine(`Resumed thread ${threadId}`);
  } catch (error) {
    logLine(`Resume failed: ${error.message}`);
  }
}

async function sendMessage() {
  const text = messageInput.value.trim();

  if (!text) {
    logLine("Message is empty.");
    return;
  }

  sendButton.disabled = true;
  logLine("Sending prompt to Codex");

  try {
    const response = await apiFetch("/api/session/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        effort: messageEffort.value,
        device_id: state.deviceId,
      }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to send prompt");
    }

    messageInput.value = "";
    renderSession(payload.data);
    logLine("Prompt accepted by relay");
  } catch (error) {
    logLine(`Prompt failed: ${error.message}`);
  } finally {
    sendButton.disabled = false;
  }
}

async function startPairing() {
  startPairingButton.disabled = true;
  logLine("Creating a broker pairing ticket.");

  try {
    const response = await apiFetch("/api/pairing/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to start pairing");
    }

    state.currentPairing = payload.data;
    renderPairingPanel();
    logLine(`Pairing ticket ${payload.data.pairing_id} is ready.`);
  } catch (error) {
    logLine(`Pairing failed: ${error.message}`);
  } finally {
    startPairingButton.disabled = false;
  }
}

async function copyPairingLink() {
  const pairingUrl = state.currentPairing?.pairing_url;
  if (!pairingUrl) {
    logLine("No pairing link is available yet.");
    return;
  }

  try {
    await navigator.clipboard.writeText(pairingUrl);
    logLine("Copied pairing link to clipboard.");
  } catch (error) {
    pairingLinkInput.focus();
    pairingLinkInput.select();
    logLine(`Clipboard copy failed: ${error.message}`);
  }
}

async function revokePairedDevice(deviceId) {
  if (!deviceId) {
    return;
  }

  logLine(`Revoking paired device ${shortId(deviceId)}.`);

  try {
    const response = await apiFetch(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, {
      method: "POST",
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to revoke paired device");
    }

    await loadSession("post-device-revoke refresh");
    logLine(`Revoked paired device ${shortId(deviceId)}.`);
  } catch (error) {
    logLine(`Revoke failed: ${error.message}`);
  }
}

async function decidePairingRequest(pairingId, decision) {
  if (!pairingId || !decision) {
    return;
  }

  logLine(`Submitting ${decision} for pairing ${shortId(pairingId)}.`);

  try {
    const response = await apiFetch(
      `/api/pairings/${encodeURIComponent(pairingId)}/decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decision }),
      }
    );
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Pairing decision failed");
    }

    logLine(payload.data.message);
    await loadSession("post-pairing-decision refresh");
  } catch (error) {
    logLine(`Pairing decision failed: ${error.message}`);
  }
}

async function takeOverControl() {
  if (!state.session?.active_thread_id) {
    logLine("There is no active session to take over.");
    return;
  }

  takeOverButton.disabled = true;
  logLine(`Taking control from device ${shortId(state.deviceId)}`);

  try {
    const response = await apiFetch("/api/session/take-over", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        device_id: state.deviceId,
      }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to take control");
    }

    renderSession(payload.data);
    messageInput.focus();
    logLine("This device now has control.");
  } catch (error) {
    logLine(`Take over failed: ${error.message}`);
  } finally {
    takeOverButton.disabled = false;
  }
}

async function submitDecision(decision, scope) {
  if (!state.currentApprovalId) {
    logLine("No pending approval to submit.");
    return;
  }

  logLine(`Submitting ${decision} for ${state.currentApprovalId}`);

  try {
    const response = await apiFetch(`/api/approvals/${encodeURIComponent(state.currentApprovalId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        decision,
        scope,
        device_id: state.deviceId,
      }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Approval submission failed");
    }

    logLine(payload.data.message);
    await loadSession("post-decision refresh");
  } catch (error) {
    logLine(`Approval failed: ${error.message}`);
  }
}

function renderSession(session) {
  state.session = session;

  const approval = session.pending_approvals[0] || null;
  const activeThread = resolveActiveThread(session.active_thread_id);
  const hasActiveSession = Boolean(session.active_thread_id);
  const canWrite = canCurrentDeviceWrite(session);
  state.currentApprovalId = approval?.request_id || null;

  workspaceTitle.textContent = session.active_thread_id
    ? activeThread?.name || activeThread?.preview || shortId(session.active_thread_id)
    : "New session";
  workspaceSubtitle.textContent = session.active_thread_id
    ? session.current_cwd
    : "Pick a workspace on the left and start or resume a session.";

  if (approval) {
    statusBadge.textContent = "Approval required";
    statusBadge.className = "status-badge status-badge-alert";
  } else if (!session.codex_connected) {
    statusBadge.textContent = "Offline";
    statusBadge.className = "status-badge status-badge-offline";
  } else {
    statusBadge.textContent = session.current_status || "Ready";
    statusBadge.className = "status-badge status-badge-ready";
  }

  renderSessionMeta(session);
  renderPairingPanel();
  renderPairedDevices(session.paired_devices || []);
  renderPendingPairingRequests(session.pending_pairing_requests || []);
  renderControlBanner(session);
  renderTranscript(session.transcript, approval);
  renderLogs(session.logs);
  renderThreads(state.threads);
  scheduleControllerHeartbeat(session);
  scheduleControllerLeaseRefresh(session);

  sendButton.disabled = !hasActiveSession || !canWrite;
  messageInput.disabled = !hasActiveSession || !canWrite;
  messageInput.placeholder = !hasActiveSession
    ? "Start or resume a session first."
    : canWrite
      ? "Message Codex..."
      : "Another device has control. Take over to reply.";
}

function renderPairingPanel() {
  const pairing = state.currentPairing;
  pairingPanel.hidden = !pairing;

  if (!pairing) {
    pairingQr.innerHTML = "";
    pairingLinkInput.value = "";
    pairingExpiry.textContent = "Pairing ticket not created yet.";
    return;
  }

  pairingQr.innerHTML = pairing.pairing_qr_svg;
  pairingLinkInput.value = pairing.pairing_url;
  pairingExpiry.textContent = `Expires ${formatTimestamp(pairing.expires_at)}`;
}

function renderPairedDevices(devices) {
  if (!devices.length) {
    pairedDevicesList.innerHTML = `<p class="sidebar-empty">No remote devices paired yet.</p>`;
    return;
  }

  pairedDevicesList.innerHTML = devices
    .map((device) => {
      const lastSeen = device.last_seen_at
        ? `Seen ${formatTimestamp(device.last_seen_at)}`
        : "Never seen";

      return `
        <article class="paired-device-card">
          <div class="paired-device-copy">
            <strong>${escapeHtml(device.label)}</strong>
            <p class="paired-device-meta">${escapeHtml(shortId(device.device_id))} · ${escapeHtml(lastSeen)}</p>
          </div>
          <button
            class="sidebar-link-button"
            type="button"
            data-revoke-device-id="${escapeHtml(device.device_id)}"
          >
            Revoke
          </button>
        </article>
      `;
    })
    .join("");
}

function renderPendingPairingRequests(requests) {
  if (!requests.length) {
    pendingPairingsList.innerHTML =
      `<p class="sidebar-empty">No devices are waiting for local approval.</p>`;
    return;
  }

  pendingPairingsList.innerHTML = requests
    .map((request) => {
      return `
        <article class="paired-device-card">
          <div class="paired-device-copy">
            <strong>${escapeHtml(request.label)}</strong>
            <p class="paired-device-meta">${escapeHtml(shortId(request.device_id))} · requested ${escapeHtml(formatTimestamp(request.requested_at))}</p>
            <p class="paired-device-meta">Broker peer ${escapeHtml(shortId(request.broker_peer_id))}</p>
          </div>
          <div class="paired-device-actions">
            <button
              class="approval-button approval-button-primary"
              type="button"
              data-pairing-id="${escapeHtml(request.pairing_id)}"
              data-pairing-decision="approve"
            >
              Approve
            </button>
            <button
              class="approval-button approval-button-danger"
              type="button"
              data-pairing-id="${escapeHtml(request.pairing_id)}"
              data-pairing-decision="reject"
            >
              Reject
            </button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderSessionMeta(session) {
  const securityChips = [
    metaChip("Security", securityModeLabel(session)),
    metaChip("Visibility", contentVisibilityLabel(session)),
    metaChip("Broker", brokerStatusLabel(session)),
    metaChip("Devices", pairedDeviceCountLabel(session)),
  ];

  if (!session.active_thread_id) {
    sessionMeta.innerHTML = [
      ...securityChips,
      `<span class="meta-empty">Session details will appear here.</span>`,
    ].join("");
    return;
  }

  sessionMeta.innerHTML = [
    ...securityChips,
    metaChip("Directory", session.current_cwd || "None"),
    metaChip("Model", session.model),
    metaChip("Approval", session.approval_policy),
    metaChip("Sandbox", session.sandbox),
    metaChip("Effort", session.reasoning_effort),
    metaChip(
      "Control",
      session.active_controller_device_id
        ? controllerLabel(session.active_controller_device_id)
        : "Unclaimed"
    ),
    metaChip("Thread", shortId(session.active_thread_id)),
  ].join("");
}

function renderControlBanner(session) {
  if (!session.active_thread_id) {
    controlBanner.hidden = true;
    takeOverButton.hidden = true;
    return;
  }

  controlBanner.hidden = false;

  if (!session.active_controller_device_id) {
    controlSummary.textContent = "No device currently has control";
    controlHint.textContent = "The next device to send a message will claim control.";
    takeOverButton.hidden = true;
    return;
  }

  if (isCurrentDeviceActiveController(session)) {
    controlSummary.textContent = "This device has control";
    controlHint.textContent = "You can type here. Other owner devices can still approve pending actions.";
    takeOverButton.hidden = true;
    return;
  }

  controlSummary.textContent = session.active_controller_device_id
    ? `Another device has control (${controllerLabel(session.active_controller_device_id)})`
    : "No device currently has control";
  controlHint.textContent = "You can still approve from this device. Take over when you want to type or continue the session.";
  takeOverButton.hidden = false;
}

function renderTranscript(entries, approval) {
  if (!entries.length && !approval) {
    transcript.innerHTML = `
      <div class="thread-empty">
        <h2>No active conversation yet</h2>
        <p>Start a new session or resume one from the sidebar.</p>
      </div>
    `;
    return;
  }

  const items = entries.map(renderEntry);
  if (approval) {
    items.push(renderApprovalCard(approval));
  }

  transcript.innerHTML = `<div class="thread-content">${items.join("")}</div>`;
  transcript.scrollTop = transcript.scrollHeight;
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
          <button
            class="approval-button approval-button-primary"
            type="button"
            data-approval-decision="approve"
            data-approval-scope="once"
          >
            Approve
          </button>
          ${
            approval.supports_session_scope
              ? `
                <button
                  class="approval-button"
                  type="button"
                  data-approval-decision="approve"
                  data-approval-scope="session"
                >
                  Approve Session
                </button>
              `
              : ""
          }
          <button
            class="approval-button approval-button-danger"
            type="button"
            data-approval-decision="deny"
            data-approval-scope="once"
          >
            Deny
          </button>
        </div>
      </div>
    </article>
  `;
}

function renderThreads(threads) {
  const selectedCwd = state.selectedCwd;
  const activeThreadId = state.session?.active_thread_id || null;

  if (!selectedCwd) {
    threadsCount.textContent = "Choose a directory";
    threadsCount.title = "";
    threadsList.innerHTML = `<p class="sidebar-empty">Choose a directory to load history sessions.</p>`;
    return;
  }

  threadsCount.textContent = `${threads.length} ${threads.length === 1 ? "session" : "sessions"}`;
  threadsCount.title = selectedCwd;

  if (!threads.length) {
    threadsList.innerHTML = `<p class="sidebar-empty">No saved sessions found for this workspace.</p>`;
    return;
  }

  threadsList.innerHTML = threads
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

  threadsList.querySelectorAll("[data-thread-id]").forEach((button) => {
    button.addEventListener("click", () => {
      void resumeSession(button.dataset.threadId);
    });
  });
}

function renderLogs(entries) {
  clientLog.textContent = entries
    .map(
      (entry) =>
        `${new Date(entry.created_at * 1000).toLocaleTimeString()}  [${entry.kind}] ${entry.message}`
    )
    .join("\n");
}

function seedDefaults(session) {
  if (!state.defaultsSeeded) {
    if (!modelInput.value) {
      modelInput.value = session.model || "gpt-5-codex";
    }
    approvalPolicyInput.value = session.approval_policy;
    sandboxInput.value = session.sandbox;
    startEffortInput.value = session.reasoning_effort;
    messageEffort.value = session.reasoning_effort;
    state.defaultsSeeded = true;
  }

  if (!state.selectedCwd && session.current_cwd) {
    setSelectedCwd(session.current_cwd);
  }
}

function setSelectedCwd(cwd) {
  state.selectedCwd = cwd;
  cwdInput.value = cwd;
}

function resolveActiveThread(threadId) {
  if (!threadId) {
    return null;
  }

  return state.threads.find((thread) => thread.id === threadId) || null;
}

function setStartControlsBusy(busy) {
  [
    loadDirectoryButton,
    startSessionButton,
    cwdInput,
    startPromptInput,
    modelInput,
    approvalPolicyInput,
    sandboxInput,
    startEffortInput,
  ].forEach((element) => {
    element.disabled = busy;
  });
}

function setNewSessionPanelOpen(open) {
  state.newSessionPanelOpen = open;
  newSessionPanel.hidden = !open;
  newSessionToggleButton.setAttribute("aria-expanded", String(open));
  newSessionToggleButton.textContent = open ? "Close Session Setup" : "New Session";
}

function scheduleSessionPoll() {
  if (state.streamConnected) {
    return;
  }

  if (state.sessionPollTimer) {
    window.clearTimeout(state.sessionPollTimer);
  }

  state.sessionPollTimer = window.setTimeout(() => {
    void loadSession("poll");
  }, nextSessionPollDelay());
}

function scheduleThreadsPoll() {
  if (state.threadsPollTimer) {
    window.clearTimeout(state.threadsPollTimer);
  }

  state.threadsPollTimer = window.setTimeout(() => {
    void loadThreads("poll");
  }, 12000);
}

function scheduleControllerHeartbeat(session) {
  cancelControllerHeartbeat();

  if (!session?.active_thread_id || !isCurrentDeviceActiveController(session)) {
    return;
  }

  state.controllerHeartbeatTimer = window.setTimeout(() => {
    void sendSessionHeartbeat();
  }, CONTROL_HEARTBEAT_MS);
}

async function sendSessionHeartbeat() {
  if (!state.session?.active_thread_id || !isCurrentDeviceActiveController(state.session)) {
    return;
  }

  try {
    const response = await apiFetch("/api/session/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        device_id: state.deviceId,
      }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to refresh control lease");
    }
  } catch (error) {
    logLine(`Control heartbeat failed: ${error.message}`);
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
    void loadSession("controller lease expiry");
  }, delayMs);
}

function cancelControllerLeaseRefresh() {
  if (!state.controllerLeaseRefreshTimer) {
    return;
  }

  window.clearTimeout(state.controllerLeaseRefreshTimer);
  state.controllerLeaseRefreshTimer = null;
}

function connectSessionStream() {
  if (!("EventSource" in window)) {
    logLine("EventSource is unavailable. Falling back to polling.");
    state.streamConnected = false;
    scheduleSessionPoll();
    return;
  }

  if (state.sessionStream) {
    state.sessionStream.close();
  }

  const stream = new EventSource(sessionStreamUrl());
  state.sessionStream = stream;

  stream.addEventListener("session", (event) => {
    try {
      const snapshot = JSON.parse(event.data);
      state.streamConnected = true;
      cancelSessionPoll();
      seedDefaults(snapshot);
      renderSession(snapshot);
    } catch (error) {
      logLine(`Stream payload failed: ${error.message}`);
    }
  });

  stream.onopen = () => {
    if (!state.streamConnected) {
      logLine("Session stream connected.");
    }
    state.streamConnected = true;
    cancelSessionPoll();
    cancelStreamReconnect();
  };

  stream.onerror = () => {
    if (state.sessionStream !== stream) {
      return;
    }

    logLine("Session stream disconnected. Falling back to polling.");
    state.streamConnected = false;
    state.sessionStream.close();
    state.sessionStream = null;
    scheduleSessionPoll();
    scheduleStreamReconnect();
  };
}

function cancelSessionPoll() {
  if (!state.sessionPollTimer) {
    return;
  }

  window.clearTimeout(state.sessionPollTimer);
  state.sessionPollTimer = null;
}

function apiFetch(input, init = {}) {
  const headers = new Headers(init.headers || {});
  if (state.apiToken) {
    headers.set("Authorization", `Bearer ${state.apiToken}`);
  }

  return fetch(input, {
    ...init,
    headers,
  });
}

function sessionStreamUrl() {
  const url = new URL("/api/stream", window.location.origin);
  if (state.apiToken) {
    url.searchParams.set("access_token", state.apiToken);
  }
  return url.toString();
}

function applyApiToken(rawValue) {
  const nextToken = rawValue.trim();
  state.apiToken = nextToken;
  apiTokenInput.value = nextToken;

  if (nextToken) {
    window.localStorage.setItem(API_TOKEN_STORAGE_KEY, nextToken);
    logLine("Stored API token for this device.");
  } else {
    window.localStorage.removeItem(API_TOKEN_STORAGE_KEY);
    logLine("Cleared API token for this device.");
  }

  state.streamConnected = false;
  cancelStreamReconnect();
  if (state.sessionStream) {
    state.sessionStream.close();
    state.sessionStream = null;
  }
  connectSessionStream();
  void loadSession("auth change");
  if (state.selectedCwd) {
    void loadThreads("auth change");
  }
}

function scheduleStreamReconnect() {
  cancelStreamReconnect();
  state.streamReconnectTimer = window.setTimeout(() => {
    connectSessionStream();
  }, 1500);
}

function cancelStreamReconnect() {
  if (!state.streamReconnectTimer) {
    return;
  }

  window.clearTimeout(state.streamReconnectTimer);
  state.streamReconnectTimer = null;
}

function nextSessionPollDelay() {
  const session = state.session;
  if (!session || !session.active_thread_id) {
    return 2200;
  }

  if (session.pending_approvals?.length) {
    return 700;
  }

  if (session.active_turn_id) {
    return 700;
  }

  if (session.current_status && session.current_status !== "idle") {
    return 1100;
  }

  return 2200;
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
  if (session?.security_mode === "managed") {
    return "Managed";
  }
  return "Private";
}

function contentVisibilityLabel(session) {
  if (session?.broker_can_read_content) {
    return session.audit_enabled ? "Org-readable + audit" : "Readable";
  }
  return session?.e2ee_enabled ? "E2EE broker-blind" : "Broker-blind";
}

function brokerStatusLabel(session) {
  if (!session?.broker_channel_id) {
    return "Disabled";
  }

  const state = session.broker_connected ? "Connected" : "Offline";
  const channel = shortId(session.broker_channel_id);
  return session.broker_peer_id
    ? `${state} · ${channel} · ${shortId(session.broker_peer_id)}`
    : `${state} · ${channel}`;
}

function pairedDeviceCountLabel(session) {
  const count = Array.isArray(session?.paired_devices)
    ? session.paired_devices.length
    : 0;
  return count === 0 ? "None" : `${count} paired`;
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

function roleLabel(role) {
  if (role === "command") {
    return "Command";
  }
  return role;
}

function isCurrentDeviceActiveController(session) {
  if (!session?.active_thread_id || !session.active_controller_device_id) {
    return false;
  }

  return session.active_controller_device_id === state.deviceId;
}

function canCurrentDeviceWrite(session) {
  if (!session?.active_thread_id) {
    return false;
  }

  return !session.active_controller_device_id || session.active_controller_device_id === state.deviceId;
}

function controllerLabel(deviceId) {
  if (!deviceId) {
    return "Unclaimed";
  }

  if (deviceId === state.deviceId) {
    return `This device (${shortId(deviceId)})`;
  }

  return shortId(deviceId);
}

function shortId(value) {
  return value ? value.slice(0, 8) : "unknown";
}

function loadOrCreateDeviceId() {
  const existing = window.localStorage.getItem(DEVICE_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const generated = window.crypto?.randomUUID?.()
    ? window.crypto.randomUUID()
    : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(DEVICE_STORAGE_KEY, generated);
  return generated;
}

function loadApiToken() {
  return window.localStorage.getItem(API_TOKEN_STORAGE_KEY)?.trim() || "";
}

function logLine(message) {
  const time = new Date().toLocaleTimeString();
  clientLog.textContent = `${time}  ${message}\n${clientLog.textContent}`.trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
