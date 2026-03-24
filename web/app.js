const sessionFacts = document.querySelector("#session-facts");
const approvalCard = document.querySelector("#approval-card");
const approvalBadge = document.querySelector("#approval-badge");
const clientLog = document.querySelector("#client-log");
const refreshButton = document.querySelector("#refresh-button");
const threadsRefreshButton = document.querySelector("#threads-refresh-button");
const approveButton = document.querySelector("#approve-button");
const approveSessionButton = document.querySelector("#approve-session-button");
const denyButton = document.querySelector("#deny-button");
const sendButton = document.querySelector("#send-button");
const messageForm = document.querySelector("#message-form");
const messageInput = document.querySelector("#message-input");
const messageEffort = document.querySelector("#message-effort");
const startForm = document.querySelector("#start-form");
const cwdInput = document.querySelector("#cwd-input");
const startPromptInput = document.querySelector("#start-prompt");
const modelInput = document.querySelector("#model-input");
const approvalPolicyInput = document.querySelector("#approval-policy-input");
const sandboxInput = document.querySelector("#sandbox-input");
const startEffortInput = document.querySelector("#start-effort");
const transcript = document.querySelector("#transcript");
const threadsList = document.querySelector("#threads-list");

let currentApprovalId = null;

refreshButton.addEventListener("click", () => {
  void loadSession("manual refresh");
});

threadsRefreshButton.addEventListener("click", () => {
  void loadThreads("manual refresh");
});

approveButton.addEventListener("click", () => {
  void submitDecision("approve", "once");
});

approveSessionButton.addEventListener("click", () => {
  void submitDecision("approve", "session");
});

denyButton.addEventListener("click", () => {
  void submitDecision("deny", "once");
});

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendMessage();
});

startForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void startSession();
});

void loadSession("initial boot");
void loadThreads("initial boot");
setInterval(() => {
  void loadSession("poll");
}, 2000);
setInterval(() => {
  void loadThreads("poll");
}, 10000);

async function loadSession(reason) {
  logLine(`Fetching session snapshot (${reason})`);

  try {
    const response = await fetch("/api/session");
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to load session");
    }

    hydrateFormDefaults(payload.data);
    renderSession(payload.data);
  } catch (error) {
    approvalBadge.textContent = "Offline";
    approvalBadge.className = "badge badge-pending";
    approvalCard.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
    toggleDecisionButtons(false, false);
    logLine(`Session fetch failed: ${error.message}`);
  }
}

async function loadThreads(reason) {
  logLine(`Fetching thread list (${reason})`);

  try {
    const response = await fetch("/api/threads");
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to load threads");
    }

    renderThreads(payload.data.threads);
  } catch (error) {
    threadsList.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
    logLine(`Thread fetch failed: ${error.message}`);
  }
}

async function startSession() {
  const body = {
    cwd: cwdInput.value.trim() || null,
    initial_prompt: startPromptInput.value.trim() || null,
    model: modelInput.value.trim() || null,
    approval_policy: approvalPolicyInput.value,
    sandbox: sandboxInput.value,
    effort: startEffortInput.value,
  };

  setBusy(startForm, true);
  logLine("Starting a new Codex thread");

  try {
    const response = await fetch("/api/session/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to start session");
    }

    renderSession(payload.data);
    await loadThreads("post-start refresh");
    logLine("Started a new Codex thread");
  } catch (error) {
    logLine(`Session start failed: ${error.message}`);
  } finally {
    setBusy(startForm, false);
  }
}

