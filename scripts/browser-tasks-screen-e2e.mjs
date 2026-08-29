// The Tasks screen's Orchestrator chat, driven in a real browser.
//
// The bug this pins: the Orchestrator pane was handed the CONVERSATION's write
// gate (`canCurrentDeviceWrite`), which answers "is there an active thread, and
// do I hold its controller lease?". The Orchestrator is a background thread and
// never has a controller lease, so on a relay with no conversation open the
// pane refused every keystroke and announced "Another device has control" —
// with no other device anywhere. Tasks was simply dead until you happened to
// open a session first.
//
// Nothing caught it because every other Orchestrator test mounts
// `TaskTeamScreen` with props supplied by hand, and `canWrite` defaults to
// true in the component. The defect lives in what render-session.js COMPUTES
// for that prop, which only the assembled app evaluates.
//
// Needs the private build (`cargo build -p relay-server --features private`)
// and E2E_USE_BUILT_BINARIES=1: SEALWIRE_BETA only unlocks Tasks when the
// binary was built with the feature.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-tasks-orch-e2e-"));
  const workspace = path.join(stateDir, "workspace");
  await fs.mkdir(workspace, { recursive: true });

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: path.join(stateDir, "session.json"),
    extraEnv: { AGENT_PROVIDERS: "fake", SEALWIRE_BETA: "1" },
  });

  let browser = null;
  let page = null;
  try {
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
    const launched = await launchBrowser();
    browser = launched.browser;
    page = await launched.context.newPage();
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });

    const session = await page.evaluate(async () => {
      const response = await fetch("/api/session").then((r) => r.json());
      return response?.data || null;
    });
    assert.equal(
      session?.beta_features_enabled,
      true,
      "Tasks is beta-gated; this suite needs a --features private relay with SEALWIRE_BETA=1"
    );

    // The whole point: NO conversation has been started. `active_thread_id` is
    // null, which is precisely the state the conversation's write gate reports
    // as "you may not write".
    assert.equal(session.active_thread_id, null, "the relay must start with no active thread");

    await openTasks(page);
    await page.waitForSelector("#task-orch-input", { timeout: TIMEOUT_MS });
    await waitForOrchestratorThread(page);

    // The Orchestrator exists and belongs to this device. Being unable to type
    // into it is not a state the user can act on, and "another device has
    // control" is not true of a thread no device holds.
    await page.waitForFunction(
      () => document.querySelector("#task-orch-input")?.disabled === false,
      null,
      { timeout: TIMEOUT_MS }
    );

    const paneCopy = await page.evaluate(
      () => document.querySelector(".task-orch-transcript")?.textContent || ""
    );
    assert.ok(
      !paneCopy.includes("Another device has control"),
      `the Orchestrator pane must not claim another device holds a lease it cannot hold (got: ${paneCopy.trim().slice(0, 120)})`
    );

    // And the gate must be real, not merely open: a message typed with no
    // conversation ever started has to reach the thread and come back.
    await page.fill("#task-orch-input", "ping from the tasks screen");
    await page.click("#task-orch-send");
    await page.waitForFunction(
      () =>
        (document.querySelector(".task-orch-transcript")?.textContent || "").includes(
          "ping from the tasks screen"
        ),
      null,
      { timeout: TIMEOUT_MS }
    );

    // The pre-existing path stays working: with a conversation open, the pane
    // is still writable (this is the only case the old wiring got right, so it
    // is the one a fix is most likely to break).
    await page.locator('[data-destination="sessions"]:visible').first().click();
    await startLocalSession(page, {
      cwd: workspace,
      provider: "fake",
      approvalPolicy: "never",
      timeoutMs: TIMEOUT_MS,
    });
    await page.waitForFunction(
      () => (document.querySelector("#transcript")?.textContent || "").includes("Session ready"),
      null,
      { timeout: TIMEOUT_MS }
    );
    await openTasks(page);
    await page.waitForFunction(
      () => document.querySelector("#task-orch-input")?.disabled === false,
      null,
      { timeout: TIMEOUT_MS }
    );

    // ---- Selecting a task must not take the tab down with it. ----
    //
    // `taskDiffPanel()` runs `loadTaskDiff` as a side effect DURING render, and
    // both loaders re-render synchronously before their first await. That is
    // fine only while every guard is re-entrant. `loadTaskReviewData`'s was not:
    // it keyed on `taskComments || taskReviewTicks` — results — where
    // `loadTaskDiff` keys on `taskDiff || taskDiffLoading`. On the synchronous
    // re-entry no result can exist yet, so the guard never held and render
    // recursed into itself until the renderer process died. Selecting a task
    // killed the tab: no console, no way back, indistinguishable from a freeze.
    const repo = await seedRepo(path.join(stateDir, "repo"));
    const deviceId = await page.evaluate(() => localStorage.getItem("agent-relay.device-id"));
    assert.ok(deviceId, "the surface must have a device id by now");
    await post(page, "/api/workspace/trust", { cwd: repo, device_id: deviceId });
    const startedTask = await post(page, "/api/session/team", {
      title: "Parse the three encodings",
      context: "The loader needs one.",
      acceptance_criteria: "Parses all three encodings.",
      agreed_scope: "Parser only.",
      quality_rules: "No unwrap.",
      cwd: repo,
      tl_provider: "fake",
      dev_provider: "fake",
      reviewer_provider: "fake",
      device_id: deviceId,
    });
    assert.ok(
      startedTask?.data?.team_run_id,
      `starting a task failed: ${JSON.stringify(startedTask?.error)}`
    );

    await openTasks(page);
    await page.waitForSelector(".task-sidebar-row", { timeout: TIMEOUT_MS });
    await page.locator(".task-sidebar-row").first().click();

    // The tab is still alive and still answering — `page.evaluate` against a
    // crashed renderer throws "Target crashed", which is what this used to do.
    await page.waitForTimeout(2000);
    const stillAlive = await page.evaluate(
      () => document.querySelector(".chat-shell")?.dataset?.view || null
    );
    assert.equal(stillAlive, "tasks", "selecting a task must leave the Tasks screen standing");

    // And you can still leave, which is the part the user actually noticed.
    await page.locator('[data-destination="sessions"]:visible').first().click();
    await page.waitForFunction(
      () => document.querySelector(".chat-shell")?.dataset?.view !== "tasks",
      null,
      { timeout: TIMEOUT_MS }
    );

    console.log("browser-tasks-screen-e2e: PASS");
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "tasks-orchestrator",
      relay,
      relayPort,
      localPage: page,
    }).catch(() => {});
    dumpProcessLogs(relay);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    await stopManagedProcess(relay);
  }
}

/** The rail and the sidebar both carry the destination; click whichever shows. */
async function openTasks(page) {
  await page.locator('[data-destination="tasks"]:visible').first().click();
}

function post(page, url, body) {
  return page.evaluate(
    async ([target, payload]) => {
      const response = await fetch(target, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Agent-Relay-CSRF": "1" },
        body: JSON.stringify(payload),
      });
      return response.json();
    },
    [url, body]
  );
}

/** Task provisioning refuses anything less than a real repo with one commit. */
async function seedRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "README.md"), "seed\n");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "e2e@example.com"],
    ["config", "user.name", "E2E"],
    ["add", "-A"],
    ["commit", "-q", "-m", "seed"],
  ]) {
    await git(dir, args);
  }
  return dir;
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`))
    );
  });
}

async function waitForOrchestratorThread(page) {
  await page.waitForFunction(
    async () => {
      const response = await fetch("/api/session")
        .then((r) => r.json())
        .catch(() => null);
      return Boolean(response?.data?.orchestrator_thread_id);
    },
    null,
    { timeout: TIMEOUT_MS }
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
