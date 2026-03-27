import * as dom from "./dom.js";
import { state } from "./state.js";
import { escapeHtml, formatTimestamp, shortId } from "./utils.js";

let onResumeThread = () => {};

export function configureRenderHandlers(handlers) {
  onResumeThread = handlers.onResumeThread || onResumeThread;
}

export function renderSession(session) {
  state.session = session;
  const approval = session.pending_approvals?.[0] || null;
  const hasActiveSession = Boolean(session.active_thread_id);
  const canWrite = canCurrentDeviceWrite(session);
  state.currentApprovalId = approval?.request_id || null;

  if (session.current_cwd && !dom.remoteThreadsCwdInput.value.trim()) {
    dom.remoteThreadsCwdInput.value = session.current_cwd;
  }

  dom.remoteWorkspaceTitle.textContent = hasActiveSession
    ? shortId(session.active_thread_id)
    : "Remote surface ready";
  dom.remoteWorkspaceSubtitle.textContent = hasActiveSession
    ? session.current_cwd
    : "Pair this browser and either wait for a live session or start one from the sidebar.";

  if (approval) {
    dom.remoteStatusBadge.textContent = "Approval required";
    dom.remoteStatusBadge.className = "status-badge status-badge-alert";
  } else if (!state.socketConnected || !session.codex_connected) {
    dom.remoteStatusBadge.textContent = "Offline";
    dom.remoteStatusBadge.className = "status-badge status-badge-offline";
  } else {
    dom.remoteStatusBadge.textContent = session.current_status || "Ready";
    dom.remoteStatusBadge.className = "status-badge status-badge-ready";
  }

  renderSessionMeta(session);
  renderOverviewCards();
  renderControlBanner(session);
  renderTranscript(session.transcript || [], approval);
  renderLogs(session.logs || []);
  renderThreads(state.threads);

  dom.remoteSendButton.disabled = !hasActiveSession || !canWrite;
  dom.remoteMessageInput.disabled = !hasActiveSession || !canWrite;
  dom.remoteMessageInput.placeholder = !hasActiveSession
    ? "Start a remote session first."
    : canWrite
      ? "Message Codex remotely..."
      : "Another device has control. Take over to reply.";
}

export function renderThreads(threads) {
  const filterValue = dom.remoteThreadsCwdInput.value.trim();
  const activeThreadId = state.session?.active_thread_id || null;

  if (!state.remoteAuth) {
    dom.remoteThreadsCount.textContent = "Remote session history";
    dom.remoteThreadsList.innerHTML = `<p class="sidebar-empty">Pair a device, then refresh remote history.</p>`;
    return;
  }

  dom.remoteThreadsCount.textContent = `${threads.length} ${threads.length === 1 ? "session" : "sessions"}`;

  if (!threads.length) {
    dom.remoteThreadsList.innerHTML = filterValue
      ? `<p class="sidebar-empty">No remote sessions found for this workspace filter.</p>`
      : `<p class="sidebar-empty">No remote sessions found yet.</p>`;
    return;
  }

  dom.remoteThreadsList.innerHTML = threads
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

  dom.remoteThreadsList.querySelectorAll("[data-thread-id]").forEach((button) => {
    button.addEventListener("click", () => {
      onResumeThread(button.dataset.threadId);
    });
  });
}

