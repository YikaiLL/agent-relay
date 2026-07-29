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
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { browserOpenerFor } from "./sealwire-browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, "sealwire.mjs");

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function runBrowserLaunch({
  ci = false,
  existingRelay = false,
  noOpen = false,
} = {}) {
  const workdir = mkdtempSync(path.join(os.tmpdir(), "sealwire-browser-open-"));
  const capturePath = path.join(workdir, "opened-url.txt");
  const serverScript = path.join(workdir, "fake-relay-server.mjs");
  const relayStub = path.join(workdir, "stub-relay-server");
  const openerName = process.platform === "darwin" ? "open" : "xdg-open";
  const openerStub = path.join(workdir, openerName);
  const port = await availablePort();
  let occupiedServer = null;

  if (existingRelay) {
    occupiedServer = http.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            status: "ok",
            service: "relay-server",
            provider: "existing",
            launch_id: "a-different-launch",
          },
        })
      );
    });
    await new Promise((resolve, reject) => {
      occupiedServer.once("error", reject);
      occupiedServer.listen(port, "127.0.0.1", resolve);
    });
  }

  const fakeRelaySource = existingRelay
    ? [
        'import http from "node:http";',
        'import process from "node:process";',
        "setTimeout(() => {",
        "  const server = http.createServer();",
        "  server.once('error', () => process.exit(1));",
        "  server.once('listening', () => process.exit(2));",
        '  server.listen(Number(process.env.PORT), "127.0.0.1");',
        "}, 500);",
        "",
      ]
    : [
      'import { existsSync } from "node:fs";',
      'import http from "node:http";',
      'import process from "node:process";',
      "const server = http.createServer((request, response) => {",
      '  response.setHeader("content-type", "application/json");',
      '  response.end(JSON.stringify({ ok: true, data: { status: "ok", service: "relay-server", provider: "fake", launch_id: process.env.SEALWIRE_LAUNCH_ID } }));',
      "});",
      'server.listen(Number(process.env.PORT), "127.0.0.1");',
      "const started = Date.now();",
      "const timer = setInterval(() => {",
      "  if (existsSync(process.env.SEALWIRE_OPEN_CAPTURE) || Date.now() - started > 1200) {",
      "    clearInterval(timer);",
      "    server.close();",
      "  }",
      "}, 25);",
      "",
    ];
  writeFileSync(serverScript, fakeRelaySource.join("\n"));
  writeFileSync(
    relayStub,
    '#!/bin/sh\nexec "$SEALWIRE_TEST_NODE" "$SEALWIRE_TEST_SERVER_SCRIPT"\n'
  );
  writeFileSync(
    openerStub,
    '#!/bin/sh\nprintf "%s" "$1" > "$SEALWIRE_OPEN_CAPTURE"\n'
  );
  chmodSync(relayStub, 0o755);
  chmodSync(openerStub, 0o755);

  const args = [launcher, "--no-broker", "--port", String(port)];
  if (noOpen) {
    args.push("--no-open");
  }
  const env = {
    HOME: process.env.HOME,
    PATH: workdir,
    CI: ci ? "1" : "",
    AGENT_RELAY_SERVER_BIN: relayStub,
    SEALWIRE_OPEN_CAPTURE: capturePath,
    SEALWIRE_TEST_NODE: process.execPath,
    SEALWIRE_TEST_SERVER_SCRIPT: serverScript,
  };

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
  const openedUrl = existsSync(capturePath)
    ? readFileSync(capturePath, "utf8")
    : null;
  if (occupiedServer) {
    await new Promise((resolve) => occupiedServer.close(resolve));
  }
  rmSync(workdir, { recursive: true, force: true });
  return { ...result, openedUrl, port };
}

test(
  "launcher opens the local web UI after the relay health check succeeds",
  { skip: process.platform === "win32" },
  async () => {
    const { code, stdout, stderr, openedUrl, port } = await runBrowserLaunch();
    assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
    assert.equal(openedUrl, `http://127.0.0.1:${port}`);
    assert.match(stdout, /opening http:\/\/127\.0\.0\.1:\d+ in your default browser/);
  }
);

test(
  "launcher does not open a different relay already occupying the target port",
  { skip: process.platform === "win32" },
  async () => {
    const { code, stdout, stderr, openedUrl } = await runBrowserLaunch({
      existingRelay: true,
    });
    assert.equal(code, 1, `exit=${code}\nstderr:\n${stderr}`);
    assert.equal(openedUrl, null);
    assert.doesNotMatch(stdout, /opening .* in your default browser/);
  }
);

test(
  "CI skips automatic browser opening",
  { skip: process.platform === "win32" },
  async () => {
    const { code, stdout, stderr, openedUrl } = await runBrowserLaunch({
      ci: true,
    });
    assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
    assert.equal(openedUrl, null);
    assert.doesNotMatch(stdout, /opening .* in your default browser/);
  }
);

test(
  "`--no-open` leaves the browser closed",
  { skip: process.platform === "win32" },
  async () => {
    const { code, stderr, openedUrl } = await runBrowserLaunch({ noOpen: true });
    assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
    assert.equal(openedUrl, null);
  }
);

test("Windows uses the default-URL rundll32 opener without a shell", () => {
  const url = "http://127.0.0.1:8787";
  assert.deepEqual(browserOpenerFor("win32", url), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", url],
  });
});
