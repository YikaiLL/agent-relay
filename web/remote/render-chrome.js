import * as dom from "./dom.js";
import { renderEmptyState } from "./render-transcript.js";
import { state } from "./state.js";
import { escapeHtml, formatTimestamp, shortId } from "./utils.js";

export function renderSessionChrome(session) {
  const approval = session.pending_approvals?.[0] || null;
  const hasActiveSession = Boolean(session.active_thread_id);

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

export function resetRemoteSurfaceChrome() {
  renderDeviceMeta();
  renderOverviewCards();
  dom.remoteSessionMeta.innerHTML = `<span class="meta-empty">Pair a remote device to start streaming session details.</span>`;
  dom.remoteControlBanner.hidden = true;
  dom.remoteWorkspaceTitle.textContent = "Pair this browser";
  dom.remoteWorkspaceSubtitle.textContent = "Open a pairing QR from your local relay to control Codex remotely.";
  renderEmptyState();
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

function statusBadgeMarkup(label, tone = "ready") {
  return `<span class="status-badge status-badge-${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}
