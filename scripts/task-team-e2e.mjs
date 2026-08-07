// End-to-end test for the Task team runner, over the real relay HTTP API with the
// fake provider (no browser / Playwright).
//
// The Rust tests drive `AppState` in-process against a hand-built provider double.
// That leaves an entire layer unexercised, and it is the layer where this feature
// actually meets a user: the HTTP routes, the wire types, real provisioning into a
// real git repository, and the artifacts left on disk when it finishes. Wiring the
// first route already found a defect no in-process test could reach — the whole
// start path was not `Send`, because tests await it directly and never spawn it.
//
// Three legs:
//
//   1. Happy path — a task runs the full pipeline to `done`, and the git repository
//      afterwards is checked directly: the branch exists, it carries a commit the
//      developer's file actually landed in, the target branch is untouched, and the
//      team's own scaffolding is NOT in the branch a user would merge.
//   2. Lifecycle — pause lands at a boundary, resume finishes the run, and the
//      whole thing is driven through the HTTP verbs.
//   3. Isolation — while a task holds its worktree, a session cannot be started in
//      it and a review cannot be requested against it.
//
// Run: node scripts/task-team-e2e.mjs   (or `npm run test:task-team`)

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = process.cwd();
const TIMEOUT_MS = Number(process.env.TASK_TEAM_E2E_TIMEOUT_MS || 120000);
const DEVICE = "task-team-e2e";
const TERMINAL = new Set(["done", "escalated", "failed", "interrupted", "cancelled"]);
// The file the fake "developer" writes. Its presence in the branch's commit is the
// evidence that work flowed all the way through: dev wrote it, the reviewer was
// shown it, the merge gate diffed it, and the relay committed it.
const DEV_FILE = "parser.txt";
const DEV_CONTENTS = "parsed three encodings\n";
// The team's own scaffolding, written into the worktree exactly where the relay
// tells each agent to put it. Its absence from the branch is what the exclusion
// assertion is actually testing — without something writing these, that assertion
// would pass against a broken build.
const PLAN_FILE = ".sealwire/PLAN.md";
const REPORT_FILE = ".sealwire/REPORT.md";
const managedProcesses = [];

process.on("exit", () => {
  for (const child of managedProcesses) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
});