export function renderDeviceMeta() {
  if (!state.remoteAuth && !state.pairingTicket) {
    dom.deviceMeta.innerHTML = `<p class="sidebar-empty">No paired remote device stored in this browser.</p>`;
    renderOverviewCards();
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
          <div class="paired-device-badges">
            ${statusBadgeMarkup("Paired", "ready")}
            ${statusBadgeMarkup(securityModeLabel(state.session), state.remoteAuth.securityMode === "managed" ? "alert" : "ready")}
            ${statusBadgeMarkup(sessionClaimStatusText(), sessionClaimBadgeTone())}
          </div>
          <p class="paired-device-meta">Device ${escapeHtml(shortId(state.remoteAuth.deviceId))}</p>
          <p class="paired-device-meta">Broker ${escapeHtml(state.remoteAuth.brokerChannelId)} via ${escapeHtml(shortId(state.remoteAuth.relayPeerId))}</p>
          <p class="paired-device-meta">${escapeHtml(sessionClaimLabel())}</p>
        </div>
      </article>
    `);
  }

  dom.deviceMeta.innerHTML = rows.join("");
  renderOverviewCards();
}

export function renderEmptyState() {
  dom.remoteTranscript.innerHTML = `
    <div class="thread-empty">
      <h2>No remote session yet</h2>
      <p>After pairing, this page will stream the live relay transcript through the broker.</p>
    </div>
  `;
}

export function setRemoteSessionPanelOpen(open) {
  dom.remoteSessionPanel.hidden = !open;
  dom.remoteSessionToggle.setAttribute("aria-expanded", String(open));
  dom.remoteSessionToggle.textContent = open ? "Close Remote Session Setup" : "Start Remote Session";
}

export function updateStatusBadge() {
  if (state.session) {
    if (state.session.pending_approvals?.length) {
      dom.remoteStatusBadge.textContent = "Approval required";
      dom.remoteStatusBadge.className = "status-badge status-badge-alert";
      renderOverviewCards();
      return;
    }

    if (!state.socketConnected || !state.session.codex_connected) {
      dom.remoteStatusBadge.textContent = "Offline";
      dom.remoteStatusBadge.className = "status-badge status-badge-offline";
      renderOverviewCards();
      return;
    }

    dom.remoteStatusBadge.textContent = state.session.current_status || "Ready";
    dom.remoteStatusBadge.className = "status-badge status-badge-ready";
    renderOverviewCards();
    return;
  }

  if (state.socketConnected) {
    dom.remoteStatusBadge.textContent = "Connected";
    dom.remoteStatusBadge.className = "status-badge status-badge-ready";
    renderOverviewCards();
    return;
  }

  dom.remoteStatusBadge.textContent = state.remoteAuth || state.pairingTicket ? "Connecting" : "Offline";
  dom.remoteStatusBadge.className = "status-badge status-badge-offline";
  renderOverviewCards();
}

export function renderLog(message) {
  const time = new Date().toLocaleTimeString();
  dom.remoteClientLog.textContent = `${time}  ${message}\n${dom.remoteClientLog.textContent}`.trim();
}

export function resetRemoteSurface() {
  renderDeviceMeta();
  renderThreads([]);
  renderEmptyState();
  renderOverviewCards();
  dom.remoteSessionMeta.innerHTML = `<span class="meta-empty">Pair a remote device to start streaming session details.</span>`;
  dom.remoteControlBanner.hidden = true;
  dom.remoteWorkspaceTitle.textContent = "Pair this browser";
  dom.remoteWorkspaceSubtitle.textContent = "Open a pairing QR from your local relay to control Codex remotely.";
  updateStatusBadge();
}

export function isCurrentDeviceActiveController(session) {
  return Boolean(
    session?.active_thread_id &&
      session.active_controller_device_id &&
      session.active_controller_device_id === state.remoteAuth?.deviceId
  );
}

export function canCurrentDeviceWrite(session) {
  if (!session?.active_thread_id) {
    return false;
  }

  return (
    !session.active_controller_device_id ||
    session.active_controller_device_id === state.remoteAuth?.deviceId
  );
}

function renderSessionMeta(session) {
  dom.remoteSessionMeta.innerHTML = [
    metaChip("Security", securityModeLabel(session)),
    metaChip("Visibility", contentVisibilityLabel(session)),
    metaChip("Broker", brokerStatusLabel(session)),
    metaChip("Device", state.remoteAuth?.deviceLabel || "Unpaired"),
    metaChip("Claim", sessionClaimLabel()),
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
    dom.remoteControlBanner.hidden = true;
    return;
  }

  dom.remoteControlBanner.hidden = false;

  if (!session.active_controller_device_id) {
    dom.remoteControlSummary.textContent = "No device currently has control";
    dom.remoteControlHint.textContent = "The next paired device to send a message will claim control.";
    dom.remoteTakeOverButton.hidden = true;
    return;
  }

  if (isCurrentDeviceActiveController(session)) {
    dom.remoteControlSummary.textContent = "This remote device has control";
    dom.remoteControlHint.textContent = "You can type here. Other paired devices can still approve pending actions.";
    dom.remoteTakeOverButton.hidden = true;
    return;
  }

  dom.remoteControlSummary.textContent = `Another device has control (${controllerLabel(session.active_controller_device_id)})`;
  dom.remoteControlHint.textContent = "You can still approve from this browser. Take over when you want to type.";
  dom.remoteTakeOverButton.hidden = false;
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

  dom.remoteTranscript.innerHTML = `<div class="thread-content">${items.join("")}</div>`;
  dom.remoteTranscript.scrollTop = dom.remoteTranscript.scrollHeight;
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
  dom.remoteClientLog.textContent = entries
    .map(
      (entry) =>
        `${new Date(entry.created_at * 1000).toLocaleTimeString()}  [${entry.kind}] ${entry.message}`
    )
    .join("\n");
}

function renderOverviewCards() {
  renderDeviceOverview();
  renderSessionOverview();
}

function renderDeviceOverview() {
  if (!state.remoteAuth && !state.pairingTicket) {
    dom.remoteDeviceOverview.innerHTML = `
      <p class="overview-title">Not paired</p>
      <p class="overview-copy">Pair this browser from your local relay to receive an owner device claim.</p>
      <div class="overview-badges">
        ${statusBadgeMarkup("Unpaired", "offline")}
      </div>
    `;
    return;
  }

  if (state.pairingTicket) {
    dom.remoteDeviceOverview.innerHTML = `
      <p class="overview-title">Pairing pending</p>
      <p class="overview-copy">${escapeHtml(shortId(state.pairingTicket.pairing_id))} expires ${escapeHtml(formatTimestamp(state.pairingTicket.expires_at))}</p>
      <div class="overview-badges">
        ${statusBadgeMarkup("Waiting for device", "alert")}
      </div>
    `;
    return;
  }

  dom.remoteDeviceOverview.innerHTML = `
    <p class="overview-title">${escapeHtml(state.remoteAuth.deviceLabel)}</p>
    <p class="overview-copy">${escapeHtml(shortId(state.remoteAuth.deviceId))} on broker ${escapeHtml(state.remoteAuth.brokerChannelId)}</p>
    <div class="overview-badges">
      ${statusBadgeMarkup("Paired", "ready")}
      ${statusBadgeMarkup(securityModeLabel(state.session), state.remoteAuth.securityMode === "managed" ? "alert" : "ready")}
      ${statusBadgeMarkup(sessionClaimStatusText(), sessionClaimBadgeTone())}
    </div>
  `;
}

function renderSessionOverview() {
  if (!state.session?.active_thread_id) {
    dom.remoteSessionOverview.innerHTML = `
      <p class="overview-title">No live session</p>
      <p class="overview-copy">Start or resume a remote thread to see the active workspace and control owner.</p>
      <div class="overview-badges">
        ${statusBadgeMarkup(state.socketConnected ? "Connected" : "Idle", state.socketConnected ? "ready" : "offline")}
      </div>
    `;
    return;
  }

  dom.remoteSessionOverview.innerHTML = `
    <p class="overview-title">${escapeHtml(shortId(state.session.active_thread_id))}</p>
    <p class="overview-copy">${escapeHtml(state.session.current_cwd || "No workspace")}</p>
    <div class="overview-badges">
      ${statusBadgeMarkup(controlStatusText(state.session), controlStatusTone(state.session))}
      ${statusBadgeMarkup(brokerStatusText(state.session), state.session.broker_connected ? "ready" : "offline")}
      ${statusBadgeMarkup(state.session.pending_approvals?.length ? "Approval waiting" : "Live", state.session.pending_approvals?.length ? "alert" : "ready")}
    </div>
  `;
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
  const mode = session?.security_mode || state.remoteAuth?.securityMode || "private";
  return mode === "managed" ? "Managed" : "Private";
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

function sessionClaimLabel() {
  if (!state.remoteAuth) {
    return "Unpaired";
  }

  if (!state.remoteAuth.sessionClaim) {
    return "Pending";
  }

  if (!state.remoteAuth.sessionClaimExpiresAt) {
    return "Active";
  }

  return `Active until ${formatTimestamp(state.remoteAuth.sessionClaimExpiresAt)}`;
}

function sessionClaimStatusText() {
  if (!state.remoteAuth) {
    return "Unpaired";
  }
  if (!state.remoteAuth.sessionClaim) {
    return "Claim pending";
  }
  return "Claim active";
}

function sessionClaimBadgeTone() {
  if (!state.remoteAuth) {
    return "offline";
  }
  return state.remoteAuth.sessionClaim ? "ready" : "alert";
}

function controlStatusText(session) {
  if (!session.active_controller_device_id) {
    return "Control unclaimed";
  }
  if (isCurrentDeviceActiveController(session)) {
    return "You have control";
  }
  return `Controlled by ${controllerLabel(session.active_controller_device_id)}`;
}

function controlStatusTone(session) {
  if (!session.active_controller_device_id) {
    return "alert";
  }
  return isCurrentDeviceActiveController(session) ? "ready" : "offline";
}

function brokerStatusText(session) {
  return session.broker_connected ? "Broker linked" : "Broker offline";
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

function statusBadgeMarkup(label, tone = "ready") {
  return `<span class="status-badge status-badge-${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}
