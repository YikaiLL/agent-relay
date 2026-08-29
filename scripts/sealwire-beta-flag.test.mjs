// `sealwire --beta`: the opt-in that unlocks in-development features.
//
// The relay binary takes no argv, so the contract is which value lands in the
// child's environment. Default must be *absent*, not "SEALWIRE_BETA=0".

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, "sealwire.mjs");

// Black-box drive the launcher with a stub standing in for the compiled
// relay-server binary; the stub records the beta env it was handed and exits 0.
// PATH is intentionally bare, so the stub uses only shell builtins.
function runLauncher({ args = [], extraEnv = {} } = {}) {
  const workdir = mkdtempSync(path.join(os.tmpdir(), "sealwire-beta-"));
  const capturePath = path.join(workdir, "captured-env.txt");
  const stubPath = path.join(workdir, "stub-relay-server");
  writeFileSync(
    stubPath,
    [
      "#!/bin/sh",
      "{",
      '  printf "SEALWIRE_BETA=%s\\n" "${SEALWIRE_BETA:-<unset>}"',
      '} > "$SEALWIRE_CAPTURE_FILE"',
      "exit 0",
      "",
    ].join("\n")
  );
  chmodSync(stubPath, 0o755);

  const env = {
    HOME: process.env.HOME,
    PATH: workdir, // no codex, no cargo — the stub needs no external commands
    AGENT_RELAY_SERVER_BIN: stubPath,
    SEALWIRE_CAPTURE_FILE: capturePath,
    ...extraEnv,
  };

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [launcher, ...args, "--no-open", "--no-broker"],
      { env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => {
      const raw = existsSync(capturePath)
        ? readFileSync(capturePath, "utf8")
        : null;
      rmSync(workdir, { recursive: true, force: true });
      resolve({ code, stdout, stderr, captured: parseCaptured(raw) });
    });
  });
}

function parseCaptured(raw) {
  const map = {};
  if (!raw) return map;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const eq = line.indexOf("=");
    map[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return map;
}

test("a plain `sealwire` leaves beta features off", async () => {
  const { code, captured, stderr } = await runLauncher();
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    captured.SEALWIRE_BETA,
    "<unset>",
    "the default launch must not set SEALWIRE_BETA at all"
  );
});

test("`sealwire --beta` is a recognized flag, not an unknown argument", async () => {
  const { code, stderr } = await runLauncher({ args: ["--beta"] });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.doesNotMatch(stderr, /unknown argument/);
});

test("`sealwire --beta` turns beta features on for the relay", async () => {
  const { code, captured, stderr } = await runLauncher({ args: ["--beta"] });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(captured.SEALWIRE_BETA, "1");
});

test("`--beta` composes with a subcommand instead of replacing it", async () => {
  // A modifier, not a mode: a positional would collide with local/cloud.
  const { code, captured, stderr } = await runLauncher({
    args: ["local", "--beta"],
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(captured.SEALWIRE_BETA, "1");
});

test("an explicit SEALWIRE_BETA in the environment still reaches the relay", async () => {
  // The flag is sugar over the env var; setting it directly must still work.
  const { code, captured, stderr } = await runLauncher({
    extraEnv: { SEALWIRE_BETA: "1" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(captured.SEALWIRE_BETA, "1");
});

test("`--beta` is documented in the help output", async () => {
  const workdir = mkdtempSync(path.join(os.tmpdir(), "sealwire-beta-help-"));
  const stdout = await new Promise((resolve) => {
    const child = spawn(process.execPath, [launcher, "--help"], {
      env: { HOME: process.env.HOME, PATH: workdir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => resolve(out));
  });
  rmSync(workdir, { recursive: true, force: true });
  assert.match(stdout, /--beta/);
});
