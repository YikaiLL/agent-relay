// The LOCAL surface's dialog id and opener; the rest is start-session-dialog.mjs.
// The two re-exports below are unit-tested through this path by local-session.test.mjs.
import {
  DEFAULT_TIMEOUT,
  clickMenuRowInPage,
  fillStartSessionDialog,
  pickModelOptionIndex,
  waitForDialogOpen,
} from "./start-session-dialog.mjs";

export { clickMenuRowInPage, pickModelOptionIndex };

const DIALOG_ID = "launch-start-session-dialog";

export async function startLocalSession(
  page,
  { cwd, approvalPolicy = "never", effort, provider, model, initialPrompt, timeoutMs } = {}
) {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT;
  await openStartSessionDialog(page, timeout);
  await fillStartSessionDialog(page, {
    dialogId: DIALOG_ID,
    cwd,
    approvalPolicy,
    effort,
    provider,
    model,
    initialPrompt,
    timeout,
  });
}

async function openStartSessionDialog(page, timeout) {
  const alreadyOpen = await page.evaluate(
    (id) => Boolean(document.getElementById(id)?.open),
    DIALOG_ID
  );
  if (alreadyOpen) {
    return;
  }
  const opened = await page
    .click("#open-start-session-dialog", { timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    await page.evaluate((id) => {
      document.getElementById(id)?.setAttribute("open", "");
    }, DIALOG_ID);
  }
  await waitForDialogOpen(page, DIALOG_ID, timeout);
}
