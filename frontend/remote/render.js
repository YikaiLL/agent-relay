import * as dom from "./dom.js";
import {
  canCurrentDeviceWrite as canRemoteDeviceWrite,
  renderDeviceMeta as renderDeviceChrome,
  renderSessionChrome,
  resetRemoteSurfaceChrome,
  updateStatusBadge as updateChromeStatusBadge,
} from "./render-chrome.js";
import {
  renderEmptyState as renderTranscriptEmptyState,
  renderLog as appendClientLog,
  renderLogs,
  renderTranscriptPanel,
} from "./render-transcript.js";
import { state } from "./state.js";
import { escapeHtml, formatTimestamp, shortId } from "./utils.js";

let onResumeThread = () => {};
let onSelectRelay = () => {};

export function configureRenderHandlers(handlers) {
  onResumeThread = handlers.onResumeThread || onResumeThread;
  onSelectRelay = handlers.onSelectRelay || onSelectRelay;
}

export function renderSession(session) {
  state.session = session;
  const approval = session.pending_approvals?.[0] || null;
  const hasActiveSession = Boolean(session.active_thread_id);
  const hasControllerLease = canCurrentDeviceWrite(session);
  const canWrite = hasControllerLease;
  state.currentApprovalId = approval?.request_id || null;

  if (session.current_cwd && !dom.remoteThreadsCwdInput.value.trim()) {
    dom.remoteThreadsCwdInput.value = session.current_cwd;
  }

  syncRemoteModelSuggestions(session.available_models || [], session.model);

  renderSessionChrome(session);
  renderTranscriptPanel(session, approval, canWrite);
  renderLogs(session.logs || []);
  renderThreads(state.threads);

  dom.remoteSendButton.disabled = !hasActiveSession || !hasControllerLease;
  dom.remoteMessageInput.disabled = !hasActiveSession || !hasControllerLease;
  dom.remoteMessageInput.placeholder = !hasActiveSession
    ? "Start a remote session first."
    : hasControllerLease
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

export function renderRelayDirectory() {
  const relays = state.relayDirectory || [];
  dom.remoteRelaysCount.textContent = `${relays.length} ${relays.length === 1 ? "relay" : "relays"}`;

  if (!relays.length) {
    dom.remoteRelaysList.innerHTML = `<p class="sidebar-empty">Pair a relay from your local machine to add it here.</p>`;
    return;
  }

  dom.remoteRelaysList.innerHTML = relays
    .map((relay) => {
      const title = relay.relayLabel || relay.relayId;
      const subtitle = relay.hasLocalProfile
        ? relay.deviceLabel || relay.deviceId
        : "Grant exists, but this browser does not have local encrypted access yet.";
      const activeClass = state.remoteAuth?.relayId === relay.relayId ? " is-active" : "";
      const actionLabel = relay.hasLocalProfile ? "Open relay" : "Pair again";
      return `
        <button class="conversation-item${activeClass}" type="button" data-relay-id="${escapeHtml(relay.relayId)}" ${relay.hasLocalProfile ? "" : "disabled"}>
          <span class="conversation-title">${escapeHtml(title)}</span>
          <span class="conversation-preview">${escapeHtml(subtitle)}</span>
          <span class="conversation-meta">${escapeHtml(relay.brokerRoomId || relay.relayId)} · ${escapeHtml(actionLabel)}</span>
        </button>
      `;
    })
    .join("");

  dom.remoteRelaysList.querySelectorAll("[data-relay-id]").forEach((button) => {
    button.addEventListener("click", () => {
      onSelectRelay(button.dataset.relayId);
    });
  });
}

export function renderDeviceMeta() {
  renderDeviceChrome();
  renderRelayDirectory();
}

export function renderEmptyState() {
  renderTranscriptEmptyState();
}

export function setRemoteSessionPanelOpen(open) {
  dom.remoteSessionPanel.hidden = !open;
  dom.remoteSessionToggle.setAttribute("aria-expanded", String(open));
  dom.remoteSessionToggle.textContent = open ? "Close Remote Session Setup" : "Start Remote Session";
}

export function updateStatusBadge() {
  updateChromeStatusBadge();
}

export function renderLog(message) {
  appendClientLog(message);
}

export function resetRemoteSurface() {
  renderThreads([]);
  resetRemoteSurfaceChrome();
}

export function isCurrentDeviceActiveController(session) {
  return isRemoteController(session);
}

export function canCurrentDeviceWrite(session) {
  return canRemoteDeviceWrite(session);
}

function syncRemoteModelSuggestions(models, selectedModel) {
  const currentValue =
    selectedModel
    || dom.remoteModelInput.value
    || models.find((model) => model.is_default)?.model
    || "gpt-5.4";
  const options = [...models];
  if (currentValue && !options.some((model) => model.model === currentValue)) {
    options.unshift({
      model: currentValue,
      display_name: currentValue,
    });
  }

  dom.remoteModelInput.innerHTML = options
    .map((model) => `<option value="${escapeHtml(model.model)}">${escapeHtml(model.display_name)}</option>`)
    .join("");
  dom.remoteModelInput.value = currentValue;
}
