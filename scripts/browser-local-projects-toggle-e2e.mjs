// Drives the local web UI to verify the Sessions/Projects experience against the
// current flat-list Projects sidebar: the Sessions/Projects toggle, project rows +
// counts, passive propagation of API membership changes, the fail-closed
// placeholders (Projects unavailable / Loading projects), the thread context-menu
// project actions (assign / unassign / new+assign) and their fail-closed/stale
// guards, and project Rename/Delete via the project context menu (right-click / ⋯).
// Run: AGENT_PROVIDERS=fake node scripts/browser-local-projects-toggle-e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { prepareSeededCodexHome } from "./e2e-codex-home.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);

// Progress breadcrumbs on stderr. This script has ~12 phases behind 45s waits (and one
// reopen loop that can retry 40×), so a silent run is indistinguishable from a hang —
// these say which phase owns the stall.
const startedAt = Date.now();
const step = (message) => console.error(`[step +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);

async function api(relayPort, method, apiPath, body) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${apiPath}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  assert.equal(response.status, 200, `${method} ${apiPath} -> ${response.status}: ${JSON.stringify(payload)}`);
  assert.equal(payload?.ok, true, `${method} ${apiPath} not ok: ${JSON.stringify(payload)}`);
  return payload.data;
}

// Poll the dedicated Projects channel until a thread's membership matches (server
// truth). `expectedProjectId = null` means "unassigned".
async function waitForMembership(relayPort, threadId, expectedProjectId) {
  for (let i = 0; i < 100; i += 1) {
    const data = await api(relayPort, "GET", "/api/projects");
    const current = data.thread_project_id[threadId] ?? null;
    if (current === (expectedProjectId ?? null)) return current;
    await delay(150);
  }
  throw new Error(`membership for ${threadId} never became ${expectedProjectId ?? "unassigned"}`);
}

// The sessions/projects list lives in a collapsed <details> drawer off the
// conversation view — open it so its rows are laid out.
async function openDrawer(page) {
  await page.evaluate(() => {
    const drawer = document.querySelector(".sidebar-drawer");
    if (drawer && !drawer.open) {
      drawer.open = true;
      drawer.dispatchEvent(new Event("toggle"));
    }
  });
}

const projectNames = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim())
  );

// Right-click a thread row (Sessions mode), open its second-level "Projects ›" flyout,
// and read that flyout's buttons. Projects live one level down now: the menu itself only
// carries the trigger row.
async function openThreadMenu(page, tid) {
  // Dismiss whatever a previous step left open first: the menu paints AT the cursor, so
  // a stale one sits on top of the very row this right-click has to hit. Two presses
  // because Escape peels one level at a time (flyout, then menu).
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    (t) => {
      const count = document.querySelector("#threads-count")?.textContent || "";
      if (count.includes("Loading projects")) return false;
      return !!document.querySelector(`#threads-list [data-thread-id="${t}"]`);
    },
    tid,
    { timeout: TIMEOUT_MS }
  );
  await page.locator(`#threads-list [data-thread-id="${tid}"]`).click({ button: "right", position: { x: 24, y: 16 }, timeout: TIMEOUT_MS });
  await page.waitForSelector("#thread-context-menu:not([hidden]) #thread-project-submenu-trigger", { timeout: TIMEOUT_MS });
  await openThreadProjectSubmenu(page);
  await page.waitForFunction(() => {
    const submenu = document.querySelector("#thread-project-submenu");
    return submenu && !submenu.hidden && document.querySelectorAll("#thread-project-actions button").length > 0;
  }, null, { timeout: TIMEOUT_MS });
  return page.evaluate(() => [...document.querySelectorAll("#thread-project-actions button")].map((b) => b.textContent.trim()));
}

// Reveal the second level with a REAL pointer hover, which is how a mouse user gets
// there — a synthetic .click() would skip hit-testing and pass even if the row were
// covered. The pointer parks on a neighbouring row first for two reasons: hover() that
// lands where the pointer already sits fires no mouseenter (silent flake), and crossing
// off the trigger must dismiss the flyout, so reopening proves that rule too.
async function openThreadProjectSubmenu(page) {
  await page.locator("#fork-thread-button").hover({ timeout: TIMEOUT_MS });
  await page.locator("#thread-project-submenu-trigger").hover({ timeout: TIMEOUT_MS });
  await page.waitForSelector("#thread-project-submenu:not([hidden])", { timeout: TIMEOUT_MS });
}

