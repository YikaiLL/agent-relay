#!/usr/bin/env node
// Does `release_session` actually make the native `claude` child exit? Unit
// tests only prove the map entry is dropped, not that the process goes away.
//
//   node scripts/probe-release-frees-process.mjs

import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(here, "..", "claude-worker", "worker.mjs");
const MODEL = process.env.PROBE_MODEL || "claude-haiku-4-5";

const claudeChildren = () => {
  try {
    return execSync("pgrep -f 'claude-agent-sdk-darwin' || true", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const rssMb = (pid) => {
  try {
    return Number(execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8" }).trim()) / 1024;
  } catch {
    return null;
  }
};

const before = new Set(claudeChildren());
const worker = spawn(process.execPath, [workerPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env },
});

const events = [];
const waiters = [];
createInterface({ input: worker.stdout }).on("line", (line) => {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  events.push(event);
  for (let i = waiters.length - 1; i >= 0; i -= 1) {
    if (waiters[i].match(event)) waiters.splice(i, 1)[0].resolve(event);
  }
});

const send = (cmd) => worker.stdin.write(JSON.stringify(cmd) + "\n");
const waitFor = (match, label, ms = 180_000, from = 0) =>
  new Promise((resolve, reject) => {
    const hit = events.slice(from).find(match);
    if (hit) return resolve(hit);
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
    waiters.push({ match, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

try {
  console.log(`model=${MODEL}\n`);

  send({
    type: "start",
    id: "req-1",
    cwd: process.cwd(),
    model: MODEL,
    prompt: "Remember this codeword: PLUMBAGO-7. Reply with exactly: ok",
    approval_policy: "bypass",
  });

  const started = await waitFor(
    (e) => e.type === "session_started" || (e.id === "req-1" && e.provider_session_id),
    "session_started",
  );
  const sessionId = started.provider_session_id;
  console.log(`session=${sessionId}`);

  await waitFor((e) => e.type === "done", "first turn done");

  // Let the child settle so we measure it, not its startup.
  await sleep(1500);
  const spawned = claudeChildren().filter((pid) => !before.has(pid));
  check(spawned.length > 0, "a native claude child was spawned", `pids=${spawned}`);
  const rssBefore = spawned.map(rssMb).filter((v) => v != null);
  console.log(`      child RSS: ${rssBefore.map((v) => v.toFixed(0) + "MB").join(", ")}`);

  send({ type: "release_session", id: "req-2", provider_session_id: sessionId });
  const released = await waitFor((e) => e.id === "req-2", "release response", 30_000);
  check(released.result?.released === true, "worker reported released", JSON.stringify(released));

  // Process exit is not instant; poll rather than assume.
  let stillAlive = spawned;
  for (let i = 0; i < 100; i += 1) {
    stillAlive = spawned.filter(alive);
    if (stillAlive.length === 0) break;
    await sleep(100);
  }
  check(
    stillAlive.length === 0,
    "every claude child actually exited",
    stillAlive.length ? `still alive: ${stillAlive}` : `freed ~${rssBefore.reduce((a, b) => a + b, 0).toFixed(0)}MB`,
  );

  // Count only from here, or the cached first `done` matches instantly.
  const mark = events.length;
  send({
    type: "send",
    id: "req-3",
    provider_session_id: sessionId,
    prompt: "What codeword did I give you? Reply with just the codeword.",
  });
  await waitFor(
    (e) => e.type === "done" && e.provider_session_id === sessionId,
    "resumed turn",
    180_000,
    mark,
  );
  // Only answerable from pre-release history, so this is the one assertion that
  // proves the conversation survived rather than a fresh session being started.
  const recalled = events
    .slice(mark)
    .some((e) => JSON.stringify(e).includes("PLUMBAGO-7"));
  check(recalled, "the resumed session still remembers the pre-release turn");
  const respawned = claudeChildren().filter((pid) => !before.has(pid));
  check(respawned.length > 0, "resuming spawned a fresh child", `pids=${respawned}`);
} catch (error) {
  check(false, "probe completed", String(error));
} finally {
  send({ type: "shutdown", id: "req-x" });
  await sleep(800);
  worker.kill("SIGKILL");
  console.log(`\n${failed ? "PROBE FAILED" : "PROBE PASSED"}`);
  process.exit(failed ? 1 : 0);
}