async function resumeSession(threadId) {
  logLine(`Resuming thread ${threadId}`);

  try {
    const response = await fetch("/api/session/resume", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ thread_id: threadId }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to resume session");
    }

    renderSession(payload.data);
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
    const response = await fetch("/api/session/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        effort: messageEffort.value,
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

async function submitDecision(decision, scope) {
  if (!currentApprovalId) {
    logLine("No pending approval to submit.");
    return;
  }

  toggleDecisionButtons(false, false);
  logLine(`Submitting ${decision} for ${currentApprovalId}`);

  try {
    const response = await fetch(`/api/approvals/${encodeURIComponent(currentApprovalId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ decision, scope }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Approval submission failed");
    }

    logLine(payload.data.message);
    await loadSession("post-decision refresh");
  } catch (error) {
    logLine(`Approval failed: ${error.message}`);
    approvalCard.insertAdjacentHTML(
      "beforeend",
      `<p class="muted">${escapeHtml(error.message)}</p>`
    );
  }
}

function renderSession(session) {
  const approval = session.pending_approvals[0] || null;
  currentApprovalId = approval?.request_id || null;

  sessionFacts.innerHTML = [
    fact("Provider", session.provider),
    fact("Codex", session.codex_connected ? "Connected" : "Offline"),
    fact("Thread", session.active_thread_id || "None"),
    fact("Turn", session.active_turn_id || "None"),
    fact("Status", session.current_status),
    fact("Flags", session.active_flags.join(", ") || "none"),
    fact("CWD", session.current_cwd),
    fact("Model", session.model),
    fact("Approval", session.approval_policy),
    fact("Sandbox", session.sandbox),
    fact("Effort", session.reasoning_effort),
  ].join("");

  renderTranscript(session.transcript);
  renderLogs(session.logs);

  if (approval) {
    approvalBadge.textContent = "Approval Needed";
    approvalBadge.className = "badge badge-pending";
    approvalCard.innerHTML = `
      <h3>${escapeHtml(approval.summary)}</h3>
      <p class="muted">Kind: ${escapeHtml(approval.kind)}</p>
      ${approval.detail ? `<p class="muted">${escapeHtml(approval.detail)}</p>` : ""}
      ${approval.cwd ? `<p class="muted">cwd: ${escapeHtml(approval.cwd)}</p>` : ""}
      ${approval.command ? `<div class="approval-command">${escapeHtml(approval.command)}</div>` : ""}
      ${approval.requested_permissions ? `<pre class="approval-command">${escapeHtml(JSON.stringify(approval.requested_permissions, null, 2))}</pre>` : ""}
    `;
    toggleDecisionButtons(true, approval.supports_session_scope);
  } else {
    approvalBadge.textContent = "No Pending Action";
    approvalBadge.className = "badge badge-idle";
    approvalCard.innerHTML = `
      <h3>Queue is clear.</h3>
      <p class="muted">
        The relay is ready for the next Codex event. Approval prompts from commands, file changes,
        and extra permissions will appear here.
      </p>
    `;
    toggleDecisionButtons(false, false);
  }

  sendButton.disabled = !session.active_thread_id;
  logLine(`Session updated. Status: ${session.current_status}`);
}

function renderThreads(threads) {
  if (!threads.length) {
    threadsList.innerHTML = `<p class="muted">No saved threads found.</p>`;
    return;
  }

  threadsList.innerHTML = threads
    .map(
      (thread) => `
        <article class="thread-card">
          <h3>${escapeHtml(thread.name || thread.preview || thread.id)}</h3>
          <p>${escapeHtml(thread.preview || "No preview yet.")}</p>
          <p class="meta">${escapeHtml(thread.cwd)} · ${escapeHtml(thread.status)} · ${escapeHtml(thread.source)}</p>
          <button class="ghost-button" type="button" data-thread-id="${escapeHtml(thread.id)}">Resume</button>
        </article>
      `
    )
    .join("");

  threadsList.querySelectorAll("[data-thread-id]").forEach((button) => {
    button.addEventListener("click", () => {
      void resumeSession(button.dataset.threadId);
    });
  });
}

function renderTranscript(entries) {
  if (!entries.length) {
    transcript.innerHTML = `<p class="muted">No transcript yet. Start or resume a Codex session first.</p>`;
    return;
  }

  transcript.innerHTML = entries
    .map(
      (entry) => `
        <article class="transcript-entry" data-role="${escapeHtml(entry.role)}">
          <h3>${escapeHtml(entry.role)} · ${escapeHtml(entry.status)}</h3>
          <p class="transcript-body">${escapeHtml(entry.text || "(empty)")}</p>
          <p class="meta">${escapeHtml(entry.turn_id || "no turn id")}</p>
        </article>
      `
    )
    .join("");
}

function renderLogs(entries) {
  clientLog.textContent = entries
    .map((entry) => `${new Date(entry.created_at * 1000).toLocaleTimeString()}  [${entry.kind}] ${entry.message}`)
    .join("\n");
}

function toggleDecisionButtons(enabled, sessionEnabled) {
  approveButton.disabled = !enabled;
  approveSessionButton.disabled = !enabled || !sessionEnabled;
  denyButton.disabled = !enabled;
}

function fact(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function logLine(message) {
  const time = new Date().toLocaleTimeString();
  clientLog.textContent = `${time}  ${message}\n${clientLog.textContent}`.trim();
}

function hydrateFormDefaults(session) {
  if (!cwdInput.value) {
    cwdInput.value = session.current_cwd || "";
  }

  approvalPolicyInput.value = session.approval_policy;
  sandboxInput.value = session.sandbox;
  startEffortInput.value = session.reasoning_effort;
  messageEffort.value = session.reasoning_effort;
}

function setBusy(form, busy) {
  form.querySelectorAll("input, textarea, select, button").forEach((element) => {
    element.disabled = busy;
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
