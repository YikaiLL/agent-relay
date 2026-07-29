import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, "sealwire.mjs");

// The hosted broker `sealwire cloud` dials by default when nothing else is
// configured. Kept in sync with HOSTED_PUBLIC_BROKER_ORIGIN in sealwire.mjs.
const HOSTED_BROKER_WS = "wss://agent-relay.up.railway.app";
const HOSTED_BROKER_HTTP = "https://agent-relay.up.railway.app";

// Black-box drive the launcher with a stub standing in for the compiled
// relay-server binary. The stub records the broker URL it was handed and
// exits 0 (see sealwire-local-command.test.mjs for the mirror-image local
// case). PATH is intentionally bare, so the stub uses only shell builtins.
function runLauncher({ extraEnv = {}, args = [] } = {}) {
  const workdir = mkdtempSync(path.join(os.tmpdir(), "sealwire-cloud-"));
  const capturePath = path.join(workdir, "captured-broker.txt");
  const stubPath = path.join(workdir, "stub-relay-server");
  writeFileSync(
    stubPath,
    [
      "#!/bin/sh",
      "{",
      '  printf "RELAY_BROKER_URL=%s\\n" "${RELAY_BROKER_URL:-<unset>}"',
      '  printf "RELAY_BROKER_PUBLIC_URL=%s\\n" "${RELAY_BROKER_PUBLIC_URL:-<unset>}"',
      '  printf "RELAY_BROKER_CONTROL_URL=%s\\n" "${RELAY_BROKER_CONTROL_URL:-<unset>}"',
      '  printf "RELAY_BROKER_AUTH_MODE=%s\\n" "${RELAY_BROKER_AUTH_MODE:-<unset>}"',
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
    const child = spawn(process.execPath, [launcher, ...args, "--no-open"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => {
      const raw = existsSync(capturePath)
        ? readFileSync(capturePath, "utf8")
        : null;
      rmSync(workdir, { recursive: true, force: true });
      resolve({ code, stdout, stderr, broker: parseCaptured(raw) });
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

test("`sealwire cloud` is a recognized command, not an unknown argument", async () => {
  const { code, stderr } = await runLauncher({ args: ["cloud"] });
  assert.equal(
    code,
    0,
    `expected \`sealwire cloud\` to start the server; exit=${code}\nstderr:\n${stderr}`
  );
  assert.doesNotMatch(
    stderr,
    /unknown argument/,
    "`cloud` must not be rejected as an unknown argument"
  );
});

test("`sealwire cloud` attaches to the hosted broker by default", async () => {
  // `cloud` is the online counterpart to `local`: with nothing else configured
  // it must still dial the hosted public broker rather than start localhost-only.
  const { code, broker, stderr } = await runLauncher({ args: ["cloud"] });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    broker.RELAY_BROKER_URL,
    HOSTED_BROKER_WS,
    "`sealwire cloud` must default RELAY_BROKER_URL to the hosted broker"
  );
  assert.equal(
    broker.RELAY_BROKER_AUTH_MODE,
    "public",
    "`sealwire cloud` must run in public broker auth mode"
  );
});

test("`sealwire cloud --broker <url>` overrides the hosted default", async () => {
  const { code, broker, stderr } = await runLauncher({
    args: ["cloud", "--broker", "wss://broker.example.com"],
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    broker.RELAY_BROKER_URL,
    "wss://broker.example.com",
    "an explicit --broker must win over the hosted default"
  );
});

test("`sealwire cloud` prefers a configured broker origin over the hosted default", async () => {
  const { code, broker, stderr } = await runLauncher({
    args: ["cloud"],
    extraEnv: { AGENT_RELAY_PUBLIC_BROKER_URL: "wss://configured.example.com" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    broker.RELAY_BROKER_URL,
    "wss://configured.example.com",
    "a configured broker origin must win over the hosted default"
  );
});

test("`sealwire cloud` derives a coherent broker set (ambient RELAY_BROKER_URL cannot split it)", async () => {
  // Regression: an ambient RELAY_BROKER_URL used to override only the websocket
  // URL, leaving PUBLIC_URL/CONTROL_URL pointing at the hosted broker — so the
  // relay connected to one broker while enrollment/control targeted another.
  // `cloud` must derive every endpoint from the single resolved origin.
  const { code, broker, stderr } = await runLauncher({
    args: ["cloud"],
    extraEnv: { RELAY_BROKER_URL: "wss://ambient.example.com" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    broker.RELAY_BROKER_URL,
    HOSTED_BROKER_WS,
    "an ambient RELAY_BROKER_URL must not override the resolved cloud origin"
  );
  assert.equal(
    broker.RELAY_BROKER_PUBLIC_URL,
    HOSTED_BROKER_WS,
    "PUBLIC_URL must match the same resolved origin as URL"
  );
  assert.equal(
    broker.RELAY_BROKER_CONTROL_URL,
    HOSTED_BROKER_HTTP,
    "CONTROL_URL must match the same resolved origin as URL"
  );
});

test("`sealwire cloud` forces public auth mode over an ambient self_hosted", async () => {
  // `cloud` means the hosted public broker; an inherited self_hosted auth mode
  // would make it dial the hosted broker with the wrong auth and fail.
  const { code, broker, stderr } = await runLauncher({
    args: ["cloud"],
    extraEnv: { RELAY_BROKER_AUTH_MODE: "self_hosted" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    broker.RELAY_BROKER_AUTH_MODE,
    "public",
    "`cloud` must run in public auth mode regardless of an ambient override"
  );
});

test("`sealwire cloud --broker <url>` wins over an ambient RELAY_BROKER_URL for every endpoint", async () => {
  const { code, broker, stderr } = await runLauncher({
    args: ["cloud", "--broker", "wss://flag.example.com"],
    extraEnv: { RELAY_BROKER_URL: "wss://ambient.example.com" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    broker.RELAY_BROKER_URL,
    "wss://flag.example.com",
    "the explicit --broker must control the websocket URL, not an ambient var"
  );
  assert.equal(
    broker.RELAY_BROKER_PUBLIC_URL,
    "wss://flag.example.com",
    "PUBLIC_URL must follow the explicit --broker"
  );
  assert.equal(
    broker.RELAY_BROKER_CONTROL_URL,
    "https://flag.example.com",
    "CONTROL_URL must follow the explicit --broker"
  );
});

// --- Generic `--broker` path: shared broker-env resolution ---
// `cloud` fully manages the endpoint set (hosted broker), but the plain
// `--broker` / configured-origin path must keep honoring explicit split-horizon
// overrides. README: "RELAY_BROKER_PUBLIC_URL ... only set it separately when
// the relay reaches the broker through a different hostname than remote devices
// do (e.g. a Docker network)."

test("`--broker` honors an explicit split-horizon RELAY_BROKER_PUBLIC_URL", async () => {
  const { code, broker, stderr } = await runLauncher({
    args: ["--broker", "wss://internal.example.com"],
    extraEnv: { RELAY_BROKER_PUBLIC_URL: "wss://external.example.com" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    broker.RELAY_BROKER_URL,
    "wss://internal.example.com",
    "the websocket URL stays pinned to the resolved origin"
  );
  assert.equal(
    broker.RELAY_BROKER_PUBLIC_URL,
    "wss://external.example.com",
    "an explicit public/pairing URL must survive on the generic --broker path"
  );
  assert.equal(
    broker.RELAY_BROKER_CONTROL_URL,
    "https://internal.example.com",
    "control URL derives from the origin when not overridden"
  );
});

test("`--broker` honors an explicit RELAY_BROKER_CONTROL_URL and auth mode", async () => {
  const { code, broker, stderr } = await runLauncher({
    args: ["--broker", "wss://internal.example.com"],
    extraEnv: {
      RELAY_BROKER_CONTROL_URL: "https://control.example.com",
      RELAY_BROKER_AUTH_MODE: "self_hosted",
    },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    broker.RELAY_BROKER_CONTROL_URL,
    "https://control.example.com",
    "an explicit control host must survive on the generic --broker path"
  );
  assert.equal(
    broker.RELAY_BROKER_AUTH_MODE,
    "self_hosted",
    "self-hosters can still choose their auth mode on the generic --broker path"
  );
});

test("`--broker` pins the websocket URL to the flag over an ambient RELAY_BROKER_URL", async () => {
  // An explicit --broker (or a configured origin) must control the live
  // connection: a stray ambient RELAY_BROKER_URL from the shell can't silently
  // redirect it to a broker the user didn't ask for.
  const { code, broker, stderr } = await runLauncher({
    args: ["--broker", "wss://flag.example.com"],
    extraEnv: { RELAY_BROKER_URL: "wss://ambient.example.com" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    broker.RELAY_BROKER_URL,
    "wss://flag.example.com",
    "an explicit --broker must control the connection, not an ambient var"
  );
});

test("`sealwire cloud --broker <url>` forces public auth even with ambient self_hosted", async () => {
  // Q: custom self-hosted brokers are intentionally excluded from `cloud` —
  // `cloud` means the hosted public broker (public auth). Self-hosted auth is
  // reached via the plain `--broker` path (see the test above).
  const { code, broker, stderr } = await runLauncher({
    args: ["cloud", "--broker", "wss://custom.example.com"],
    extraEnv: { RELAY_BROKER_AUTH_MODE: "self_hosted" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    broker.RELAY_BROKER_AUTH_MODE,
    "public",
    "`cloud` is public-mode; use plain `--broker` for self-hosted auth"
  );
});

test("`sealwire cloud --no-broker` is rejected as contradictory", async () => {
  const { code, stderr } = await runLauncher({
    args: ["cloud", "--no-broker"],
  });
  assert.notEqual(
    code,
    0,
    "`cloud` and `--no-broker` are mutually exclusive and must not both be accepted"
  );
  assert.match(
    stderr,
    /cloud/i,
    "the error should explain the cloud/no-broker conflict"
  );
});
