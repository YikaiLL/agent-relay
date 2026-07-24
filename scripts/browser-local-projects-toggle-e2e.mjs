// Drives the local web UI to verify the Sessions/Projects sidebar toggle: create a
// Project + assign a session via the API, click the Projects toggle, and confirm the
// sidebar regroups by Project (and back). Run: AGENT_PROVIDERS=fake node scripts/browser-local-projects-toggle-e2e.mjs
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
// truth). `expectedProjectId = null` means "unassigned". Used to confirm a UI action
// actually mutated state, without depending on the virtualized list's DOM shape.
async function waitForMembership(relayPort, threadId, expectedProjectId) {
  for (let i = 0; i < 100; i += 1) {
    const data = await api(relayPort, "GET", "/api/projects");
    const current = data.thread_project_id[threadId] ?? null;
    if (current === (expectedProjectId ?? null)) return current;
    await delay(150);
  }
  throw new Error(`membership for ${threadId} never became ${expectedProjectId ?? "unassigned"}`);
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
    // 1. Start a fake session so a thread exists in the sidebar.
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

    // 2. Create a Project, 3. assign the session — both via POST /api/projects.
    const created = await api(relayPort, "POST", "/api/projects", { action: "create", name: "VerifyProj" });
    const projectId = created.projects.find((p) => p.name === "VerifyProj")?.id;
    assert.ok(projectId, `created project id: ${JSON.stringify(created)}`);

    const assigned = await api(relayPort, "POST", "/api/projects", {
      action: "assign",
      thread_id: threadId,
      project_id: projectId,
    });
    assert.equal(assigned.thread_project_id[threadId], projectId, "membership recorded server-side");

    // 4. The dedicated GET channel reflects it with a nonzero revision.
    const fetched = await api(relayPort, "GET", "/api/projects");
    assert.ok(fetched.projects_revision > 0, `projects_revision > 0: ${fetched.projects_revision}`);
    assert.equal(fetched.thread_project_id[threadId], projectId, "GET /api/projects membership");

    // 5. Load the UI.
    ({ browser, context } = await launchBrowser({ contextOptions: { viewport: { width: 1400, height: 1000 } } }));
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      const drawer = document.querySelector(".sidebar-drawer");
      if (drawer && !drawer.open) drawer.open = true;
    });
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

    // 6. Switch to Projects (evaluate-click bypasses visibility quirks in the <details>).
    await page.evaluate(() => document.querySelector("#threads-view-projects").click());
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll("#threads-list .thread-group-name")]
          .map((n) => n.textContent.trim())
          .includes(name),
      "VerifyProj",
      { timeout: TIMEOUT_MS }
    );

    const projectsView = await page.evaluate((tid) => {
      const groups = [...document.querySelectorAll("#threads-list .thread-group")];
      const threadRow = document.querySelector(`#threads-list [data-thread-id="${tid}"]`);
      return {
        countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
        groupLabels: groups.map((g) => g.querySelector(".thread-group-name")?.textContent?.trim() || ""),
        threadVisible: !!threadRow,
        assignedThreadGroup: threadRow?.closest(".thread-group")?.querySelector(".thread-group-name")?.textContent?.trim() || null,
        projectsButtonActive: document.querySelector("#threads-view-projects")?.classList.contains("is-active") || false,
      };
    }, threadId);

    // 7. Switch back to Sessions.
    await page.evaluate(() => document.querySelector("#threads-view-sessions").click());
    await delay(300);
    const backToSessions = await page.evaluate(() => ({
      sessionsButtonActive: document.querySelector("#threads-view-sessions")?.classList.contains("is-active") || false,
      countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
    }));

    // Probe: passive-client propagation. Switch back to Projects, then unassign via
    // the API with NO browser action, and confirm it flows through the snapshot's
    // projects_revision -> store refetch -> regroup, moving the session to Unassigned.
    await page.evaluate(() => document.querySelector("#threads-view-projects").click());
    await page.waitForFunction(
      (name) => [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()).includes(name),
      "VerifyProj",
      { timeout: TIMEOUT_MS }
    );
    await api(relayPort, "POST", "/api/projects", { action: "unassign", thread_id: threadId });
    let unassignPropagated = false;
    try {
      await page.waitForFunction(
        () => [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()).includes("Unassigned"),
        null,
        { timeout: TIMEOUT_MS }
      );
      unassignPropagated = true;
    } catch {}
    const afterUnassign = await page.evaluate(() => ({
      groupLabels: [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()),
      countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
    }));

    // Probe (fail closed): a FRESH page where GET /api/projects fails must NOT render
    // sessions under a false "Unassigned" — it shows an explicit error placeholder.
    const failPage = await context.newPage();
    await failPage.route("**/api/projects*", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: { message: "boom" } }),
        });
      }
      return route.continue();
    });
    await failPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await failPage.evaluate(() => {
      const drawer = document.querySelector(".sidebar-drawer");
      if (drawer && !drawer.open) drawer.open = true;
    });
    await failPage.waitForFunction(
      () => document.querySelectorAll("#threads-list .thread-group").length >= 1,
      null,
      { timeout: TIMEOUT_MS }
    );
    await failPage.evaluate(() => document.querySelector("#threads-view-projects").click());
    await failPage.waitForFunction(
      () => (document.querySelector("#threads-count")?.textContent || "").includes("Projects unavailable"),
      null,
      { timeout: TIMEOUT_MS }
    );
    const failClosed = await failPage.evaluate(() => ({
      countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
      bodyText: document.querySelector("#threads-list")?.textContent?.trim() || "",
      groupLabels: [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()),
    }));
    await failPage.close();

    // Probe (fail closed on refresh): after a first successful load, a NEWER revision
    // whose fetch is still in flight must blank to a loading placeholder — the prior
    // grouping must NOT be presented as if it were current. Re-assign first so this
    // page's initial load has a real project grouping to (not) go stale.
    await api(relayPort, "POST", "/api/projects", { action: "assign", thread_id: threadId, project_id: projectId });
    const gatePage = await context.newPage();
    let holdRefresh = false;
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    await gatePage.route("**/api/projects*", async (route) => {
      if (route.request().method() === "GET" && holdRefresh) {
        await refreshGate; // hold the newer-revision fetch open so the UI stays pending
      }
      return route.continue();
    });
    await gatePage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await gatePage.evaluate(() => {
      const drawer = document.querySelector(".sidebar-drawer");
      if (drawer && !drawer.open) drawer.open = true;
    });
    await gatePage.waitForFunction(
      () => document.querySelectorAll("#threads-list .thread-group").length >= 1,
      null,
      { timeout: TIMEOUT_MS }
    );
    await gatePage.evaluate(() => document.querySelector("#threads-view-projects").click());
    await gatePage.waitForFunction(
      (name) => [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()).includes(name),
      "VerifyProj",
      { timeout: TIMEOUT_MS }
    );
    // Arm the gate, then bump the revision so the client refetches (and is held pending).
    holdRefresh = true;
    await api(relayPort, "POST", "/api/projects", { action: "create", name: "GateProj2" });
    await gatePage.waitForFunction(
      () => (document.querySelector("#threads-count")?.textContent || "").includes("Loading projects"),
      null,
      { timeout: TIMEOUT_MS }
    );
    const gatePending = await gatePage.evaluate(() => ({
      countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
      groupLabels: [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()),
    }));
    // Release the held fetch; the fresh grouping returns.
    releaseRefresh();
    holdRefresh = false;
    await gatePage.waitForFunction(
      (name) => [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()).includes(name),
      "VerifyProj",
      { timeout: TIMEOUT_MS }
    );
    const gateResolved = await gatePage.evaluate(() => ({
      groupLabels: [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()),
    }));
    await gatePage.close();

    // Probe (CRUD UI): create a Project from the toolbar and assign/unassign a session
    // through its context menu — the user-facing flow, not just the API.
    const crudPage = await context.newPage();
    let nextPrompt = "";
    crudPage.on("dialog", (dialog) => {
      void dialog.accept(dialog.type() === "prompt" ? nextPrompt : undefined);
    });
    await crudPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await crudPage.evaluate(() => {
      const drawer = document.querySelector(".sidebar-drawer");
      if (drawer && !drawer.open) drawer.open = true;
    });
    await crudPage.waitForFunction(() => document.querySelectorAll("#threads-list .thread-group").length >= 1, null, { timeout: TIMEOUT_MS });
    await crudPage.evaluate(() => document.querySelector("#threads-view-projects").click());
    // The create toolbar is shown only in the Projects view.
    await crudPage.waitForFunction(() => {
      const bar = document.querySelector("#projects-toolbar");
      return bar && !bar.hidden;
    }, null, { timeout: TIMEOUT_MS });

    let menuItems = [];
    let assignConfirmed = null;
    let currentMarked = false;
    let unassignConfirmed = "unset";
    let menuCreateAssign = null;
    let renameConfirmed = false;
    let deleteConfirmed = false;
    // Click a rename/delete action on a Project group header (Projects view). Returns
    // whether the button was found. The action's prompt/confirm is answered by the
    // page's dialog handler.
    const clickHeaderAction = (name, title) =>
      crudPage.evaluate(
        (arg) => {
          const header = [...document.querySelectorAll(".thread-group-header-project")].find(
            (hd) => hd.querySelector(".thread-group-name")?.textContent?.trim() === arg.name
          );
          const btn = header?.querySelector(`.thread-group-action[title="${arg.title}"]`);
          btn?.click();
          return !!btn;
        },
        { name, title }
      );
    // Right-click a session row to open its context menu, then read the Project buttons.
    const openThreadMenu = async (tid) => {
      // Wait for the list to SETTLE first (not mid-refetch "Loading projects…" blank),
      // else the row detaches under the click when the fail-closed placeholder swaps in.
      // Then let locator.click() auto-scroll/auto-retry (a manual scrollIntoViewIfNeeded
      // on a pre-resolved handle throws "element is not attached" across a re-render).
      await crudPage.waitForFunction(
        (t) => {
          const count = document.querySelector("#threads-count")?.textContent || "";
          if (count.includes("Loading projects")) return false;
          return !!document.querySelector(`#threads-list [data-thread-id="${t}"]`);
        },
        tid,
        { timeout: TIMEOUT_MS }
      );
      const target = crudPage.locator(`#threads-list [data-thread-id="${tid}"]`);
      await target.click({ button: "right", position: { x: 24, y: 16 }, timeout: TIMEOUT_MS });
      await crudPage.waitForFunction(() => {
        const menu = document.querySelector("#thread-context-menu");
        return menu && !menu.hidden && document.querySelectorAll("#thread-project-actions button").length > 0;
      }, null, { timeout: TIMEOUT_MS });
      return crudPage.evaluate(() => [...document.querySelectorAll("#thread-project-actions button")].map((b) => b.textContent.trim()));
    };
    const clickProjectButton = (predicateArg) =>
      crudPage.evaluate((arg) => {
        const btn = [...document.querySelectorAll("#thread-project-actions button")].find((b) => {
          const text = b.textContent.trim();
          return arg.exact ? text.replace(/^✓\s*/, "") === arg.exact : text.includes(arg.includes);
        });
        btn?.click();
      }, predicateArg);
    // Reopen the menu until its Project buttons satisfy `match(labels)` (client caught
    // up to the mutation), closing between tries. Returns the matching labels.
    const waitForMenuState = async (tid, match) => {
      for (let i = 0; i < 40; i += 1) {
        const labels = await openThreadMenu(tid);
        if (match(labels)) return labels;
        await crudPage.keyboard.press("Escape");
        await delay(200);
      }
      throw new Error("context menu never reached the expected Project state");
    };
    try {
      // Create "UiCrudProj" via the toolbar (the prompt is answered by the dialog handler).
      nextPrompt = "UiCrudProj";
      await crudPage.evaluate(() => document.querySelector("#projects-create-button").click());
      await crudPage.waitForFunction(
        (name) => [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()).includes(name),
        "UiCrudProj",
        { timeout: TIMEOUT_MS }
      );
      // Resolve the new project's id for server-truth membership assertions.
      const afterCreate = await api(relayPort, "GET", "/api/projects");
      const uiProjId = afterCreate.projects.find((p) => p.name === "UiCrudProj")?.id;
      assert.ok(uiProjId, `toolbar-created project id: ${JSON.stringify(afterCreate.projects.map((p) => p.name))}`);

      // Assign the session to it via the context menu, then confirm server-side.
      menuItems = await openThreadMenu(threadId);
      await clickProjectButton({ exact: "UiCrudProj" });
      assignConfirmed = await waitForMembership(relayPort, threadId, uiProjId);
      // And confirm the UI reflects membership: reopen shows "✓ UiCrudProj" as current.
      await waitForMenuState(threadId, (labels) => labels.some((t) => t.startsWith("✓ UiCrudProj")));
      currentMarked = true;

      // Unassign via the context menu ("Remove from project"), then confirm server-side.
      await openThreadMenu(threadId);
      await clickProjectButton({ includes: "Remove from project" });
      unassignConfirmed = await waitForMembership(relayPort, threadId, null);

      // Combined "New project…" (create + assign in one click) from the context menu.
      await openThreadMenu(threadId);
      nextPrompt = "UiMenuProj";
      await clickProjectButton({ includes: "New project" });
      for (let i = 0; i < 100; i += 1) {
        const data = await api(relayPort, "GET", "/api/projects");
        const proj = data.projects.find((p) => p.name === "UiMenuProj");
        if (proj && data.thread_project_id[threadId] === proj.id) {
          menuCreateAssign = proj.id;
          break;
        }
        await delay(150);
      }

      // Rename a Project via its group-header action, then delete it (Projects view).
      const beforeRename = await api(relayPort, "GET", "/api/projects");
      const renameTargetId = beforeRename.projects.find((p) => p.name === "UiCrudProj")?.id;
      assert.ok(renameTargetId, "a UiCrudProj to rename exists");
      nextPrompt = "UiRenamedProj";
      assert.ok(await clickHeaderAction("UiCrudProj", "Rename project"), "rename action found on the project header");
      for (let i = 0; i < 100; i += 1) {
        const data = await api(relayPort, "GET", "/api/projects");
        const renamed = data.projects.find((p) => p.id === renameTargetId);
        if (renamed && renamed.name === "UiRenamedProj") {
          renameConfirmed = true;
          break;
        }
        await delay(150);
      }
      // Wait for the renamed header to repaint, then delete it.
      await crudPage.waitForFunction(
        (name) => [...document.querySelectorAll(".thread-group-name")].some((n) => n.textContent.trim() === name),
        "UiRenamedProj",
        { timeout: TIMEOUT_MS }
      );
      assert.ok(await clickHeaderAction("UiRenamedProj", "Delete project"), "delete action found on the project header");
      for (let i = 0; i < 100; i += 1) {
        const data = await api(relayPort, "GET", "/api/projects");
        if (!data.projects.some((p) => p.id === renameTargetId)) {
          deleteConfirmed = true;
          break;
        }
        await delay(150);
      }
    } catch (crudError) {
      const dbg = await crudPage
        .evaluate((tid) => ({
          count: document.querySelector("#threads-count")?.textContent || null,
          toolbarHidden: document.querySelector("#projects-toolbar")?.hidden ?? null,
          groups: [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()),
          menuHidden: document.querySelector("#thread-context-menu")?.hidden ?? null,
          projectButtons: [...document.querySelectorAll("#thread-project-actions button")].map((b) => b.textContent.trim()),
          rowExists: !!document.querySelector(`#threads-list [data-thread-id="${tid}"]`),
          rowGroup: document.querySelector(`#threads-list [data-thread-id="${tid}"]`)?.closest(".thread-group")?.querySelector(".thread-group-name")?.textContent?.trim() || null,
        }), threadId)
        .catch(() => null);
      console.error("[crudPage state] " + JSON.stringify(dbg));
      throw crudError;
    } finally {
      await crudPage.close();
    }

    // Probe (menu fail-closed): with GET /api/projects forced to fail, the context
    // menu — even in Sessions mode — must expose NO actionable Project buttons, only a
    // non-interactive "Projects unavailable" note. Otherwise it would falsely imply the
    // session belongs to no project / that no projects exist.
    const menuFailPage = await context.newPage();
    await menuFailPage.route("**/api/projects*", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "boom" } }) });
      }
      return route.continue();
    });
    await menuFailPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await menuFailPage.evaluate(() => {
      const drawer = document.querySelector(".sidebar-drawer");
      if (drawer && !drawer.open) drawer.open = true;
    });
    // Stay in Sessions mode (default); the session row is grouped by folder.
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

    // Probe (open menu goes stale): with the menu OPEN over valid data, a newer
    // revision whose fetch is still in flight must withdraw the actionable buttons
    // (repopulate to a fail-closed note) rather than leave stale assign/unassign
    // controls exposed.
    const staleMenuPage = await context.newPage();
    let holdMenuRefresh = false;
    let releaseMenuRefresh;
    const menuRefreshGate = new Promise((resolve) => {
      releaseMenuRefresh = resolve;
    });
    await staleMenuPage.route("**/api/projects*", async (route) => {
      if (route.request().method() === "GET" && holdMenuRefresh) {
        await menuRefreshGate;
      }
      return route.continue();
    });
    await staleMenuPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await staleMenuPage.evaluate(() => {
      const drawer = document.querySelector(".sidebar-drawer");
      if (drawer && !drawer.open) drawer.open = true;
    });
    const staleTarget = staleMenuPage.locator(`#threads-list [data-thread-id="${threadId}"]`);
    await staleTarget.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    await staleTarget.click({ button: "right", position: { x: 24, y: 16 }, timeout: TIMEOUT_MS });
    // Menu open with actionable buttons (valid data).
    await staleMenuPage.waitForFunction(
      () => {
        const menu = document.querySelector("#thread-context-menu");
        return menu && !menu.hidden && document.querySelectorAll("#thread-project-actions button").length > 0;
      },
      null,
      { timeout: TIMEOUT_MS }
    );
    // Arm the gate, bump the revision → the in-flight refresh is held pending.
    holdMenuRefresh = true;
    await api(relayPort, "POST", "/api/projects", { action: "create", name: "StaleBump" });
    await staleMenuPage.waitForFunction(
      () =>
        document.querySelectorAll("#thread-project-actions button").length === 0 &&
        !!document.querySelector("#thread-project-actions .context-menu-note"),
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

    console.log(
      JSON.stringify(
        {
          relayPort,
          sessionsView,
          projectsView,
          backToSessions,
          afterUnassign,
          unassignPropagated,
          failClosed,
          gatePending,
          gateResolved,
          crud: { menuItems, assignConfirmed, currentMarked, unassignConfirmed, menuCreateAssign, renameConfirmed, deleteConfirmed },
          menuFailClosed,
          staleMenu,
        },
        null,
        2
      )
    );

    assert.ok(projectsView.groupLabels.includes("VerifyProj"), "the VerifyProj group header renders in Projects mode");
    assert.ok(projectsView.threadVisible, "the assigned session is visible in Projects mode");
    assert.match(projectsView.countText, /1 project · \d+ session/, `count text = '1 project · N sessions': ${projectsView.countText}`);
    assert.ok(projectsView.projectsButtonActive, "Projects toggle button is active");
    assert.ok(backToSessions.sessionsButtonActive, "Sessions toggle re-activates");
    assert.match(backToSessions.countText, /folder/, `back to Sessions shows folder grouping: ${backToSessions.countText}`);
    assert.ok(
      unassignPropagated && afterUnassign.groupLabels.includes("Unassigned"),
      `an API unassign must propagate to the live UI (snapshot revision -> refetch): ${JSON.stringify(afterUnassign)}`
    );

    // Fail closed: a failed Projects fetch shows an explicit error placeholder and NO
    // grouping — never sessions falsely bucketed under "Unassigned".
    assert.equal(failClosed.countText, "Projects unavailable", `fail-closed count: ${failClosed.countText}`);
    assert.deepEqual(failClosed.groupLabels, [], `no grouping is rendered on fetch failure: ${JSON.stringify(failClosed.groupLabels)}`);
    assert.ok(!failClosed.groupLabels.includes("Unassigned"), "must not present a false Unassigned grouping when the fetch failed");
    assert.match(failClosed.bodyText, /Failed to load projects/, `error message shown: ${failClosed.bodyText}`);

    // Fail closed on refresh: a pending newer-revision fetch shows the loading
    // placeholder with NO grouping (prior membership is not presented as current),
    // then the grouping returns once the fetch resolves.
    assert.match(gatePending.countText, /Loading projects/, `pending refresh shows a loading placeholder: ${gatePending.countText}`);
    assert.deepEqual(gatePending.groupLabels, [], `no stale grouping while a newer revision is pending: ${JSON.stringify(gatePending.groupLabels)}`);
    assert.ok(gateResolved.groupLabels.includes("VerifyProj"), `grouping returns after the refresh resolves: ${JSON.stringify(gateResolved.groupLabels)}`);

    // CRUD UI: toolbar create + context-menu assign/unassign drive the real flow.
    assert.ok(
      menuItems.some((t) => t.replace(/^✓\s*/, "") === "UiCrudProj"),
      `the context menu lists the toolbar-created project: ${JSON.stringify(menuItems)}`
    );
    assert.ok(assignConfirmed, "assigning via the context menu recorded membership server-side");
    assert.ok(currentMarked, "the assigned project is marked current (✓) in the UI on reopen");
    assert.equal(unassignConfirmed, null, "removing via the context menu cleared membership server-side");
    assert.ok(menuCreateAssign, "the context menu 'New project…' both creates the project and assigns the session");
    assert.ok(renameConfirmed, "renaming via the project header action updates the project name server-side");
    assert.ok(deleteConfirmed, "deleting via the project header action removes the project server-side");

    // Menu fail-closed: no actionable Project controls while the payload is unavailable.
    assert.equal(menuFailClosed.sessionsActive, true, "menu fail-closed probe stays in Sessions mode");
    assert.equal(menuFailClosed.buttonCount, 0, `no Project mutation buttons while the fetch is failing: ${menuFailClosed.buttonCount}`);
    assert.match(menuFailClosed.note || "", /Projects unavailable|Loading projects/, `a fail-closed note replaces the controls: ${menuFailClosed.note}`);

    // Open menu goes stale: a held newer-revision refresh withdraws the buttons.
    assert.equal(staleMenu.buttonCount, 0, `an open menu withdraws its buttons on a pending newer-revision refresh: ${staleMenu.buttonCount}`);
    assert.match(staleMenu.note || "", /Loading projects/, `the open menu falls closed to a loading note: ${staleMenu.note}`);
    assert.ok(staleMenu.menuOpen, "the menu stays open while its controls are withdrawn (not silently closed)");

    console.log("PROJECTS_TOGGLE_E2E: PASS");
  } catch (error) {
    console.error("PROJECTS_TOGGLE_E2E: FAIL");
    console.error(error);
    if (page) {
      try {
        console.error(
          "[page state] " +
            JSON.stringify(
              await page.evaluate(() => ({
                countText: document.querySelector("#threads-count")?.textContent || null,
                groups: [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()),
                hasProjectsBtn: !!document.querySelector("#threads-view-projects"),
              }))
            )
        );
      } catch {}
    }
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