// Each prompt the relay composes carries generated content — a worktree path, a
// diff, a sub-task id — so these match on the distinctive line of each prompt
// rather than on the whole text. Order is most specific first.
function scenarioConfig() {
  return {
    matchers: [
      {
        // The team lead writes the plan file, as a real one does. That file is the
        // durable state the whole design rests on — and it is also what proves the
        // team's scaffolding is kept OUT of the branch a user is asked to merge.
        contains: ["You are the team lead", "COMPLEXITY:"],
        scenario: {
          reply: "Plan written to the plan file.\nCOMPLEXITY: simple",
          write_files: [
            { path: PLAN_FILE, contents: "# Plan\nBuild the parser, then wire it in.\n" },
          ],
        },
      },
      {
        // Keyed on the TASK TITLE, which reaches this prompt through the spec
        // block. That is what lets one scenario file drive legs that must end
        // differently — the sub-task name it produces then keys the review below.
        contains: ["Split this task into sub-tasks", "Escalate me"],
        scenario: {
          reply: [
            "One sub-task.",
            "SUBTASK: Rejected work",
            "This will not be approved.",
            "END SUBTASK",
          ].join("\n"),
        },
      },
      {
        contains: ["Review this sub-task's changes", "Rejected work"],
        scenario: { reply: "Not close.\nVERDICT: NEEDS_CHANGES\n- the parser is missing" },
      },
      {
        contains: ["Split this task into sub-tasks", "Ask me something"],
        scenario: {
          reply: ["One sub-task.", "SUBTASK: Needs a decision", "Ask first.", "END SUBTASK"].join(
            "\n"
          ),
        },
      },
      {
        // The developer stops and asks. The SAME turn continues once answered.
        contains: ["You are the developer on one sub-task", "Needs a decision"],
        scenario: {
          reply: "Went with the first option.",
          write_files: [{ path: DEV_FILE, contents: DEV_CONTENTS }],
          ask_user: {
            question: "Which encoding should the parser prefer?",
            header: "Encoding",
            options: ["UTF-8", "Latin-1"],
          },
        },
      },
      {
        contains: ["Split this task into sub-tasks"],
        scenario: {
          reply: [
            "Two sub-tasks.",
            "SUBTASK: Add the parser",
            "Handle all three encodings.",
            "END SUBTASK",
            "SUBTASK: Wire it into the loader",
            "Call the parser from the loader.",
            "END SUBTASK",
          ].join("\n"),
        },
      },
      {
        // The developer is the only seat that writes, so it is the only scenario
        // with `write_files`.
        contains: ["You are the developer on one sub-task"],
        scenario: {
          reply: "Implemented the sub-task.",
          write_files: [{ path: DEV_FILE, contents: DEV_CONTENTS }],
        },
      },
      {
        contains: ["Review this sub-task's changes"],
        scenario: { reply: "Scoped and readable.\nVERDICT: APPROVED" },
      },
      {
        contains: ["Review this task's complete diff"],
        scenario: { reply: "Matches the agreed scope.\nVERDICT: APPROVED" },
      },
      {
        contains: ["was approved by the reviewer"],
        scenario: { reply: "Noted; continuing." },
      },
      {
        contains: ["Write a short report"],
        scenario: {
          reply: "Report written.",
          write_files: [{ path: REPORT_FILE, contents: "# Report\nParser landed.\n" }],
        },
      },
    ],
  };
}

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-task-team-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const scenarioPath = path.join(stateDir, "scenario.json");
  await fs.writeFile(scenarioPath, JSON.stringify(scenarioConfig(), null, 2));

  await buildRelay();
  const relayBin = path.join(ROOT, "target", "debug", "relay-server");
  const relay = spawnManagedProcess("relay", relayBin, [], {
    AGENT_PROVIDERS: "fake",
    PORT: String(relayPort),
    RELAY_STATE_PATH: statePath,
    FAKE_PROVIDER_SCENARIO_PATH: scenarioPath,
    FAKE_PROVIDER_CONTROL_DIR: path.join(stateDir, "fake-control"),
  });

  try {
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

    const happy = await runHappyPath(relayPort, stateDir);
    const lifecycle = await runLifecycle(relayPort, stateDir);
    const escalation = await runEscalation(relayPort, stateDir);
    // Before the isolation leg: that one deliberately opens a session at the end,
    // and the question leg asserts there is NO foreground session anywhere — which
    // is the unattended state the team's answer exception exists for.
    const question = await runQuestion(relayPort, stateDir);
    const isolation = await runIsolation(relayPort, stateDir);

    console.log(
      JSON.stringify({ ok: true, happy, lifecycle, isolation, escalation, question }, null, 2)
    );
  } catch (error) {
    dumpProcessLogs(relay);
    throw error;
  } finally {
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- leg 1: a task runs end to end and leaves a real branch behind ------------

async function runHappyPath(relayPort, stateDir) {
  const repo = await makeRepo(stateDir, "happy");
  const started = await startTeam(relayPort, repo, "Add a parser");
  assert.equal(started.branch, "task/add-a-parser", "the branch is named from the task");
  assert.ok(
    started.cwd.includes(".sealwire/worktrees/"),
    `the task should get its own worktree, got ${started.cwd}`
  );

  const run = await waitForTerminalTeam(relayPort, started.team_run_id);
  assert.equal(
    run.status,
    "done",
    `the task should finish (status=${run.status}, error=${run.error})`
  );
  assert.equal(run.phase, "finished");
  assert.equal(run.sub_tasks.length, 2, "the team lead split the work in two");
  for (const task of run.sub_tasks) {
    assert.equal(task.status, "done", `sub-task ${task.title} should be done`);
    assert.equal(task.rounds_used, 1, "one review round is enough when approved");
    assert.ok(task.digested, "the team lead must be told how each sub-task went");
  }
  assert.ok(run.head_commit, "wrap-up must leave a commit");
  assert.equal(run.tl_generations, 1, "no re-seed was needed");

  // The worktree is real, and so is what the developer wrote.
  const devFile = path.join(started.cwd, DEV_FILE);
  assert.equal(
    await fs.readFile(devFile, "utf8"),
    DEV_CONTENTS,
    "the developer's file should exist in the task worktree"
  );

  // The scaffolding really was written — otherwise the exclusion assertion below
  // would be checking that git omitted a file nobody ever created.
  assert.ok(
    await exists(path.join(started.cwd, PLAN_FILE)),
    "the team lead should have written its plan file into the worktree"
  );
  assert.ok(
    await exists(path.join(started.cwd, REPORT_FILE)),
    "and wrap-up should have written the report"
  );

  // And the branch carries the work but not the scaffolding. This is the whole
  // point: the user is handed a BRANCH, so the branch is what gets checked.
  //
  // Its whole tree, not its tip commit: which checkpoint a file landed in is the
  // driver's business, and asserting on that would fail for reasons that have
  // nothing to do with the branch being right.
  const tracked = (await git(repo, ["ls-tree", "-r", "--name-only", started.branch])).split("\n");
  assert.ok(
    tracked.includes(DEV_FILE),
    `the branch should contain ${DEV_FILE}, got:\n${tracked.join("\n")}`
  );
  assert.ok(
    !tracked.some((entry) => entry.startsWith(".sealwire/")),
    `the team's own scaffolding must stay out of the branch, got:\n${tracked.join("\n")}`
  );

  // The branch the task forked from is untouched — nothing was pushed, merged, or
  // committed onto it.
  const mainFiles = await git(repo, ["ls-tree", "-r", "--name-only", "main"]);
  assert.ok(
    !mainFiles.split("\n").includes(DEV_FILE),
    "the target branch must not have been written to"
  );

  return { team_run_id: run.team_run_id, status: run.status, sub_tasks: run.sub_tasks.length };
}

// ---- leg 2: pause at a boundary, resume, finish ------------------------------

async function runLifecycle(relayPort, stateDir) {
  const repo = await makeRepo(stateDir, "lifecycle");
  const started = await startTeam(relayPort, repo, "Pause me");

  // Pause as soon as the run is really moving. It settles at the next STEP
  // boundary, never mid-turn.
  await waitForTeam(relayPort, started.team_run_id, (run) => run.phase !== "intake");
  const paused = await postEnvelope(relayPort, "/api/session/team/pause", {
    team_run_id: started.team_run_id,
    device_id: DEVICE,
  });
  assert.ok(paused.ok, `pause failed: ${JSON.stringify(paused.error)}`);
  assert.equal(paused.data.status, "pause_pending", "a pause is a request, not an instant stop");

  const settled = await waitForTeam(relayPort, started.team_run_id, (run) => run.status === "paused");
  assert.equal(settled.status, "paused");
  assert.ok(
    !TERMINAL.has(settled.status),
    "a paused task is resumable, not finished"
  );
  const subTasksAtPause = settled.sub_tasks.length;

  // A paused task still owns its slot: a second task must be refused.
  const second = await postEnvelope(relayPort, "/api/session/team", {
    title: "Another task",
    cwd: repo,
    device_id: DEVICE,
  });
  assert.equal(second.ok, false, "a paused task still holds the one-at-a-time slot");

  const resumed = await postEnvelope(relayPort, "/api/session/team/resume", {
    team_run_id: started.team_run_id,
    device_id: DEVICE,
  });
  assert.ok(resumed.ok, `resume failed: ${JSON.stringify(resumed.error)}`);

  const finished = await waitForTerminalTeam(relayPort, started.team_run_id);
  assert.equal(
    finished.status,
    "done",
    `a resumed task should finish (status=${finished.status}, error=${finished.error})`
  );
  assert.ok(
    finished.sub_tasks.length >= subTasksAtPause,
    "resuming must not lose the work already recorded"
  );

  return { team_run_id: finished.team_run_id, paused_at_phase: settled.phase, status: finished.status };
}

// ---- leg 3: nothing else may write into a live task's worktree ---------------

async function runIsolation(relayPort, stateDir) {
  const repo = await makeRepo(stateDir, "isolation");
  const started = await startTeam(relayPort, repo, "Hold the tree");
  await waitForTeam(relayPort, started.team_run_id, (run) => run.tl_thread_id !== "");

  const session = await postEnvelope(relayPort, "/api/session/start", {
    device_id: DEVICE,
    cwd: started.cwd,
    provider: "fake",
    initial_prompt: "go rewrite everything",
  });
  assert.equal(session.ok, false, "no session may be started inside a live task's worktree");
  assert.ok(
    String(session.error?.message || session.error).includes("running task"),
    `the refusal should name the task: ${JSON.stringify(session.error)}`
  );

  // A subdirectory of the worktree is the same git worktree.
  const subdir = path.join(started.cwd, "src");
  await fs.mkdir(subdir, { recursive: true });
  const nested = await postEnvelope(relayPort, "/api/session/start", {
    device_id: DEVICE,
    cwd: subdir,
    provider: "fake",
  });
  assert.equal(nested.ok, false, "nor in a subdirectory of it");

  const cancelled = await postEnvelope(relayPort, "/api/session/team/cancel", {
    team_run_id: started.team_run_id,
    device_id: DEVICE,
  });
  assert.ok(cancelled.ok, `cancel failed: ${JSON.stringify(cancelled.error)}`);
  assert.equal(cancelled.data.status, "cancelled");

  // Once it is over the workspace is ordinary again — and the branch survives.
  const reopened = await postEnvelope(relayPort, "/api/session/start", {
    device_id: DEVICE,
    cwd: started.cwd,
    provider: "fake",
  });
  assert.ok(reopened.ok, `the worktree should be usable once the task ends: ${JSON.stringify(reopened.error)}`);
  const branches = await git(repo, ["branch", "--list", started.branch]);
  assert.ok(branches.includes(started.branch), "cancelling never deletes the branch");

  return { team_run_id: started.team_run_id, status: cancelled.data.status };
}

// ---- leg 4: work that is never approved escalates rather than passing --------

async function runEscalation(relayPort, stateDir) {
  const repo = await makeRepo(stateDir, "escalation");
  const started = await startTeam(relayPort, repo, "Escalate me");
  const run = await waitForTerminalTeam(relayPort, started.team_run_id);

  assert.equal(
    run.status,
    "escalated",
    `unapproved work must not report done (status=${run.status}, error=${run.error})`
  );
  assert.equal(run.sub_tasks.length, 1);
  const task = run.sub_tasks[0];
  assert.equal(task.status, "escalated", "the sub-task ran out of review rounds");
  assert.equal(task.rounds_used, 2, "two rounds is the ceiling, not a suggestion");
  assert.ok(
    (task.result_summary || "").includes("parser is missing"),
    `the team lead must learn WHY it escalated: ${task.result_summary}`
  );
  assert.ok(
    run.unresolved.length > 0,
    "and the run must carry the leftovers into its report"
  );
  // The branch still exists: escalation hands work back, it does not throw it away.
  const branches = await git(repo, ["branch", "--list", started.branch]);
  assert.ok(branches.includes(started.branch));

  return { team_run_id: run.team_run_id, status: run.status, rounds: task.rounds_used };
}

// ---- leg 5: the team asks a person, and the same turn carries on -------------

async function runQuestion(relayPort, stateDir) {
  const repo = await makeRepo(stateDir, "question");
  const started = await startTeam(relayPort, repo, "Ask me something");

  // The run parks and says so on the record — including WHICH seat is waiting.
  const parked = await waitForTeam(
    relayPort,
    started.team_run_id,
    (run) => run.status === "awaiting_user" && run.awaiting
  );
  assert.equal(parked.awaiting.role, "dev", "the developer is the one asking");
  assert.ok(parked.awaiting.request_id, "and the card is addressable");

  // Answering goes through the ordinary ask-user route — no foreground session
  // exists anywhere, which is the normal state while a task runs unattended.
  const snapshot = await fetchEnvelope(relayPort, "/api/session");
  assert.equal(
    snapshot.data?.active_thread_id ?? null,
    null,
    "this is the unattended case the team exception exists for"
  );
  const answered = await postEnvelope(
    relayPort,
    `/api/ask-user-questions/${encodeURIComponent(parked.awaiting.request_id)}/answer`,
    {
      device_id: DEVICE,
      answers: { "Which encoding should the parser prefer?": "UTF-8" },
    }
  );
  assert.ok(answered.ok, `answering failed: ${JSON.stringify(answered.error)}`);

  const run = await waitForTerminalTeam(relayPort, started.team_run_id);
  assert.equal(
    run.status,
    "done",
    `the answered turn should carry the run to the end (error=${run.error})`
  );
  assert.equal(run.awaiting, null, "the parked question is cleared once answered");
  // The answered turn's WORK landed — proof the same turn continued rather than
  // being restarted or abandoned.
  const tracked = (await git(repo, ["ls-tree", "-r", "--name-only", started.branch])).split("\n");
  assert.ok(
    tracked.includes(DEV_FILE),
    `the answered turn's work must reach the branch, got:\n${tracked.join("\n")}`
  );

  return { team_run_id: run.team_run_id, status: run.status, asked_role: parked.awaiting.role };
}

// ---- helpers -----------------------------------------------------------------

async function startTeam(relayPort, cwd, title) {
  const receipt = await postEnvelope(relayPort, "/api/session/team", {
    title,
    context: "The loader needs one.",
    acceptance_criteria: "Parses all three encodings.",
    agreed_scope: "Parser only; no loader refactor.",
    quality_rules: "No unwrap in library code.",
    cwd,
    tl_provider: "fake",
    dev_provider: "fake",
    reviewer_provider: "fake",
    device_id: DEVICE,
  });
  assert.ok(receipt.ok, `start_team failed: ${JSON.stringify(receipt.error)}`);
  assert.ok(receipt.data?.team_run_id, "start_team should return a team_run_id");
  return receipt.data;
}

async function teamRun(relayPort, teamRunId) {
  const teams = await fetchEnvelope(relayPort, "/api/session/teams");
  assert.ok(teams.ok, `team list failed: ${JSON.stringify(teams.error)}`);
  return (teams.data?.teams || []).find((team) => team.team_run_id === teamRunId);
}

async function waitForTeam(relayPort, teamRunId, predicate, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const run = await teamRun(relayPort, teamRunId);
    if (run) {
      last = run;
      if (predicate(run)) {
        return run;
      }
    }
    await delay(150);
  }
  throw new Error(
    `timed out waiting on task ${teamRunId} (status=${last?.status}, phase=${last?.phase}, error=${last?.error})`
  );
}

