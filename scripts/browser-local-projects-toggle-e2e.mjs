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
    [...document.querySelectorAll("#threads-list .project-sidebar-name")].map((n) => n.textContent.trim())
  );

// Right-click a thread row (Sessions mode) and read its Project-section buttons.
async function openThreadMenu(page, tid) {
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
  await page.waitForFunction(() => {
    const menu = document.querySelector("#thread-context-menu");
    return menu && !menu.hidden && document.querySelectorAll("#thread-project-actions button").length > 0;
  }, null, { timeout: TIMEOUT_MS });
  return page.evaluate(() => [...document.querySelectorAll("#thread-project-actions button")].map((b) => b.textContent.trim()));
}

const clickThreadProjectButton = (page, predicate) =>
  page.evaluate((arg) => {
    const btn = [...document.querySelectorAll("#thread-project-actions button")].find((b) => {
      const text = b.textContent.trim();
      return arg.exact ? text.replace(/^✓\s*/, "") === arg.exact : text.includes(arg.includes);
    });
    btn?.click();
  }, predicate);

// Reopen a thread menu until its Project buttons satisfy `match(labels)`.
async function waitForThreadMenuState(page, tid, match) {
  for (let i = 0; i < 40; i += 1) {
    const labels = await openThreadMenu(page, tid);
    if (match(labels)) return labels;
    await page.keyboard.press("Escape");
    await delay(200);
  }
  throw new Error("thread context menu never reached the expected Project state");
}

