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

    console.log(
      JSON.stringify(
        { relayPort, sessionsView, projectsView, backToSessions, afterUnassign, unassignPropagated, failClosed, gatePending, gateResolved },
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
