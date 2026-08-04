// Diagnostic (not a test): seeds a resumed thread whose turn holds ONE per-edit
// fileChange entry shaped exactly as the Claude worker emits it (absolute `path`,
// repo-relative patch header) plus the turnDiff the relay synthesizes, then dumps what
// the transcript actually renders. Goal: why does one edited file draw TWO cards?
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const runCommand = async (cmd, args, opts) => promisify(execFile)(cmd, args, opts);

const TIMEOUT_MS = 45_000;
const TURN_ID = "turn-diag";
const THREAD_ID = "thread-diag";
const TEST_FILE = "package-lock.json";

async function main() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "diag-cards-state-"));
  const statePath = path.join(stateDir, "session.json");
  const seedPath = path.join(stateDir, "seed.json");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "diag-cards-ws-"))
  );
  const absPath = path.join(workspaceDir, TEST_FILE);

  await runCommand("git", ["init", "-q", "."], { cwd: workspaceDir });
  await fs.writeFile(absPath, '{\n  "lockfileVersion": 3,\n}\n', "utf8");
  await runCommand("git", ["add", "."], { cwd: workspaceDir });
  await runCommand("git", ["-c", "user.email=a@b.c", "-c", "user.name=d", "commit", "-qm", "seed"], {
    cwd: workspaceDir,
  });

  const diff = [
    `diff --git a/${TEST_FILE} b/${TEST_FILE}`,
    `--- a/${TEST_FILE}`,
    `+++ b/${TEST_FILE}`,
    "@@ -1,3 +1,3 @@",
    " {",
    '-  "lockfileVersion": 3,',
    '+  "lockfileVersion": 4,',
    " }",
    "",
  ].join("\n");

  await fs.writeFile(
    statePath,
    JSON.stringify({
      schema_version: 2,
      active_thread_id: THREAD_ID,
      active_controller_device_id: null,
      active_controller_last_seen_at: null,
      current_status: "idle",
      active_flags: [],
      current_cwd: workspaceDir,
      model: "gpt-5.4",
      approval_policy: "never",
      sandbox: "workspace-write",
      reasoning_effort: "medium",
      allowed_roots: [workspaceDir],
      device_records: {},
      paired_devices: {},
    }, null, 2),
    "utf8"
  );

  // Exactly what claude-worker's fileChangeTool emits: tool-level `path` and
  // file_changes[].path both ABSOLUTE, the patch header repo-RELATIVE.
  await fs.writeFile(
    seedPath,
    JSON.stringify([
      {
        item_id: `turn-diff:${TURN_ID}`,
        kind: "tool_call",
        text: `Changed files in turn ${TURN_ID}`,
        status: "completed",
        turn_id: TURN_ID,
        tool: {
          item_type: "turnDiff",
          name: "File summary",
          title: `Claude changed ${TEST_FILE} in this turn.`,
          detail: `Target files: ${TEST_FILE}`,
          query: null,
          path: absPath,
          url: null,
          command: null,
          input_preview: `Files:\n${TEST_FILE}`,
          result_preview: null,
          diff,
          file_changes: [
            { path: TEST_FILE, change_type: "modify", diff: "" },
            { path: absPath, change_type: "modify", diff },
          ],
        },
      },
    ], null, 2),
    "utf8"
  );

  const relayPort = await getFreePort();
  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    extraEnv: { AGENT_PROVIDERS: "fake", FAKE_PROVIDER_SEED_PATH: seedPath },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  try {
    const launched = await launchBrowser();
    browser = launched.browser;
    const page = await launched.context.newPage();
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      (id) => Boolean(document.querySelector(`[data-open-thread-id="${id}"]`)),
      THREAD_ID,
      { timeout: TIMEOUT_MS }
    );
    await page.evaluate((id) => {
      document.querySelector(`[data-open-thread-id="${id}"]`)?.click();
    }, THREAD_ID);
    await page.waitForFunction(
      () => document.querySelector(".app-shell")?.dataset.view === "conversation",
      null,
      { timeout: TIMEOUT_MS }
    );
    await page.waitForFunction(
      () => Boolean(document.querySelector(".diff-group-chip")),
      null,
      { timeout: TIMEOUT_MS }
    );
    await page.evaluate(() => {
      document.querySelector(".diff-group-chip:not(.diff-group-chip-open)")?.click();
    });
    await page.waitForTimeout(500);

    const out = await page.evaluate(() => {
      const transcript = document.querySelector("#transcript");
      const entries = [...transcript.querySelectorAll("[data-transcript-entry-id]")].map((el) => ({
        entryId: el.getAttribute("data-transcript-entry-id"),
        sections: [...el.querySelectorAll(".diff-file-section")].map((s) =>
          (s.querySelector("summary")?.textContent || "").replace(/\s+/g, " ").trim()
        ),
        chips: [...el.querySelectorAll(".file-change-chip")].map((c) =>
          (c.textContent || "").replace(/\s+/g, " ").trim()
        ),
      }));
      const chip = document.querySelector(".diff-group-chip");
      return { groupChip: (chip?.textContent || "").replace(/\s+/g, " ").trim(), entries };
    });

    const api = await page.evaluate(async () => {
      const r = await fetch("/api/session").then((x) => x.json());
      return (r.data.transcript || [])
        .filter((e) => e.tool?.item_type === "fileChange" || e.tool?.item_type === "turnDiff")
        .map((e) => ({
          item_id: e.item_id,
          item_type: e.tool.item_type,
          tool_path: e.tool.path,
          file_change_paths: (e.tool.file_changes || []).map((c) => c.path),
        }));
    });

    console.log("=== rendered ===");
    console.log(JSON.stringify(out, null, 2));
    console.log("=== snapshot ===");
    console.log(JSON.stringify(api, null, 2));
  } finally {
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