// The trigger row's own value text — the session's project as shown WITHOUT opening the
// flyout ("None" when unassigned).
const threadProjectTriggerValue = (page) =>
  page.evaluate(() => document.querySelector("#thread-project-current-label")?.textContent?.trim() || null);

// Right-click a thread row and read the FIRST level only — no flyout. This is the
// "projects moved one level down" contract: the menu itself carries a single trigger row
// naming the session's project, and zero Project buttons.
async function readThreadMenuFirstLevel(page, tid) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.locator(`#threads-list [data-thread-id="${tid}"]`).click({ button: "right", position: { x: 24, y: 16 }, timeout: TIMEOUT_MS });
  await page.waitForSelector("#thread-context-menu:not([hidden]) #thread-project-submenu-trigger", { timeout: TIMEOUT_MS });
  return page.evaluate(() => ({
    triggerValue: document.querySelector("#thread-project-current-label")?.textContent?.trim() || null,
    submenuHidden: !!document.querySelector("#thread-project-submenu")?.hidden,
    // Rendered, not merely present: the rows are BUILT when the menu opens (so a
    // Projects refresh can withdraw them) but live inside the hidden flyout, so what
    // matters is that none of them are on screen at the first level.
    visibleProjectButtons: [...document.querySelectorAll("#thread-project-actions button")].filter(
      (b) => b.getClientRects().length > 0
    ).length,
    menuButtonLabels: [...document.querySelectorAll("#thread-context-menu .context-menu-button")].map((b) =>
      b.textContent.trim()
    ),
  }));
}

// Geometry of both panels once the flyout is open — it must sit fully on screen and
// beside (never on top of) the menu it flew out of.
const threadMenuGeometry = (page) =>
  page.evaluate(() => {
    const menu = document.querySelector("#thread-context-menu").getBoundingClientRect();
    const submenu = document.querySelector("#thread-project-submenu").getBoundingClientRect();
    return {
      insideViewport:
        submenu.left >= 0
        && submenu.top >= 0
        && submenu.right <= window.innerWidth
        && submenu.bottom <= window.innerHeight,
      horizontallyClear: submenu.left >= menu.right || submenu.right <= menu.left,
      menu: { left: menu.left, right: menu.right, top: menu.top, bottom: menu.bottom },
      submenu: { left: submenu.left, right: submenu.right, top: submenu.top, bottom: submenu.bottom },
    };
  });

// Pick a row in the open flyout with a REAL pointer click. Deliberately not a synthetic
// element.click(): the flyout lives OUTSIDE #thread-context-menu, so a genuine click is
// the only thing that exercises the document-level dismiss handler — which would
// otherwise tear the menu down before the action ran.
async function clickThreadProjectButton(page, predicate) {
  const index = await page.evaluate((arg) => {
    const buttons = [...document.querySelectorAll("#thread-project-actions button")];
    return buttons.findIndex((b) => {
      const text = b.textContent.trim();
      return arg.exact ? text.replace(/^✓\s*/, "") === arg.exact : text.includes(arg.includes);
    });
  }, predicate);
  assert.ok(
    index >= 0,
    `flyout row ${JSON.stringify(predicate)} not found: ${JSON.stringify(
      await page.evaluate(() => [...document.querySelectorAll("#thread-project-actions button")].map((b) => b.textContent.trim()))
    )}`
  );
  await page.locator("#thread-project-actions button").nth(index).click({ timeout: TIMEOUT_MS });
}

// Reopen a thread menu until its Project buttons satisfy `match(labels)`.
async function waitForThreadMenuState(page, tid, match) {
  for (let i = 0; i < 40; i += 1) {
    const labels = await openThreadMenu(page, tid);
    if (match(labels)) return labels;
    // Escape peels one level per press: flyout, then the menu itself. Both must go, or
    // the still-open menu covers the thread row the next right-click needs to hit.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await delay(200);
  }
  throw new Error("thread context menu never reached the expected Project state");
}

