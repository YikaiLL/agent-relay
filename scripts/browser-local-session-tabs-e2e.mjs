// Drives the local web UI to verify the per-project session tab strip: a started
// session appears as a tab, a second session adds a second tab, clicking a tab
// switches the viewed transcript, pinning floats a tab into the pinned zone, and
// closing removes the tab without deleting the session.
//
// Run: AGENT_PROVIDERS=fake node scripts/browser-local-session-tabs-e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const SHOT_DIR = process.env.BROWSER_E2E_SHOT_DIR || "";

function tabState(page) {
  return page.evaluate(() => {
    const tabs = [...document.querySelectorAll(".session-tab")];
    return {
      count: tabs.length,
      titles: tabs.map((tab) => tab.querySelector(".session-tab-title")?.textContent || ""),
      threadIds: tabs.map((tab) => tab.dataset.threadId || ""),
      pinned: tabs.map((tab) => tab.className.includes("is-pinned")),
      focusedThreadId:
        document.querySelector(".session-tab.is-focused")?.dataset.threadId || null,
      stripPresent: Boolean(document.querySelector(".session-tab-strip")),
    };
  });
}

async function shoot(page, name) {
  if (!SHOT_DIR) {
    return;
  }
  await fs.mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: false });
}

async function run() {
  const relayPort = await getFreePort();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "session-tabs-e2e-"));
  const workspaceDir = path.join(tmp, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: path.join(tmp, "session.json"),
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });

  let browser;
  const pageErrors = [];
  try {
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
    const launched = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 800 } },
    });
    browser = launched.browser;
    const page = await launched.context.newPage();
    attachPageDebugLogging(page, "local", { prefix: "local-session-tabs-e2e" });
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog", { timeout: TIMEOUT_MS });

    // --- The strip mounts even with nothing open ---
    await page.waitForSelector(".session-tab-strip", { timeout: TIMEOUT_MS });

    // --- A started session becomes a tab, without any explicit "open" click.
    // This is the path that has no viewThreadId, so it proves the strip tracks
    // whatever the main area is actually showing. ---
    await startLocalSession(page, {
      cwd: workspaceDir,
      approvalPolicy: "bypass",
      provider: "fake",
      model: "fake-echo",
      timeoutMs: TIMEOUT_MS,
    });
    await page.waitForFunction(() => document.querySelectorAll(".session-tab").length === 1, {
      timeout: TIMEOUT_MS,
    });
    const first = await tabState(page);
    assert.equal(first.count, 1, "the started session shows as one tab");
    const threadA = first.threadIds[0];
    assert.ok(threadA, "the tab carries its thread id");
    assert.equal(first.focusedThreadId, threadA, "the started session's tab is focused");
    await shoot(page, "01-one-tab");

    // --- A second session adds a second tab and takes focus ---
    await startLocalSession(page, {
      cwd: workspaceDir,
      approvalPolicy: "bypass",
      provider: "fake",
      model: "fake-echo",
      timeoutMs: TIMEOUT_MS,
    });
    await page.waitForFunction(() => document.querySelectorAll(".session-tab").length === 2, {
      timeout: TIMEOUT_MS,
    });
    const two = await tabState(page);
    const threadB = two.threadIds.find((id) => id !== threadA);
    assert.ok(threadB, "the second session has its own tab");
    assert.equal(two.focusedThreadId, threadB, "the newest session is focused");
    await shoot(page, "02-two-tabs");

    // --- Clicking a tab switches which session is viewed ---
    await page.click(`.session-tab[data-thread-id="${threadA}"] .session-tab-main`);
    await page.waitForFunction(
      (id) => document.querySelector(".session-tab.is-focused")?.dataset.threadId === id,
      threadA,
      { timeout: TIMEOUT_MS }
    );
    const routed = await page.evaluate(() => new URL(window.location.href).searchParams.get("thread"));
    assert.equal(routed, threadA, "focusing a tab routes the viewed thread");
    await shoot(page, "03-switched");

    // --- Pinning floats the tab to the front of the strip ---
    await page.click(`.session-tab[data-thread-id="${threadB}"] .session-tab-pin`);
    await page.waitForFunction(
      (id) => document.querySelector(".session-tab")?.dataset.threadId === id,
      threadB,
      { timeout: TIMEOUT_MS }
    );
    const pinned = await tabState(page);
    assert.deepEqual(pinned.pinned, [true, false], "the pinned tab holds the first slot");
    assert.equal(pinned.threadIds[0], threadB);
    await shoot(page, "04-pinned");

    // --- Closing removes the tab but not the session ---
    await page.click(`.session-tab[data-thread-id="${threadA}"] .session-tab-close`);
    await page.waitForFunction(() => document.querySelectorAll(".session-tab").length === 1, {
      timeout: TIMEOUT_MS,
    });
    const afterClose = await tabState(page);
    assert.deepEqual(afterClose.threadIds, [threadB], "only the closed tab went away");

    // The relay wraps list responses in an envelope: { ok, data: { threads } }.
    const threadsStillOnRelay = await page.evaluate(async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/threads?limit=50`);
      const body = await response.json();
      return (body.data?.threads || []).map((thread) => thread.id);
    }, relayPort);
    assert.ok(
      threadsStillOnRelay.includes(threadA),
      "closing a tab must not delete the session from the relay"
    );
    await shoot(page, "05-closed");

    // --- Tabs survive a reload (browser-local persistence) ---
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".session-tab", { timeout: TIMEOUT_MS });
    const reloaded = await tabState(page);
    assert.ok(
      reloaded.threadIds.includes(threadB),
      `the pinned tab survives a reload, got ${JSON.stringify(reloaded.threadIds)}`
    );

    assert.deepEqual(pageErrors, [], `no page errors: ${pageErrors.join("\n")}`);
    console.log("local session tabs e2e: OK");
  } finally {
    await browser?.close?.();
    await stopManagedProcess(relay);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
