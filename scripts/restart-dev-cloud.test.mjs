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
const script = path.join(here, "restart-dev-cloud.sh");

// Drive restart-dev-cloud.sh with `npm` and `cargo` stubbed out, so the smoke
// test exercises the script's own control flow (env sourcing + logging) without
// building or launching a real relay-server. The env is deliberately MINIMAL —
// we must NOT inherit an ambient RELAY_BROKER_CONTROL_URL, because the whole
// point is to prove the documented two-variable quickstart works from a clean
// shell (README: only RELAY_BROKER_URL + RELAY_BROKER_AUTH_MODE are set).
function runScript({ envFileBody, envFileName = ".env.cloud.local" } = {}) {
  const workdir = mkdtempSync(path.join(os.tmpdir(), "restart-dev-cloud-"));
  const pkillLog = path.join(workdir, "pkill.log");
  // CRITICAL: stub `pkill` too. The script runs broad `pkill -f "vite"/"cargo
  // run"/"dev-full"` at startup; because scripts/*.test.mjs runs under `npm
  // test`, an unstubbed pkill would terminate a developer's or a concurrent CI
  // job's real vite/relay-server/relay-broker/dev-full processes. The stub
  // records its invocation so we can assert it (not the system pkill) ran.
  for (const [name, body] of [
    ["npm", "#!/bin/sh\nexit 0\n"],
    ["cargo", "#!/bin/sh\necho STUB_CARGO_RAN\nexit 0\n"],
    ["pkill", '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PKILL_LOG"\nexit 0\n'],
  ]) {
    const p = path.join(workdir, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
  if (envFileBody != null) {
    writeFileSync(path.join(workdir, envFileName), envFileBody);
  }

  return new Promise((resolve) => {
    const child = spawn("/bin/sh", [script], {
      cwd: workdir,
      // Clean env: PATH (workdir stubs FIRST, so they shadow the real pkill/npm/
      // cargo) plus coreutils and HOME. No RELAY_BROKER_* leaks in from the
      // runner's shell.
      env: {
        PATH: `${workdir}:/usr/bin:/bin`,
        HOME: workdir,
        PKILL_LOG: pkillLog,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => {
      const pkillCalls = existsSync(pkillLog)
        ? readFileSync(pkillLog, "utf8")
        : "";
      rmSync(workdir, { recursive: true, force: true });
      resolve({ code, stdout, stderr, pkillCalls });
    });
  });
}

const README_MINIMAL_ENV =
  "RELAY_BROKER_URL=wss://agent-relay.up.railway.app\n" +
  "RELAY_BROKER_AUTH_MODE=public\n";

test("restart-dev-cloud.sh starts the relay from the documented two-variable env", async () => {
  const { code, stdout, stderr, pkillCalls } = await runScript({
    envFileBody: README_MINIMAL_ENV,
  });
  assert.doesNotMatch(
    stderr,
    /unbound variable/,
    `script must not die on an unset broker var from a clean env\nstderr:\n${stderr}`
  );
  assert.equal(code, 0, `expected clean start; exit=${code}\nstderr:\n${stderr}`);
  assert.match(
    stdout,
    /STUB_CARGO_RAN/,
    "the script must reach `exec cargo run -p relay-server`"
  );
  // Prove the STUBBED pkill ran (not the system one that would kill real
  // dev/CI processes): the script targets these patterns at startup.
  assert.match(pkillCalls, /dev-full\.mjs/, "pkill must be the stub, not system pkill");
  assert.match(pkillCalls, /relay-server/);
});

test("restart-dev-cloud.sh falls back to the legacy .env.public.local", async () => {
  const { code, stdout, stderr } = await runScript({
    envFileBody: README_MINIMAL_ENV,
    envFileName: ".env.public.local",
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.match(
    stdout,
    /STUB_CARGO_RAN/,
    "an existing .env.public.local must still be sourced"
  );
});
