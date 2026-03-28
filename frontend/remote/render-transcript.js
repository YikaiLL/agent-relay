import * as dom from "./dom.js";
import { escapeHtml, shortId } from "./utils.js";

export function renderEmptyState() {
  dom.remoteTranscript.innerHTML = `
    <div class="thread-empty">
      <h2>No remote session yet</h2>
      <p>After pairing, this page will stream the live relay transcript through the broker.</p>
    </div>
  `;
}

export function renderLog(message) {
  const time = new Date().toLocaleTimeString();
  dom.remoteClientLog.textContent = `${time}  ${message}\n${dom.remoteClientLog.textContent}`.trim();
}

export function renderTranscriptPanel(session, approval, canWrite) {
  const entries = session.transcript || [];

  if (!entries.length && !approval) {
    if (session.active_thread_id) {
      const title = canWrite ? "Session ready" : "Session active on another device";
      const copy = canWrite
        ? "The remote session is live. Send the first prompt below when you're ready."
        : "This thread is already open, but another device currently has control. Take over to send the first prompt from here.";
      const detailParts = [];

      if (session.current_cwd) {
        detailParts.push(`Workspace: ${escapeHtml(session.current_cwd)}`);
      }
      if (session.active_thread_id) {
        detailParts.push(`Thread: ${escapeHtml(shortId(session.active_thread_id))}`);
      }

      dom.remoteTranscript.innerHTML = `
        <div class="thread-empty thread-empty-ready">
          <span class="thread-empty-badge">${canWrite ? "Ready" : "Waiting"}</span>
          <h2>${title}</h2>
          <p>${copy}</p>
          ${
            detailParts.length
              ? `<p class="thread-empty-detail">${detailParts.join(" · ")}</p>`
              : ""
          }
        </div>
      `;
      return;
    }

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

export function renderLogs(entries) {
  dom.remoteClientLog.textContent = entries
    .map(
      (entry) =>
        `${new Date(entry.created_at * 1000).toLocaleTimeString()}  [${entry.kind}] ${entry.message}`
    )
    .join("\n");
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

function roleLabel(role) {
  return role === "command" ? "Command" : role;
}
