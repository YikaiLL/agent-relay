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

// The view route is the ONLY thing that puts a session on screen: with no `?thread=`
// the renderer shows the console home or a project overview, never the active
// conversation. So coherence is read from the route and the DOM — deliberately NOT
// from `active_thread_id`, which says nothing about what is displayed.
function coherence(page) {
  return page.evaluate(() => ({
    routedThreadId: new URL(window.location.href).searchParams.get("thread"),
    mainView: document.querySelector(".chat-shell")?.dataset.view || null,
    focusedTabThreadId:
      document.querySelector(".session-tab.is-focused")?.dataset.threadId || null,
    tabThreadIds: [...document.querySelectorAll(".session-tab")].map(
      (tab) => tab.dataset.threadId || ""
    ),
  }));
}

function assertCoherent(state, label) {
  const where = `route=${state.routedThreadId} view=${state.mainView} `
    + `focus=${state.focusedTabThreadId} tabs=${JSON.stringify(state.tabThreadIds)}`;

  if (state.routedThreadId) {
    // The route is how a tab gets opened, so a routed session with no tab means the
    // strip lost track of what is on screen.
    if (!state.tabThreadIds.includes(state.routedThreadId)) {
      throw new Error(`${label}: the routed session has no tab — ${where}`);
    }
    if (state.focusedTabThreadId !== state.routedThreadId) {
      throw new Error(`${label}: the highlight disagrees with the route — ${where}`);
    }
    return;
  }

  // No route means Home or a project overview is showing. Nothing is on screen for a
  // tab to be "current" for, so nothing may be highlighted — including when a relay
  // session is active, which is exactly where the old active-thread fallback lied.
  if (state.focusedTabThreadId) {
    throw new Error(`${label}: a tab claims focus while no session is routed — ${where}`);
  }
  // Cross-check against the renderer: with no view route the main area must not be a
  // conversation.
  //
  // Only this direction is asserted. The converse does NOT hold — the renderer's
  // `isViewingConversation` is `viewThreadId === active_thread_id`, so a routed but
  // NON-active session renders read-only inside the console view, and demanding
  // "route ⇒ conversation" would fail on every view-only tab.
  if (state.mainView === "conversation") {
    throw new Error(`${label}: a conversation is rendered with no session routed — ${where}`);
  }
}

/**
 * Wait until the strip, the route and the main area agree, then assert it.
 *
 * The invariant is EVENTUAL, not instantaneous: React renders asynchronously, and the
 * route is written inside a view transition, so sampling one moment after a navigation
 * catches a legitimate in-between frame. Polling still fails loudly — the final
 * assertion runs on the last sample if it never settles.
 */
