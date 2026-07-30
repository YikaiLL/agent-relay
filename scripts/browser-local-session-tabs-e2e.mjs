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

// What the main area is actually rendering is `?thread=` when set, otherwise the
// relay's active session — an empty route means "showing the active one", which is
// what resuming from the sidebar produces. The strip's highlight must agree with it.
function coherence(page, relayPort) {
  return page.evaluate(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/session`);
    const body = await response.json();
    const activeThreadId = body.data?.active_thread_id || null;
    const routedThreadId = new URL(window.location.href).searchParams.get("thread");
    return {
      routedThreadId,
      activeThreadId,
      shownThreadId: routedThreadId || activeThreadId,
      focusedTabThreadId:
        document.querySelector(".session-tab.is-focused")?.dataset.threadId || null,
      tabThreadIds: [...document.querySelectorAll(".session-tab")].map(
        (tab) => tab.dataset.threadId || ""
      ),
    };
  }, relayPort);
}

function assertCoherent(state, label) {
  // A routed session must be present in the strip: the route is how a tab is opened,
  // so a route with no tab means the strip lost track of what is on screen.
  if (state.routedThreadId && !state.tabThreadIds.includes(state.routedThreadId)) {
    throw new Error(
      `${label}: the routed session ${state.routedThreadId} has no tab `
        + `(tabs: ${JSON.stringify(state.tabThreadIds)})`
    );
  }
  // The highlight must name the session on screen — or nothing, when that session
  // has no tab in this workspace (e.g. the active thread belongs to another project).
  const expectedFocus = state.tabThreadIds.includes(state.shownThreadId)
    ? state.shownThreadId
    : null;
  if (state.focusedTabThreadId !== expectedFocus) {
    throw new Error(
      `${label}: focused tab ${state.focusedTabThreadId} disagrees with the session on `
        + `screen ${state.shownThreadId} (expected focus ${expectedFocus})`
    );
  }
}

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

// The sessions list lives in a <details> drawer that is collapsed off the
// conversation view; open it so its rows are laid out and clickable.
async function openThreadDrawer(page) {
  await page.evaluate(() => {
    const drawer = document.querySelector(".sidebar-drawer");
    if (drawer && !drawer.open) {
      drawer.open = true;
      drawer.dispatchEvent(new Event("toggle"));
    }
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

    // --- Closing the LAST tab must not resurrect it ---
    // The strip used to adopt the relay's active thread whenever the route was
    // empty, so emptying the strip immediately refilled it.
    await page.click(`.session-tab[data-thread-id="${threadB}"] .session-tab-pin`);
    await page.click(`.session-tab[data-thread-id="${threadB}"] .session-tab-close`);
    await page.waitForFunction(() => document.querySelectorAll(".session-tab").length === 0, {
      timeout: TIMEOUT_MS,
    });
    await page.waitForTimeout(600); // let a snapshot/render cycle go by
    const emptied = await tabState(page);
    assert.equal(emptied.count, 0, "closing the last tab leaves the strip empty");
    assert.ok(emptied.stripPresent, "the strip itself stays mounted when empty");
    await shoot(page, "06-emptied");

    // --- Back/forward keeps the strip and the transcript in agreement ---
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    const backState = await tabState(page);
    const routedBack = await page.evaluate(() =>
      new URL(window.location.href).searchParams.get("thread")
    );
    if (routedBack) {
      assert.ok(
        backState.threadIds.includes(routedBack),
        `history navigation to ${routedBack} must re-open its tab, got `
          + JSON.stringify(backState.threadIds)
      );
    }

    // --- Sessions mode and Projects mode keep separate tab sets ---
    // Switching back to Sessions leaves `activeProjectId` set, so keying the tab
    // bucket off that value alone made Sessions mode share the last project's tabs.
    // Start this section from a clean slate: the earlier steps (notably the
    // back/forward re-open) leave persisted tabs behind, and this assertion is about
    // isolation between buckets, not about what those steps left.
    await page.evaluate(() => {
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith("sealwire:tab-workspace:")) {
          window.localStorage.removeItem(key);
        }
      }
    });
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#threads-view-projects", { timeout: TIMEOUT_MS });
    await openThreadDrawer(page);

    await page.click(`button.conversation-item[data-thread-id="${threadA}"]`);
    await page.waitForFunction(
      (id) => [...document.querySelectorAll(".session-tab")].some((tab) => tab.dataset.threadId === id),
      threadA,
      { timeout: TIMEOUT_MS }
    );
    const sessionsTabs = (await tabState(page)).threadIds;
    assert.deepEqual(sessionsTabs, [threadA], "Sessions mode holds exactly the opened session");

    assertCoherent(await coherence(page, relayPort), "sessions mode with one open session");

    await page.click("#threads-view-projects");
    await page.waitForFunction(() => document.querySelectorAll(".session-tab").length === 0, {
      timeout: TIMEOUT_MS,
    });
    assert.deepEqual(
      (await tabState(page)).threadIds,
      [],
      "a fresh Projects workspace starts empty rather than inheriting Sessions"
    );
    // The mode switch changed which sessions are "open", so the route had to follow.
    // Leaving it pointed at the Sessions thread would render that transcript under an
    // empty strip — the strip and the main area describing different things.
    const inProjects = await coherence(page, relayPort);
    assertCoherent(inProjects, "after switching to Projects");
    assert.equal(
      inProjects.routedThreadId,
      null,
      `an empty Projects workspace must clear the route, got ${inProjects.routedThreadId}`
    );
    await shoot(page, "07-projects-mode-empty");

    await page.click("#threads-view-sessions");
    await page.waitForFunction(
      (id) => [...document.querySelectorAll(".session-tab")].some((tab) => tab.dataset.threadId === id),
      threadA,
      { timeout: TIMEOUT_MS }
    );
    // Coming back restores that workspace's focused session, route included.
    const backInSessions = await coherence(page, relayPort);
    assertCoherent(backInSessions, "after switching back to Sessions");
    assert.equal(
      backInSessions.routedThreadId,
      threadA,
      "returning to Sessions restores its focused session"
    );
    assert.deepEqual(
      (await tabState(page)).threadIds,
      sessionsTabs,
      "switching back restores the Sessions tab set"
    );
    await shoot(page, "08-sessions-mode-restored");

    // --- Deleting a session must not let history resurrect its tab ---
    // History entries outlive threads, so backing onto a deleted session's entry
    // used to re-create the very tab the delete had just swept.
    await openThreadDrawer(page);
    await page.click(`button.conversation-item[data-thread-id="${threadB}"]`);
    await page.waitForFunction(
      (id) => new URL(window.location.href).searchParams.get("thread") === id,
      threadB,
      { timeout: TIMEOUT_MS }
    );

    page.once("dialog", (dialog) => dialog.accept());
    await page.click(`button.conversation-item[data-thread-id="${threadA}"]`, { button: "right" });
    await page.waitForSelector("#delete-thread-button", { timeout: TIMEOUT_MS });
    await page.click("#delete-thread-button");
    await page.waitForFunction(
      (id) => ![...document.querySelectorAll(".session-tab")].some((tab) => tab.dataset.threadId === id),
      threadA,
      { timeout: TIMEOUT_MS }
    );

    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const afterBackOntoDeleted = await coherence(page, relayPort);
    assert.ok(
      !afterBackOntoDeleted.tabThreadIds.includes(threadA),
      `history must not resurrect a deleted session's tab, got `
        + JSON.stringify(afterBackOntoDeleted.tabThreadIds)
    );
    await page.goForward({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    assert.ok(
      !(await coherence(page, relayPort)).tabThreadIds.includes(threadA),
      "forward navigation must not resurrect it either"
    );
    await shoot(page, "09-deleted-not-resurrected");

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
