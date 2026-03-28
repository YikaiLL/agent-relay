import * as dom from "./dom.js";
import {
  canCurrentDeviceWrite as canRemoteDeviceWrite,
  isCurrentDeviceActiveController as isRemoteController,
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

  renderSessionChrome(session);
  renderTranscriptPanel(session, approval, canWrite);
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
  renderDeviceChrome();
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