async function waitForCoherent(page, label, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = await coherence(page);
  while (Date.now() < deadline) {
    try {
      assertCoherent(last, label);
      return last;
    } catch {
      await page.waitForTimeout(100);
      last = await coherence(page);
    }
  }
  assertCoherent(last, `${label} (never settled)`);
  return last;
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
    // Unpinning re-renders the strip, so wait for that to land before clicking the
    // close button — otherwise the second click races the re-render.
    await page.waitForFunction(
      (id) =>
        !document
          .querySelector(`.session-tab[data-thread-id="${id}"]`)
          ?.className.includes("is-pinned"),
      threadB,
      { timeout: TIMEOUT_MS }
    );
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

    await page.waitForSelector(`button.conversation-item[data-thread-id="${threadA}"]`, {
      timeout: TIMEOUT_MS,
    });
    await page.click(`button.conversation-item[data-thread-id="${threadA}"]`);
    await page.waitForFunction(
      (id) => [...document.querySelectorAll(".session-tab")].some((tab) => tab.dataset.threadId === id),
      threadA,
      { timeout: TIMEOUT_MS }
    );
    const sessionsTabs = (await tabState(page)).threadIds;
    assert.deepEqual(sessionsTabs, [threadA], "Sessions mode holds exactly the opened session");

    await waitForCoherent(page, "sessions mode with one open session");

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
    const inProjects = await coherence(page);
    await waitForCoherent(page, "after switching to Projects");
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
    const backInSessions = await coherence(page);
    await waitForCoherent(page, "after switching back to Sessions");
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
    await page.waitForSelector(`button.conversation-item[data-thread-id="${threadB}"]`, {
      timeout: TIMEOUT_MS,
    });
    await page.click(`button.conversation-item[data-thread-id="${threadB}"]`);
    await page.waitForFunction(
      (id) => new URL(window.location.href).searchParams.get("thread") === id,
      threadB,
      { timeout: TIMEOUT_MS }
    );

    page.once("dialog", (dialog) => dialog.accept());
    await page.waitForSelector(`button.conversation-item[data-thread-id="${threadA}"]`, {
      timeout: TIMEOUT_MS,
    });
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
    const afterBackOntoDeleted = await coherence(page);
    assert.ok(
      !afterBackOntoDeleted.tabThreadIds.includes(threadA),
      `history must not resurrect a deleted session's tab, got `
        + JSON.stringify(afterBackOntoDeleted.tabThreadIds)
    );
    // Refusing the tab is not enough: the route must not be left pointing at the dead
    // session either, or the main area shows it with no tab to match.
    assert.notEqual(
      afterBackOntoDeleted.routedThreadId,
      threadA,
      "the route must not stay on a deleted session"
    );
    await waitForCoherent(page, "after backing onto a deleted session");

    await page.goForward({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    const afterForward = await coherence(page);
    assert.ok(
      !afterForward.tabThreadIds.includes(threadA),
      "forward navigation must not resurrect it either"
    );
    await waitForCoherent(page, "after forward navigation");
    await shoot(page, "09-deleted-not-resurrected");

    // --- The tombstone has to survive a reload ---
    // History entries outlive the page, so an in-memory-only tombstone is empty again
    // exactly when the stale entries are still in the back stack.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".session-tab-strip", { timeout: TIMEOUT_MS });
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const afterReloadBack = await coherence(page);
    assert.ok(
      !afterReloadBack.tabThreadIds.includes(threadA),
      `a reload must not lose the tombstone, got ${JSON.stringify(afterReloadBack.tabThreadIds)}`
    );
    await waitForCoherent(page, "after delete → reload → back");

    // --- Home shows no session, so no tab may be highlighted ---
    // Even with a live relay session: an empty route means Home, not the active
    // conversation, which is where the old active-thread fallback lied.
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".session-tab-strip", { timeout: TIMEOUT_MS });
    await openThreadDrawer(page);
    await page.waitForSelector(`button.conversation-item[data-thread-id="${threadB}"]`, {
      timeout: TIMEOUT_MS,
    });
    await page.click(`button.conversation-item[data-thread-id="${threadB}"]`);
    await page.waitForFunction(
      (id) => new URL(window.location.href).searchParams.get("thread") === id,
      threadB,
      { timeout: TIMEOUT_MS }
    );
    await waitForCoherent(page, "viewing a session before going Home");

    await page.click("#go-console-home-sidebar");
    await page.waitForFunction(
      () => !new URL(window.location.href).searchParams.get("thread"),
      { timeout: TIMEOUT_MS }
    );
    await page.waitForTimeout(400);
    const atHome = await coherence(page);
    assert.ok(atHome.tabThreadIds.length > 0, "the strip still lists the open sessions at Home");
    await waitForCoherent(page, "at Home with an open session");
    await shoot(page, "10-home-no-focus");

    // --- Launching straight onto a deleted session's URL ---
    // The initial load adopts `?thread=` from the address bar without going through
    // any navigation handler, so it needs the same tombstone reconciliation that
    // back/forward does — this used to be the one entry point that skipped it and
    // created a dead tab on startup.
    await page.goto(`http://127.0.0.1:${relayPort}/?thread=${encodeURIComponent(threadA)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector(".session-tab-strip", { timeout: TIMEOUT_MS });
    await page.waitForTimeout(1200);
    const launchedOnDeleted = await coherence(page);
    assert.ok(
      !launchedOnDeleted.tabThreadIds.includes(threadA),
      `launching on a deleted session must not create its tab, got `
        + JSON.stringify(launchedOnDeleted.tabThreadIds)
    );
    assert.notEqual(
      launchedOnDeleted.routedThreadId,
      threadA,
      "the dead route must be replaced, not kept"
    );
    await waitForCoherent(page, "after launching on a deleted session's URL");
    await shoot(page, "11-launch-on-deleted");

    // --- A deletion in one window is honoured by another already-open window ---
    // The tombstone check reads storage on every navigation instead of caching a copy
    // at page init, so window B does not need a reload to learn about A's deletion.
    const pageB = await launched.context.newPage();
    pageB.on("pageerror", (error) => pageErrors.push(`[pageB] ${error.stack || error.message}`));
    await pageB.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await pageB.waitForSelector(".session-tab-strip", { timeout: TIMEOUT_MS });
    await openThreadDrawer(pageB);
    await pageB.waitForSelector(`button.conversation-item[data-thread-id="${threadB}"]`, {
      timeout: TIMEOUT_MS,
    });
    await pageB.click(`button.conversation-item[data-thread-id="${threadB}"]`);
    await pageB.waitForFunction(
      (id) => new URL(window.location.href).searchParams.get("thread") === id,
      threadB,
      { timeout: TIMEOUT_MS }
    );

    // Window A deletes the session window B is sitting on.
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".session-tab-strip", { timeout: TIMEOUT_MS });
    await openThreadDrawer(page);
    page.once("dialog", (dialog) => dialog.accept());
    await page.waitForSelector(`button.conversation-item[data-thread-id="${threadB}"]`, {
      timeout: TIMEOUT_MS,
    });
    await page.click(`button.conversation-item[data-thread-id="${threadB}"]`, { button: "right" });
    await page.waitForSelector("#delete-thread-button", { timeout: TIMEOUT_MS });
    await page.click("#delete-thread-button");
    await page.waitForTimeout(1000);

    // B navigates back onto the now-dead session; no reload, no storage event.
    await pageB.goBack({ waitUntil: "domcontentloaded" });
    await pageB.waitForTimeout(1000);
    const windowB = await coherence(pageB);
    assert.ok(
      !windowB.tabThreadIds.includes(threadB),
      `another window's deletion must be honoured without a reload, got `
        + JSON.stringify(windowB.tabThreadIds)
    );
    await waitForCoherent(pageB, "second window after the first deleted the session");
    await pageB.close();

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