// Right-click a project row (Projects mode) to open the project context menu.
async function openProjectMenu(page, name) {
  await page.waitForFunction(
    (n) => [...document.querySelectorAll("#threads-list .project-sidebar-name")].some((r) => r.textContent.trim() === n),
    name,
    { timeout: TIMEOUT_MS }
  );
  const row = page
    .locator("#threads-list .project-sidebar-row", { hasText: name })
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

    // 5. Switch to Projects: the sidebar lists project ROWS (not thread groups).
    await page.evaluate(() => document.querySelector("#threads-view-projects").click());
    await page.waitForFunction(
      (name) => [...document.querySelectorAll("#threads-list .project-sidebar-name")].map((n) => n.textContent.trim()).includes(name),
      "VerifyProj",
      { timeout: TIMEOUT_MS }
    );
    const projectsView = await page.evaluate((name) => {
      const row = [...document.querySelectorAll("#threads-list .project-sidebar-row")].find(
        (r) => r.querySelector(".project-sidebar-name")?.textContent?.trim() === name
      );
      return {
        countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
        projectRows: [...document.querySelectorAll("#threads-list .project-sidebar-name")].map((n) => n.textContent.trim()),
        verifyBadge: row?.querySelector(".project-sidebar-badges")?.textContent?.trim() || "",
        hasActionsButton: !!row?.closest(".project-sidebar-row-wrap")?.querySelector(".project-sidebar-more"),
        projectsButtonActive: document.querySelector("#threads-view-projects")?.classList.contains("is-active") || false,
      };
    }, "VerifyProj");

    // 6. Switch back to Sessions.
    await page.evaluate(() => document.querySelector("#threads-view-sessions").click());
    await delay(300);
    const backToSessions = await page.evaluate(() => ({
      sessionsButtonActive: document.querySelector("#threads-view-sessions")?.classList.contains("is-active") || false,
      countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
    }));

    // 7. Passive propagation: an API unassign (no browser action) flows through the
    // snapshot's projects_revision -> refetch -> re-render, dropping the project's
    // session count. Then re-assign restores it.
    await page.evaluate(() => document.querySelector("#threads-view-projects").click());
    await page.waitForFunction(
      (name) => [...document.querySelectorAll("#threads-list .project-sidebar-name")].map((n) => n.textContent.trim()).includes(name),
      "VerifyProj",
      { timeout: TIMEOUT_MS }
    );
    const verifyBadge = (page) =>
      page.evaluate((name) => {
        const row = [...document.querySelectorAll("#threads-list .project-sidebar-row")].find(
          (r) => r.querySelector(".project-sidebar-name")?.textContent?.trim() === name
        );
        return row?.querySelector(".project-sidebar-badges")?.textContent?.trim() || "";
      }, "VerifyProj");
    await api(relayPort, "POST", "/api/projects", { action: "unassign", thread_id: threadId });
    let unassignPropagated = false;
    try {
      await page.waitForFunction(
        (name) => {
          const row = [...document.querySelectorAll("#threads-list .project-sidebar-row")].find(
            (r) => r.querySelector(".project-sidebar-name")?.textContent?.trim() === name
          );
          return /0\s+session/.test(row?.querySelector(".project-sidebar-badges")?.textContent || "");
        },
        "VerifyProj",
        { timeout: TIMEOUT_MS }
      );
      unassignPropagated = true;
    } catch {}
    const afterUnassignBadge = await verifyBadge(page);
    await api(relayPort, "POST", "/api/projects", { action: "assign", thread_id: threadId, project_id: projectId });

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
      projectRows: [...document.querySelectorAll("#threads-list .project-sidebar-name")].map((n) => n.textContent.trim()),
    }));
    await failPage.close();

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
      (name) => [...document.querySelectorAll("#threads-list .project-sidebar-name")].map((n) => n.textContent.trim()).includes(name),
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
      projectRows: [...document.querySelectorAll("#threads-list .project-sidebar-name")].map((n) => n.textContent.trim()),
    }));
    releaseRefresh();
    holdRefresh = false;
    await gatePage.waitForFunction(
      (name) => [...document.querySelectorAll("#threads-list .project-sidebar-name")].map((n) => n.textContent.trim()).includes(name),
      "VerifyProj",
      { timeout: TIMEOUT_MS }
    );
    await gatePage.close();

    // 10. CRUD UI: toolbar create + thread-menu assign/unassign/new + project-menu
    // rename/delete — the real user flows.
    const crudPage = await context.newPage();
    let nextPrompt = "";
    crudPage.on("dialog", (dialog) => { void dialog.accept(dialog.type() === "prompt" ? nextPrompt : undefined); });
    await crudPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await openDrawer(crudPage);
    await crudPage.waitForFunction(() => document.querySelectorAll("#threads-list .thread-group").length >= 1, null, { timeout: TIMEOUT_MS });

    let menuItems = [];
    let assignConfirmed = null;
    let currentMarked = false;
    let unassignConfirmed = "unset";
    let menuCreateAssign = null;
    let renameConfirmed = false;
    let deleteConfirmed = false;
    let projectMenuClosedOnBump = false;
    try {
      // Create "UiCrudProj" from the Projects toolbar.
      await crudPage.evaluate(() => document.querySelector("#threads-view-projects").click());
      await crudPage.waitForFunction(() => { const b = document.querySelector("#projects-toolbar"); return b && !b.hidden; }, null, { timeout: TIMEOUT_MS });
      nextPrompt = "UiCrudProj";
      await crudPage.evaluate(() => document.querySelector("#projects-create-button").click());
      await crudPage.waitForFunction(
        (name) => [...document.querySelectorAll("#threads-list .project-sidebar-name")].map((n) => n.textContent.trim()).includes(name),
        "UiCrudProj",
        { timeout: TIMEOUT_MS }
      );
      const afterCreate = await api(relayPort, "GET", "/api/projects");
      const uiProjId = afterCreate.projects.find((p) => p.name === "UiCrudProj")?.id;
      assert.ok(uiProjId, `toolbar-created project id: ${JSON.stringify(afterCreate.projects.map((p) => p.name))}`);

      // Assign / unassign / new+assign via the THREAD context menu (Sessions mode).
      await crudPage.evaluate(() => document.querySelector("#threads-view-sessions").click());
      menuItems = await openThreadMenu(crudPage, threadId);
      await clickThreadProjectButton(crudPage, { exact: "UiCrudProj" });
      assignConfirmed = await waitForMembership(relayPort, threadId, uiProjId);
      await waitForThreadMenuState(crudPage, threadId, (labels) => labels.some((t) => t.startsWith("✓ UiCrudProj")));
      currentMarked = true;

      await openThreadMenu(crudPage, threadId);
      await clickThreadProjectButton(crudPage, { includes: "Remove from project" });
      unassignConfirmed = await waitForMembership(relayPort, threadId, null);

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
        (name) => [...document.querySelectorAll("#threads-list .project-sidebar-name")].some((n) => n.textContent.trim() === name),
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
    await menuFailPage.waitForFunction(() => {
      const menu = document.querySelector("#thread-context-menu");
      const note = document.querySelector("#thread-project-actions .context-menu-note");
      return menu && !menu.hidden && !!note;
    }, null, { timeout: TIMEOUT_MS });
    const menuFailClosed = await menuFailPage.evaluate(() => ({
      buttonCount: document.querySelectorAll("#thread-project-actions button").length,
      note: document.querySelector("#thread-project-actions .context-menu-note")?.textContent?.trim() || null,
      sessionsActive: document.querySelector("#threads-view-sessions")?.classList.contains("is-active") || false,
    }));
    await menuFailPage.close();

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
    await staleMenuPage.waitForFunction(
      () => { const menu = document.querySelector("#thread-context-menu"); return menu && !menu.hidden && document.querySelectorAll("#thread-project-actions button").length > 0; },
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
      crud: { menuItems, assignConfirmed, currentMarked, unassignConfirmed, menuCreateAssign, renameConfirmed, deleteConfirmed, projectMenuClosedOnBump },
      menuFailClosed, staleMenu,
    }, null, 2));

    // --- Assertions ---
    assert.ok(projectsView.projectRows.includes("VerifyProj"), "VerifyProj row renders in Projects mode");
    assert.match(projectsView.countText, /1 project\b/, `count text = '1 project': ${projectsView.countText}`);
    assert.match(projectsView.verifyBadge, /[1-9]/, `the assigned session is reflected in the project row badge: ${projectsView.verifyBadge}`);
    assert.ok(projectsView.hasActionsButton, "each project row exposes a visible ⋯ actions button (touch/keyboard reachable)");
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
    assert.equal(unassignConfirmed, null, "removing via the thread menu cleared membership server-side");
    assert.ok(menuCreateAssign, "'New project…' both creates the project and assigns the session");
    assert.ok(renameConfirmed, "renaming via the project context menu updates the name server-side");
    assert.ok(deleteConfirmed, "deleting via the project context menu removes the project server-side");
    assert.ok(projectMenuClosedOnBump, "an open project menu closes fail-closed when the projects revision changes");

    assert.equal(menuFailClosed.sessionsActive, true, "thread-menu fail-closed probe stays in Sessions mode");
    assert.equal(menuFailClosed.buttonCount, 0, `no Project mutation buttons while the fetch is failing: ${menuFailClosed.buttonCount}`);
    assert.match(menuFailClosed.note || "", /Projects unavailable|Loading projects/, `a fail-closed note replaces the controls: ${menuFailClosed.note}`);

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
