import { fillStartSessionDialog } from "./start-session-dialog.mjs";

// This matches compact header badge text ("Offline", "Re-pair"). Broader
// alert badges such as approval/review/workflow states do not block composing.
const REMOTE_MESSAGE_INPUT_BLOCKING_STATUS_PATTERN = /\b(?:offline|re-?pair)\b/i;

// The remote surface renders the same `StartSessionDialog` as local, under its own
// id. Everything inside it is driven by the shared module.
const REMOTE_DIALOG_ID = "remote-start-session-dialog";

export async function openRemoteSessionPanel(page, timeoutMs) {
  await selectFirstRelayIfNeeded(page, timeoutMs);
  await page.click("#remote-session-toggle");
  await page.waitForFunction(
    () => {
      const dialog = document.querySelector("#remote-start-session-dialog");
      if (dialog?.open) {
        return true;
      }
      const panel = document.querySelector("#remote-session-panel");
      return Boolean(panel && !panel.hidden);
    },
    null,
    { timeout: timeoutMs }
  );
  const hasLegacyPanel = await page.evaluate(() =>
    Boolean(document.querySelector("#remote-session-panel"))
  );
  if (hasLegacyPanel) {
    await page.click("#remote-session-panel summary");
    await page.waitForFunction(
      () => {
        const details = document.querySelector("#remote-session-panel details");
        return Boolean(details && details.open);
      },
      null,
      { timeout: timeoutMs }
    );
  }
}

export async function selectFirstRelayIfNeeded(page, timeoutMs) {
  const needsSelection = await page.evaluate(() => {
    const toggle = document.querySelector("#remote-session-toggle");
    return Boolean(toggle?.disabled);
  });
  if (!needsSelection) {
    return;
  }

  await page.click("#remote-relays-list [data-relay-id]:not([disabled])");
  await page.waitForFunction(
    () => {
      const toggle = document.querySelector("#remote-session-toggle");
      return Boolean(toggle && !toggle.disabled);
    },
    null,
    { timeout: timeoutMs }
  );
}

export async function waitForRemoteMessageInput(page, timeoutMs) {
  await page.waitForFunction(
    ({ source, flags }) => {
      const input = document.querySelector("#remote-message-input");
      const statusText = document.querySelector("#remote-status-badge")?.textContent?.trim() || "";
      const blockingStatus = new RegExp(source, flags);
      return Boolean(input && !input.disabled && !blockingStatus.test(statusText));
    },
    {
      source: REMOTE_MESSAGE_INPUT_BLOCKING_STATUS_PATTERN.source,
      flags: REMOTE_MESSAGE_INPUT_BLOCKING_STATUS_PATTERN.flags,
    },
    { timeout: timeoutMs }
  );
}

export function remoteStatusBlocksMessageInput(statusText) {
  return REMOTE_MESSAGE_INPUT_BLOCKING_STATUS_PATTERN.test(String(statusText || ""));
}

export async function startRemoteSession(
  page,
  { cwd, approvalPolicy = "never", effort, timeoutMs }
) {
  await openRemoteSessionPanel(page, timeoutMs);
  await fillStartSessionDialog(page, {
    dialogId: REMOTE_DIALOG_ID,
    cwd,
    approvalPolicy,
    effort,
    provider: "fake",
    model: "fake-echo",
    // Asked for unconditionally, so a relay that does not publish fake must fall
    // through rather than fail.
    modelOptional: true,
    timeout: timeoutMs,
  });
  await page.evaluate((id) => {
    document.getElementById(id)?.close?.();
  }, REMOTE_DIALOG_ID);
}

export async function sendPromptAndWaitForReply(page, prompt, { timeoutMs, expectedReply } = {}) {
  await waitForRemoteMessageInput(page, timeoutMs);
  await page.fill("#remote-message-input", prompt);
  await page.click("#remote-send-button");

  const reply = expectedReply ?? prompt.replace("Reply with exactly: ", "");
  await page.waitForFunction(
    (expected) => {
      const transcript = document.querySelector("#remote-transcript")?.textContent || "";
      return transcript.includes(expected);
    },
    reply,
    { timeout: timeoutMs }
  );
}