// Right-click a project row (Projects mode) to open the project context menu.
async function openProjectMenu(page, name) {
  await page.waitForFunction(
    (n) => [...document.querySelectorAll("#threads-list .thread-group-name")].some((r) => r.textContent.trim() === n),
    name,
    { timeout: TIMEOUT_MS }
  );
  const row = page
    .locator("#threads-list .thread-group-header-project", { hasText: name })
    .first();
  await row.click({ button: "right", timeout: TIMEOUT_MS });
  await page.waitForSelector("#project-context-menu:not([hidden])", { timeout: TIMEOUT_MS });
}

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-projects-toggle-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const codexHomeDir = await prepareSeededCodexHome("agent-relay-projects-toggle-codex-", { requireAuth: false });
  const workspace = path.join(stateDir, "projects-toggle-ws");
  await fs.mkdir(workspace, { recursive: true });

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    codexHomeDir,
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let page;
  try {
    step("1-3. start a fake session, create + assign a project (API)");
    // 1. Start a fake session so a thread exists; 2-3. create + assign a Project.
    const started = await api(relayPort, "POST", "/api/session/start", {
      cwd: workspace,
      device_id: "projects-toggle-device",
      initial_prompt: "hello-projects",
      provider: "fake",
      model: "fake-echo",
      approval_policy: "never",
      sandbox: "workspace-write",
      effort: "medium",
    });
    const threadId = started.active_thread_id;
    assert.ok(threadId, "started thread id");
    for (let i = 0; i < 50; i += 1) {
      const list = await api(relayPort, "GET", "/api/threads?limit=50");
      if ((list.threads || []).some((t) => t.id === threadId)) break;
      await delay(200);
    }

    const created = await api(relayPort, "POST", "/api/projects", { action: "create", name: "VerifyProj" });
    const projectId = created.projects.find((p) => p.name === "VerifyProj")?.id;
    assert.ok(projectId, `created project id: ${JSON.stringify(created)}`);
    await api(relayPort, "POST", "/api/projects", { action: "assign", thread_id: threadId, project_id: projectId });
    const fetched = await api(relayPort, "GET", "/api/projects");
    assert.ok(fetched.projects_revision > 0, `projects_revision > 0: ${fetched.projects_revision}`);
    assert.equal(fetched.thread_project_id[threadId], projectId, "GET /api/projects membership");

    step("4. load the UI");

    // 4. Load the UI (Sessions mode by default).
    ({ browser, context } = await launchBrowser({ contextOptions: { viewport: { width: 1400, height: 1000 } } }));
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await openDrawer(page);
    await page.waitForFunction(
      () => document.querySelectorAll("#threads-list .thread-group").length >= 1,
      null,
      { timeout: TIMEOUT_MS }
    );
    const sessionsView = await page.evaluate(() => ({
      countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
      groupLabels: [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()),
      hasToggle: !!document.querySelector("#threads-view-projects") && !!document.querySelector("#threads-view-sessions"),
    }));
    assert.ok(sessionsView.hasToggle, "the Sessions/Projects toggle buttons exist");
    assert.match(sessionsView.countText, /folder/, `Sessions mode shows folder grouping: ${sessionsView.countText}`);

    step("5. Projects mode rows");

    // 5. Switch to Projects: the sidebar lists each project as a group header,
    //    with its sessions nested underneath.
    await page.evaluate(() => document.querySelector("#threads-view-projects").click());
    await page.waitForFunction(
      (name) => [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()).includes(name),
      "VerifyProj",
      { timeout: TIMEOUT_MS }
    );
    const projectsView = await page.evaluate(({ name, threadId }) => {
      const row = [...document.querySelectorAll("#threads-list .thread-group-header-project")].find(
        (r) => r.querySelector(".thread-group-name")?.textContent?.trim() === name
      );
      return {
        countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
        projectRows: [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()),
        // Projects mode builds its groups from the project list alone, so a
        // session's row is present here IF AND ONLY IF it is assigned. That is a
        // stronger signal than the old "N sessions" badge (now removed — the
        // nested rows already say the count, and it crowded the fold control).
        hasAssignedSession: Boolean(
          document.querySelector(`#threads-list [data-thread-id="${threadId}"]`)
        ),
        verifyBadge: row?.querySelector(".thread-group-badges")?.textContent?.trim() || "",
        hasActionsButton: !!row?.closest(".thread-group-header-project")?.querySelector(".thread-group-action"),
        projectsButtonActive: document.querySelector("#threads-view-projects")?.classList.contains("is-active") || false,
      };
    }, { name: "VerifyProj", threadId });

    step("6. back to Sessions");

    // 6. Switch back to Sessions.
    await page.evaluate(() => document.querySelector("#threads-view-sessions").click());
    await delay(300);
    const backToSessions = await page.evaluate(() => ({
      sessionsButtonActive: document.querySelector("#threads-view-sessions")?.classList.contains("is-active") || false,
      countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
    }));

    step("7. passive membership propagation");

    // 7. Passive propagation: an API unassign (no browser action) flows through the
    // snapshot's projects_revision -> refetch -> re-render, dropping the project's
    // session count. Then re-assign restores it.
    await page.evaluate(() => document.querySelector("#threads-view-projects").click());
    await page.waitForFunction(
      (name) => [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()).includes(name),
      "VerifyProj",
      { timeout: TIMEOUT_MS }
    );
    const verifyBadge = (page) =>
      page.evaluate((name) => {
        const row = [...document.querySelectorAll("#threads-list .thread-group-header-project")].find(
          (r) => r.querySelector(".thread-group-name")?.textContent?.trim() === name
        );
        return row?.querySelector(".thread-group-badges")?.textContent?.trim() || "";
      }, "VerifyProj");
    await api(relayPort, "POST", "/api/projects", { action: "unassign", thread_id: threadId });
    let unassignPropagated = false;
    try {
      // Unassigning removes the session from every project group, so its row
      // disappears from Projects mode entirely. (This used to watch the project
      // badge fall to "0 sessions"; that badge no longer exists.)
      await page.waitForFunction(
        (id) => !document.querySelector(`#threads-list [data-thread-id="${id}"]`),
        threadId,
        { timeout: TIMEOUT_MS }
      );
      unassignPropagated = true;
    } catch {}
    const afterUnassignBadge = await verifyBadge(page);
    await api(relayPort, "POST", "/api/projects", { action: "assign", thread_id: threadId, project_id: projectId });

    step("8. fail closed on a failed fetch");

    // 8. Fail closed: a failed Projects fetch shows an explicit error placeholder and
    // NO project rows — never a false empty/"unassigned" grouping.
    const failPage = await context.newPage();
    await failPage.route("**/api/projects*", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "boom" } }) });
      }
      return route.continue();
    });
    await failPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await openDrawer(failPage);
    await failPage.waitForFunction(() => document.querySelectorAll("#threads-list .thread-group").length >= 1, null, { timeout: TIMEOUT_MS });
    await failPage.evaluate(() => document.querySelector("#threads-view-projects").click());
    await failPage.waitForFunction(
      () => (document.querySelector("#threads-count")?.textContent || "").includes("Projects unavailable"),
      null,
      { timeout: TIMEOUT_MS }
    );
    const failClosed = await failPage.evaluate(() => ({
      countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
      bodyText: document.querySelector("#threads-list")?.textContent?.trim() || "",
      projectRows: [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()),
    }));
    await failPage.close();

    step("9. fail closed on a held refresh");

    // 9. Fail closed on refresh: a newer-revision fetch held in flight shows the
    // loading placeholder with NO rows, then the rows return once it resolves.
    const gatePage = await context.newPage();
    let holdRefresh = false;
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
    await gatePage.route("**/api/projects*", async (route) => {
      if (route.request().method() === "GET" && holdRefresh) await refreshGate;
      return route.continue();
    });
    await gatePage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await openDrawer(gatePage);
    await gatePage.waitForFunction(() => document.querySelectorAll("#threads-list .thread-group").length >= 1, null, { timeout: TIMEOUT_MS });
    await gatePage.evaluate(() => document.querySelector("#threads-view-projects").click());
    await gatePage.waitForFunction(
      (name) => [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()).includes(name),
      "VerifyProj",
      { timeout: TIMEOUT_MS }
    );
    holdRefresh = true;
    await api(relayPort, "POST", "/api/projects", { action: "create", name: "GateProj2" });
    await gatePage.waitForFunction(
      () => (document.querySelector("#threads-count")?.textContent || "").includes("Loading projects"),
      null,
      { timeout: TIMEOUT_MS }
    );
    const gatePending = await gatePage.evaluate(() => ({
      countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
      projectRows: [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()),
    }));
    releaseRefresh();
    holdRefresh = false;
    await gatePage.waitForFunction(
      (name) => [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()).includes(name),
      "VerifyProj",
      { timeout: TIMEOUT_MS }
    );
    await gatePage.close();

    step("10. CRUD UI flows");

    // 10. CRUD UI: toolbar create + thread-menu assign/unassign/new + project-menu
    // rename/delete — the real user flows.
    const crudPage = await context.newPage();
    let nextPrompt = "";
    crudPage.on("dialog", (dialog) => { void dialog.accept(dialog.type() === "prompt" ? nextPrompt : undefined); });
    await crudPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await openDrawer(crudPage);
    await crudPage.waitForFunction(() => document.querySelectorAll("#threads-list .thread-group").length >= 1, null, { timeout: TIMEOUT_MS });

    let menuItems = [];
    let assignedMenuItems = [];
    let triggerValueBeforeAssign = null;
    let triggerValueAssigned = null;
    let triggerValueUnassigned = null;
    let assignConfirmed = null;
    let currentMarked = false;
    let unassignConfirmed = "unset";
    let menuCreateAssign = null;
    let renameConfirmed = false;
    let deleteConfirmed = false;
    let projectMenuClosedOnBump = false;
    let firstLevel = null;
    let geometry = null;
    let keyboardNav = null;
    try {
      step("10. crud flow: create UiCrudProj from the toolbar");
      // Create "UiCrudProj" from the Projects toolbar.
      await crudPage.evaluate(() => document.querySelector("#threads-view-projects").click());
      await crudPage.waitForFunction(() => { const b = document.querySelector("#projects-toolbar"); return b && !b.hidden; }, null, { timeout: TIMEOUT_MS });
      nextPrompt = "UiCrudProj";
      await crudPage.evaluate(() => document.querySelector("#projects-create-button").click());
      await crudPage.waitForFunction(
        (name) => [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()).includes(name),
        "UiCrudProj",
        { timeout: TIMEOUT_MS }
      );
      const afterCreate = await api(relayPort, "GET", "/api/projects");
      const uiProjId = afterCreate.projects.find((p) => p.name === "UiCrudProj")?.id;
      assert.ok(uiProjId, `toolbar-created project id: ${JSON.stringify(afterCreate.projects.map((p) => p.name))}`);

      // Assign / unassign / new+assign via the THREAD context menu (Sessions mode).
      await crudPage.evaluate(() => document.querySelector("#threads-view-sessions").click());
      step("10a. first level only (no flyout)");
      // Level one on its own: Projects are NOT here, just the trigger row naming one.
      firstLevel = await readThreadMenuFirstLevel(crudPage, threadId);
      triggerValueBeforeAssign = firstLevel.triggerValue;
      step("10b. hover-open the flyout and assign UiCrudProj");
      menuItems = await openThreadMenu(crudPage, threadId);
      geometry = await threadMenuGeometry(crudPage);
      await clickThreadProjectButton(crudPage, { exact: "UiCrudProj" });
      assignConfirmed = await waitForMembership(relayPort, threadId, uiProjId);
      assignedMenuItems = await waitForThreadMenuState(crudPage, threadId, (labels) =>
        labels.some((t) => t.startsWith("✓ UiCrudProj"))
      );
      // The trigger row names the session's project without opening the flyout.
      triggerValueAssigned = await threadProjectTriggerValue(crudPage);
      currentMarked = true;

      step("10c. keyboard: ArrowRight into the flyout, Escape peels one level at a time");
      // Escape #1 closes only the flyout and returns focus to the trigger; ArrowRight
      // re-enters it and lands on the first row; Escape #1 again, #2 closes the menu.
      await openThreadMenu(crudPage, threadId);
      await crudPage.keyboard.press("Escape");
      const afterFirstEscape = await crudPage.evaluate(() => ({
        submenuHidden: !!document.querySelector("#thread-project-submenu")?.hidden,
        menuStillOpen: !document.querySelector("#thread-context-menu")?.hidden,
        focusOnTrigger: document.activeElement?.id === "thread-project-submenu-trigger",
      }));
      await crudPage.keyboard.press("ArrowRight");
      const afterArrowRight = await crudPage.evaluate(() => ({
        submenuOpen: !document.querySelector("#thread-project-submenu")?.hidden,
        focusInsideSubmenu: !!document.activeElement?.closest("#thread-project-submenu"),
      }));
      await crudPage.keyboard.press("Escape");
      await crudPage.keyboard.press("Escape");
      const afterSecondEscape = await crudPage.evaluate(() => ({
        menuHidden: !!document.querySelector("#thread-context-menu")?.hidden,
        submenuHidden: !!document.querySelector("#thread-project-submenu")?.hidden,
      }));
      keyboardNav = { afterFirstEscape, afterArrowRight, afterSecondEscape };

      step("10d. remove from project");
      await openThreadMenu(crudPage, threadId);
      await clickThreadProjectButton(crudPage, { includes: "Remove from project" });
      unassignConfirmed = await waitForMembership(relayPort, threadId, null);
      // Back to no project: nothing is checked, and the trigger row says so.
      await waitForThreadMenuState(crudPage, threadId, (labels) => !labels.some((t) => t.startsWith("✓")));
      triggerValueUnassigned = await threadProjectTriggerValue(crudPage);

      step("10e. new project from the flyout");
      await openThreadMenu(crudPage, threadId);
      nextPrompt = "UiMenuProj";
      await clickThreadProjectButton(crudPage, { includes: "New project" });
      for (let i = 0; i < 100; i += 1) {
        const data = await api(relayPort, "GET", "/api/projects");
        const proj = data.projects.find((p) => p.name === "UiMenuProj");
        if (proj && data.thread_project_id[threadId] === proj.id) { menuCreateAssign = proj.id; break; }
        await delay(150);
      }

      // Rename + delete "UiCrudProj" via the PROJECT context menu (Projects mode).
      await crudPage.evaluate(() => document.querySelector("#threads-view-projects").click());
      const renameTargetId = uiProjId;
      nextPrompt = "UiRenamedProj";
      await openProjectMenu(crudPage, "UiCrudProj");
      await crudPage.click("#rename-project-button");
      for (let i = 0; i < 100; i += 1) {
        const data = await api(relayPort, "GET", "/api/projects");
        const renamed = data.projects.find((p) => p.id === renameTargetId);
        if (renamed && renamed.name === "UiRenamedProj") { renameConfirmed = true; break; }
        await delay(150);
      }
      await crudPage.waitForFunction(
        (name) => [...document.querySelectorAll("#threads-list .thread-group-name")].some((n) => n.textContent.trim() === name),
        "UiRenamedProj",
        { timeout: TIMEOUT_MS }
      );
      await openProjectMenu(crudPage, "UiRenamedProj");
      await crudPage.click("#delete-project-button");
      for (let i = 0; i < 100; i += 1) {
        const data = await api(relayPort, "GET", "/api/projects");
        if (!data.projects.some((p) => p.id === renameTargetId)) { deleteConfirmed = true; break; }
        await delay(150);
      }

      // Project-menu fail-closed: with the menu OPEN, a projects-revision bump (remote
      // create) must drop the menu rather than let Rename/Delete act on a stale target.
      await openProjectMenu(crudPage, "UiMenuProj");
      await api(relayPort, "POST", "/api/projects", { action: "create", name: "MenuBump" });
      try {
        await crudPage.waitForFunction(
          () => Boolean(document.querySelector("#project-context-menu")?.hidden),
          null,
          { timeout: TIMEOUT_MS }
        );
        projectMenuClosedOnBump = true;
      } catch {}
    } finally {
      await crudPage.close();
    }

    step("11. thread-menu fail-closed");

    // 11. Thread-menu fail-closed (Sessions mode, GET fails): NO actionable Project
    // buttons, only a non-interactive "unavailable" note.
    const menuFailPage = await context.newPage();
    await menuFailPage.route("**/api/projects*", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "boom" } }) });
      }
      return route.continue();
    });
    await menuFailPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await openDrawer(menuFailPage);
    const menuFailTarget = menuFailPage.locator(`#threads-list [data-thread-id="${threadId}"]`);
    await menuFailTarget.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    await menuFailTarget.click({ button: "right", position: { x: 24, y: 16 }, timeout: TIMEOUT_MS });
    await menuFailPage.waitForSelector("#thread-context-menu:not([hidden]) #thread-project-submenu-trigger", { timeout: TIMEOUT_MS });
    await openThreadProjectSubmenu(menuFailPage);
    await menuFailPage.waitForFunction(() => {
      const submenu = document.querySelector("#thread-project-submenu");
      const note = document.querySelector("#thread-project-actions .context-menu-note");
      return submenu && !submenu.hidden && !!note;
    }, null, { timeout: TIMEOUT_MS });
    const menuFailClosed = await menuFailPage.evaluate(() => ({
      buttonCount: document.querySelectorAll("#thread-project-actions button").length,
      note: document.querySelector("#thread-project-actions .context-menu-note")?.textContent?.trim() || null,
      // Must NOT read "None" — that would assert non-membership we can't vouch for.
      triggerValue: document.querySelector("#thread-project-current-label")?.textContent?.trim() || null,
      sessionsActive: document.querySelector("#threads-view-sessions")?.classList.contains("is-active") || false,
    }));
    await menuFailPage.close();

    step("12. open thread-menu goes stale");

    // 12. Open thread-menu goes stale: a held newer-revision refresh withdraws buttons.
    const staleMenuPage = await context.newPage();
    let holdMenuRefresh = false;
    let releaseMenuRefresh;
    const menuRefreshGate = new Promise((resolve) => { releaseMenuRefresh = resolve; });
    await staleMenuPage.route("**/api/projects*", async (route) => {
      if (route.request().method() === "GET" && holdMenuRefresh) await menuRefreshGate;
      return route.continue();
    });
    await staleMenuPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await openDrawer(staleMenuPage);
    const staleTarget = staleMenuPage.locator(`#threads-list [data-thread-id="${threadId}"]`);
    await staleTarget.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    await staleTarget.click({ button: "right", position: { x: 24, y: 16 }, timeout: TIMEOUT_MS });
    await staleMenuPage.waitForSelector("#thread-context-menu:not([hidden]) #thread-project-submenu-trigger", { timeout: TIMEOUT_MS });
    await openThreadProjectSubmenu(staleMenuPage);
    await staleMenuPage.waitForFunction(
      () => { const submenu = document.querySelector("#thread-project-submenu"); return submenu && !submenu.hidden && document.querySelectorAll("#thread-project-actions button").length > 0; },
      null,
      { timeout: TIMEOUT_MS }
    );
    holdMenuRefresh = true;
    await api(relayPort, "POST", "/api/projects", { action: "create", name: "StaleBump" });
    await staleMenuPage.waitForFunction(
      () => document.querySelectorAll("#thread-project-actions button").length === 0 && !!document.querySelector("#thread-project-actions .context-menu-note"),
      null,
      { timeout: TIMEOUT_MS }
    );
    const staleMenu = await staleMenuPage.evaluate(() => ({
      buttonCount: document.querySelectorAll("#thread-project-actions button").length,
      note: document.querySelector("#thread-project-actions .context-menu-note")?.textContent?.trim() || null,
      menuOpen: !document.querySelector("#thread-context-menu")?.hidden,
    }));
    releaseMenuRefresh();
    holdMenuRefresh = false;
    await staleMenuPage.close();

    console.log(JSON.stringify({
      sessionsView, projectsView, backToSessions,
      unassignPropagated, afterUnassignBadge, failClosed, gatePending,
      crud: { menuItems, assignedMenuItems, triggerValueBeforeAssign, triggerValueAssigned, triggerValueUnassigned, assignConfirmed, currentMarked, unassignConfirmed, menuCreateAssign, renameConfirmed, deleteConfirmed, projectMenuClosedOnBump },
      submenu: { firstLevel, geometry, keyboardNav },
      menuFailClosed, staleMenu,
    }, null, 2));

    // --- Assertions ---
    assert.ok(projectsView.projectRows.includes("VerifyProj"), "VerifyProj row renders in Projects mode");
    assert.match(projectsView.countText, /1 project\b/, `count text = '1 project': ${projectsView.countText}`);
    assert.ok(
      projectsView.hasAssignedSession,
      `the assigned session shows under its project in Projects mode: ${JSON.stringify(projectsView.projectRows)}`
    );
    assert.ok(projectsView.hasActionsButton, "each project header exposes visible action buttons (touch/keyboard reachable)");
    assert.ok(projectsView.projectsButtonActive, "Projects toggle button is active");
    assert.ok(backToSessions.sessionsButtonActive, "Sessions toggle re-activates");
    assert.match(backToSessions.countText, /folder/, `back to Sessions shows folder grouping: ${backToSessions.countText}`);
    assert.ok(unassignPropagated, `an API unassign propagates to the live project row count: ${afterUnassignBadge}`);

    assert.equal(failClosed.countText, "Projects unavailable", `fail-closed count: ${failClosed.countText}`);
    assert.deepEqual(failClosed.projectRows, [], `no rows rendered on fetch failure: ${JSON.stringify(failClosed.projectRows)}`);
    assert.match(failClosed.bodyText, /Failed to load projects/, `error message shown: ${failClosed.bodyText}`);

    assert.match(gatePending.countText, /Loading projects/, `pending refresh shows a loading placeholder: ${gatePending.countText}`);
    assert.deepEqual(gatePending.projectRows, [], `no stale rows while a newer revision is pending: ${JSON.stringify(gatePending.projectRows)}`);

    assert.ok(menuItems.some((t) => t.replace(/^✓\s*/, "") === "UiCrudProj"), `thread menu lists the toolbar-created project: ${JSON.stringify(menuItems)}`);
    assert.ok(assignConfirmed, "assigning via the thread menu recorded membership server-side");
    assert.ok(currentMarked, "the assigned project is marked current (✓) on reopen");
    // Second-level menu contract: the session's own project leads the flyout, and the
    // first-level row names it without opening anything.
    assert.match(
      assignedMenuItems[0] || "",
      /^✓ UiCrudProj$/,
      `the session's own project leads the flyout: ${JSON.stringify(assignedMenuItems)}`
    );
    assert.equal(triggerValueAssigned, "UiCrudProj", `the trigger row names the session's project: ${triggerValueAssigned}`);
    assert.notEqual(triggerValueBeforeAssign, "UiCrudProj", "the trigger row didn't already claim the target project");
    assert.equal(triggerValueUnassigned, "None", `after Remove, the trigger row reads None: ${triggerValueUnassigned}`);

    // Projects live one level DOWN: the menu itself shows only the trigger row.
    assert.equal(firstLevel.submenuHidden, true, "the flyout starts closed on a fresh right-click");
    assert.equal(
      firstLevel.visibleProjectButtons,
      0,
      `no Project rows are on screen at the first level: ${firstLevel.visibleProjectButtons}`
    );
    assert.equal(
      firstLevel.menuButtonLabels.filter((label) => label.startsWith("Projects")).length,
      1,
      `exactly one Projects row at the first level: ${JSON.stringify(firstLevel.menuButtonLabels)}`
    );
    // That single row carries the session's project name (label + value concatenated).
    assert.match(
      firstLevel.menuButtonLabels.find((label) => label.startsWith("Projects")) || "",
      new RegExp(`^Projects${firstLevel.triggerValue}$`),
      `the Projects row names the current project: ${JSON.stringify(firstLevel)}`
    );
    assert.ok(
      firstLevel.triggerValue && firstLevel.triggerValue !== "None",
      `the seeded session shows its project at the first level: ${firstLevel.triggerValue}`
    );

    assert.equal(geometry.insideViewport, true, `the flyout stays on screen: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.horizontallyClear, true, `the flyout sits beside the menu, not over it: ${JSON.stringify(geometry)}`);

    assert.deepEqual(
      keyboardNav.afterFirstEscape,
      { submenuHidden: true, menuStillOpen: true, focusOnTrigger: true },
      `Escape peels the flyout only, handing focus back to the trigger: ${JSON.stringify(keyboardNav.afterFirstEscape)}`
    );
    assert.deepEqual(
      keyboardNav.afterArrowRight,
      { submenuOpen: true, focusInsideSubmenu: true },
      `ArrowRight enters the flyout and focuses a row: ${JSON.stringify(keyboardNav.afterArrowRight)}`
    );
    assert.deepEqual(
      keyboardNav.afterSecondEscape,
      { menuHidden: true, submenuHidden: true },
      `a second Escape closes the menu itself: ${JSON.stringify(keyboardNav.afterSecondEscape)}`
    );
    assert.equal(unassignConfirmed, null, "removing via the thread menu cleared membership server-side");
    assert.ok(menuCreateAssign, "'New project…' both creates the project and assigns the session");
    assert.ok(renameConfirmed, "renaming via the project context menu updates the name server-side");
    assert.ok(deleteConfirmed, "deleting via the project context menu removes the project server-side");
    assert.ok(projectMenuClosedOnBump, "an open project menu closes fail-closed when the projects revision changes");

    assert.equal(menuFailClosed.sessionsActive, true, "thread-menu fail-closed probe stays in Sessions mode");
    assert.equal(menuFailClosed.buttonCount, 0, `no Project mutation buttons while the fetch is failing: ${menuFailClosed.buttonCount}`);
    assert.match(menuFailClosed.note || "", /Projects unavailable|Loading projects/, `a fail-closed note replaces the controls: ${menuFailClosed.note}`);
    assert.match(
      menuFailClosed.triggerValue || "",
      /Unavailable|Loading/,
      `the trigger row shows a status word, never "None", while the payload is untrustworthy: ${menuFailClosed.triggerValue}`
    );

    assert.equal(staleMenu.buttonCount, 0, `an open thread menu withdraws its buttons on a pending refresh: ${staleMenu.buttonCount}`);
    assert.match(staleMenu.note || "", /Loading projects/, `the open thread menu falls closed to a loading note: ${staleMenu.note}`);
    assert.ok(staleMenu.menuOpen, "the thread menu stays open while its controls are withdrawn");

    console.log("PROJECTS_TOGGLE_E2E: PASS");
  } catch (error) {
    console.error("PROJECTS_TOGGLE_E2E: FAIL");
    console.error(error);
    dumpProcessLogs(relay);
    process.exitCode = 1;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(codexHomeDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