function waitForTerminalTeam(relayPort, teamRunId, timeoutMs = TIMEOUT_MS) {
  return waitForTeam(relayPort, teamRunId, (run) => TERMINAL.has(run.status), timeoutMs);
}

// A real git repository with one commit — provisioning refuses anything less.
async function makeRepo(base, name) {
  const dir = path.join(base, `repo-${name}`);
  await fs.mkdir(dir, { recursive: true });
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "e2e@example.com"]);
  await git(dir, ["config", "user.name", "E2E"]);
  await fs.writeFile(path.join(dir, "seed.txt"), "line1\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "seed"]);
  return dir;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`))
    );
  });
}

async function fetchEnvelope(relayPort, pathName) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathName}`);
  return response.json();
}

async function postEnvelope(relayPort, pathName, body = undefined) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathName}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
}

function buildRelay() {
  return new Promise((resolve, reject) => {
    const build = spawn("cargo", ["build", "-p", "relay-server"], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    build.on("error", reject);
    build.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`cargo build -p relay-server failed (exit ${code})`))
    );
  });
}

function spawnManagedProcess(name, command, args, extraEnv) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child._logName = name;
  child._logBuffer = [];
  child.stdout.on("data", (chunk) => appendLog(child, chunk));
  child.stderr.on("data", (chunk) => appendLog(child, chunk));
  managedProcesses.push(child);
  return child;
}

function appendLog(child, chunk) {
  const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
  child._logBuffer.push(...lines);
  if (child._logBuffer.length > 400) {
    child._logBuffer.splice(0, child._logBuffer.length - 400);
  }
}

async function stopManagedProcess(child) {
  if (!child || child.killed || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3000).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

function dumpProcessLogs(child) {
  const lines = child?._logBuffer || [];
  if (!lines.length) {
    return;
  }
  console.error(`\n[${child._logName} logs]`);
  console.error(lines.join("\n"));
}

async function waitForHealth(url, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(300);
  }
  throw new Error(`timed out waiting for health endpoint: ${url}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
