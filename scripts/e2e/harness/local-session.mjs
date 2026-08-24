// Drive the "New session" dialog from an e2e script. Every control id derives
// from the dialog id; the workspace and pill menus are pickers, not selects.
import assert from "node:assert/strict";

const DIALOG_ID = "launch-start-session-dialog";
const DEFAULT_TIMEOUT = 15000;

export async function startLocalSession(
  page,
  { cwd, approvalPolicy = "never", effort, provider, model, initialPrompt, timeoutMs } = {}
) {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT;
  await openStartSessionDialog(page, timeout);

  if (cwd) {
    await setWorkspace(page, cwd, timeout);
  }
  if (provider || model) {
    await selectModel(page, { model, provider }, timeout);
  }
  if (approvalPolicy) {
    await selectPill(page, `${DIALOG_ID}-approval`, approvalPolicy, timeout);
  }
  if (effort) {
    await selectPill(page, `${DIALOG_ID}-effort`, effort, timeout);
  }
  if (initialPrompt) {
    await page.fill(`#${DIALOG_ID}-start-prompt`, initialPrompt);
  }

  await page.waitForFunction(
    (id) => {
      const button = document.getElementById(`${id}-start`);
      return Boolean(button) && !button.disabled;
    },
    DIALOG_ID,
    { timeout }
  );
  await page.click(`#${DIALOG_ID}-start`);
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
  await page.waitForFunction(
    (id) => Boolean(document.getElementById(id)?.open),
    DIALOG_ID,
    { timeout }
  );
}

async function setWorkspace(page, cwd, timeout) {
  const inputSelector = `#${DIALOG_ID}-cwd`;
  const visible = await isVisible(page, inputSelector);
  if (!visible) {
    await page.click(`#${DIALOG_ID} .workspace-picker-trigger`, { timeout });
    await page.waitForSelector(inputSelector, { state: "visible", timeout });
  }
  await page.fill(inputSelector, cwd);
  // The input holds a local draft and publishes it on Enter only; Escape or
  // clicking away discards it.
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (id) => !document.getElementById(id)?.querySelector(".workspace-picker-panel"),
    DIALOG_ID,
    { timeout }
  );
}

// Both constraints apply when both are given: two providers can publish the
// same model id. -1 also means "catalogue not loaded yet" — the caller polls.
export function pickModelOptionIndex(options, { model = null, provider = null } = {}) {
  if (!model && !provider) {
    return -1;
  }
  return (options || []).findIndex(
    (option) =>
      (!model || option.value === model) && (!provider || option.provider === provider)
  );
}

// Runs inside the page (Playwright serializes it), so it may only touch its
// argument and browser globals. Exported so the test drives the shipped code.
export function clickMenuRowInPage(wanted) {
  const row = [...document.querySelectorAll(".setting-pill-menu .setting-pill-option")].find(
    (option) =>
      (option.dataset.value || "") === wanted.value
      && (option.dataset.provider || "") === wanted.provider
  );
  if (!row) {
    return null;
  }
  row.click();
  return { provider: row.dataset.provider || "", value: row.dataset.value || "" };
}

function readMenuOptions(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".setting-pill-menu .setting-pill-option")].map((option) => ({
      provider: option.dataset.provider || "",
      value: option.dataset.value || "",
    }))
  );
}

async function selectModel(page, { model, provider }, timeout) {
  await page.click(`#${DIALOG_ID}-model`, { timeout });

  // No index crosses back into the browser: the catalogue refresh re-renders
  // this menu, so the click re-finds its row by identity in one evaluate.
  const deadline = Date.now() + timeout;
  let options = [];
  for (;;) {
    options = await readMenuOptions(page);
    const index = pickModelOptionIndex(options, { model, provider });

    if (index >= 0) {
      const target = options[index];
      const clicked = await page.evaluate(clickMenuRowInPage, target);

      if (clicked) {
        assert.deepEqual(
          clicked,
          target,
          "the row that was clicked must be the row that matched"
        );
        await page
          .waitForSelector(".setting-pill-menu", { state: "detached", timeout })
          .catch(() => {});
        return;
      }
      // The row went away mid-render; fall through and look again.
    }

    if (Date.now() >= deadline) {
      break;
    }
    await page.waitForTimeout(100);
  }

  await page.keyboard.press("Escape");
  const wanted = [model ? `model "${model}"` : null, provider ? `provider "${provider}"` : null]
    .filter(Boolean)
    .join(" on ");
  const available = options.map((option) => `${option.provider || "?"}:${option.value}`);
  throw new Error(
    `start-session dialog offers no ${wanted}; available: ${available.join(", ") || "(none)"}`
  );
}

async function selectPill(page, triggerId, value, timeout) {
  const present = await page.evaluate((id) => Boolean(document.getElementById(id)), triggerId);
  if (!present) {
    // Not every surface renders every pill.
    return;
  }
  await page.click(`#${triggerId}`, { timeout });
  await page.waitForSelector(".setting-pill-menu .setting-pill-option", { timeout });
  const chose = await page.evaluate((wanted) => {
    const target = [...document.querySelectorAll(".setting-pill-menu .setting-pill-option")].find(
      (option) => option.dataset.value === wanted
    );
    if (!target) {
      return false;
    }
    target.click();
    return true;
  }, value);
  if (!chose) {
    await page.keyboard.press("Escape");
    throw new Error(`start-session dialog offers no "${value}" on #${triggerId}`);
  }
  await page.waitForSelector(".setting-pill-menu", { state: "detached", timeout }).catch(() => {});
}

async function isVisible(page, selector) {
  return page.evaluate((candidate) => {
    const element = document.querySelector(candidate);
    if (!element) {
      return false;
    }
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  }, selector);
}
