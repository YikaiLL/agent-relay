import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";
import { deleteThreadAndWait, fetchSession } from "./e2e-thread-cleanup.mjs";

const ROOT = process.cwd();
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const BEFORE_RESTART_PROMPT =
  process.env.BROWSER_E2E_PUBLIC_RECLAIM_PROMPT_BEFORE ||
  "Reply with exactly: public-reclaim-before-restart";
const AFTER_RESTART_PROMPT =
  process.env.BROWSER_E2E_PUBLIC_RECLAIM_PROMPT_AFTER ||
  "Reply with exactly: public-reclaim-after-restart";
const PUBLIC_ISSUER_SECRET =
  process.env.BROWSER_E2E_PUBLIC_ISSUER_SECRET || "browser-e2e-public-issuer";
const RELAY_REFRESH_TOKEN =
  process.env.BROWSER_E2E_PUBLIC_RELAY_REFRESH_TOKEN || "browser-e2e-relay-refresh";
const RELAY_ID = process.env.BROWSER_E2E_PUBLIC_RELAY_ID || "browser-e2e-relay-1";
const BROKER_ROOM_ID =
  process.env.BROWSER_E2E_PUBLIC_RECLAIM_ROOM_ID || "browser-public-reclaim-room";

const managedProcesses = [];

process.on("exit", () => {
  for (const child of managedProcesses) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
});

async function main() {
  const lanIp = resolvePrivateIpv4();
  const brokerPort = await getFreePort();
  const relayPort = await getFreePort();
  const relayStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-reclaim-e2e-"));
  const relayStatePath = path.join(relayStateDir, "session.json");
  const brokerStatePath = path.join(relayStateDir, "public-control.json");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-reclaim-workspace-"))
  );

  const broker = await startPublicBroker({ brokerPort, brokerStatePath });
  await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);

  let relay = startPublicRelay({
    relayPort,
    relayStatePath,
    brokerPort,
    lanIp,
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

  let browser;
  let context;
  let localPage;
  let remotePage;
  let createdThreadId = null;
  let authBeforeRestart = null;
  let authAfterRestart = null;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();

    localPage = await context.newPage();
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    const pairingUrl = await startPairingFromLocalPage(localPage);
    assert.ok(
      pairingUrl.startsWith(`http://${lanIp}:${brokerPort}/?pairing=`),
      `pairing url should use broker public url, got: ${pairingUrl}`
    );

    remotePage = await context.newPage();
    await installClaimLifecycleHook(remotePage);
    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });

    await approvePendingPairing(localPage);
    await waitForPairedRemote(remotePage);

    await openRemoteSessionPanel(remotePage);
    await remotePage.selectOption("#remote-approval-policy-input", "never");
    await remotePage.fill("#remote-cwd-input", workspaceDir);
    await remotePage.click("#remote-start-session-button");

    await waitForSingleStartedThread(relayPort, workspaceDir);
    await remotePage.waitForFunction(() => {
      const input = document.querySelector("#remote-message-input");
      return Boolean(input && !input.disabled);
    }, null, { timeout: TIMEOUT_MS });

    await sendPromptAndWaitForReply(remotePage, BEFORE_RESTART_PROMPT);

    const claimCountsBeforeRestart = await readClaimCounters(remotePage);
    assert.ok(
      claimCountsBeforeRestart.claimChallengeCount >= 1,
      "initial remote pairing/control flow should issue at least one claim_challenge"
    );
    assert.ok(
      claimCountsBeforeRestart.claimDeviceCount >= 1,
      "initial remote pairing/control flow should issue at least one claim_device"
    );

    const relaySessionBeforeRestart = await fetchSession(relayPort);
    createdThreadId = relaySessionBeforeRestart.active_thread_id;
    assert.ok(createdThreadId, "remote start should create an active thread before relay restart");
    authBeforeRestart = await readStoredRemoteAuth(remotePage);
    assert.ok(authBeforeRestart?.payloadSecret, "paired remote should persist a payload secret");
    await waitForPersistedRelayState(relayStatePath, createdThreadId);
    await waitForPersistedPayloadSecret(
      relayStatePath,
      authBeforeRestart.deviceId,
      authBeforeRestart.payloadSecret
    );

    await stopManagedProcess(relay);
    relay = startPublicRelay({
      relayPort,
      relayStatePath,
      brokerPort,
      lanIp,
    });
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
    await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

    await remotePage.waitForFunction(
      ({ beforeChallenge, beforeDevice }) => {
        return (
          (window.__agentRelayClaimChallengeCount || 0) > beforeChallenge &&
          (window.__agentRelayClaimDeviceCount || 0) > beforeDevice
        );
      },
      {
        beforeChallenge: claimCountsBeforeRestart.claimChallengeCount,
        beforeDevice: claimCountsBeforeRestart.claimDeviceCount,
      },
      { timeout: TIMEOUT_MS }
    );

    await remotePage.waitForFunction(() => {
      const input = document.querySelector("#remote-message-input");
      return Boolean(input && !input.disabled);
    }, null, { timeout: TIMEOUT_MS });

    const relaySessionAfterRestart = await fetchSession(relayPort);
    assert.equal(
      relaySessionAfterRestart.active_thread_id,
      createdThreadId,
      "relay restart should restore the previously active thread"
    );
    assert.equal(
      relaySessionAfterRestart.current_cwd,
      workspaceDir,
      "relay restart should restore the active session cwd"
    );
    authAfterRestart = await readStoredRemoteAuth(remotePage);
    assert.ok(
      authAfterRestart?.payloadSecret,
      "remote auth should still contain a payload secret after reclaim"
    );
    assert.equal(
      authAfterRestart.payloadSecret,
      authBeforeRestart.payloadSecret,
      "reclaim should not rotate the payload secret"
    );
    await waitForPersistedPayloadSecret(
      relayStatePath,
      authAfterRestart.deviceId,
      authAfterRestart.payloadSecret
    );

    await sendPromptAndWaitForReply(remotePage, AFTER_RESTART_PROMPT);
    const claimCountsAfterRestart = await readClaimCounters(remotePage);

    assert.ok(
      claimCountsAfterRestart.claimChallengeCount > claimCountsBeforeRestart.claimChallengeCount,
      "relay restart should trigger an automatic claim_challenge"
    );
    assert.ok(
      claimCountsAfterRestart.claimDeviceCount > claimCountsBeforeRestart.claimDeviceCount,
      "relay restart should trigger an automatic claim_device"
    );

    console.log(
      JSON.stringify(
        {
          brokerPort,
          relayPort,
          pairingOrigin: new URL(pairingUrl).origin,
          workspaceDir,
          activeThreadId: createdThreadId,
          claimCountsBeforeRestart,
          claimCountsAfterRestart,
          remoteClientLog: await safeText(remotePage, "#remote-client-log"),
        },
        null,
        2
      )
    );
  } catch (error) {
    if (authBeforeRestart?.payloadSecret || authAfterRestart?.payloadSecret) {
      console.error(
        JSON.stringify(
          {
            authBeforeRestartHash: authBeforeRestart?.payloadSecret
              ? sha256Hex(authBeforeRestart.payloadSecret)
              : null,
            authAfterRestartHash: authAfterRestart?.payloadSecret
              ? sha256Hex(authAfterRestart.payloadSecret)
              : null,
            authBeforeRestartDeviceId: authBeforeRestart?.deviceId || null,
            authAfterRestartDeviceId: authAfterRestart?.deviceId || null,
          },
          null,
          2
        )
      );
    }
    await dumpBrowserState(localPage, remotePage);
    dumpProcessLogs(broker);
    dumpProcessLogs(relay);
    throw error;
  } finally {
    if (createdThreadId) {
      await deleteThreadAndWait(relayPort, createdThreadId, { cwd: workspaceDir }).catch(
        (error) => {
          console.error(
            `[cleanup] failed to delete public reclaim e2e thread ${createdThreadId}: ${error.message}`
          );
        }
      );
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await stopManagedProcess(broker);
    await fs.rm(relayStateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function startPublicBroker({ brokerPort, brokerStatePath }) {
  const relayRegistrations = JSON.stringify([
    {
      relay_id: RELAY_ID,
      broker_room_id: BROKER_ROOM_ID,
      refresh_token: RELAY_REFRESH_TOKEN,
    },
  ]);

  return spawnManagedProcess(
    "broker",
    "cargo",
    ["run", "-p", "relay-broker"],
    {
      BIND_HOST: "0.0.0.0",
      PORT: String(brokerPort),
      RELAY_BROKER_AUTH_MODE: "public",
      RELAY_BROKER_PUBLIC_ISSUER_SECRET: PUBLIC_ISSUER_SECRET,
      RELAY_BROKER_PUBLIC_RELAYS_JSON: relayRegistrations,
      RELAY_BROKER_PUBLIC_STATE_PATH: brokerStatePath,
    }
  );
}

function startPublicRelay({ relayPort, relayStatePath, brokerPort, lanIp }) {
  return spawnManagedProcess(
    "relay",
    "cargo",
    ["run", "-p", "relay-server"],
    {
      PORT: String(relayPort),
      RELAY_STATE_PATH: relayStatePath,
      RELAY_BROKER_URL: `ws://127.0.0.1:${brokerPort}`,
      RELAY_BROKER_PUBLIC_URL: `ws://${lanIp}:${brokerPort}`,
      RELAY_BROKER_CONTROL_URL: `http://127.0.0.1:${brokerPort}`,
      RELAY_BROKER_AUTH_MODE: "public",
      RELAY_BROKER_CHANNEL_ID: BROKER_ROOM_ID,
      RELAY_BROKER_PEER_ID: "browser-public-reclaim-relay",
      RELAY_BROKER_RELAY_ID: RELAY_ID,
      RELAY_BROKER_RELAY_REFRESH_TOKEN: RELAY_REFRESH_TOKEN,
    }
  );
}

async function startPairingFromLocalPage(localPage, previousUrl = "") {
  await openSecurityModal(localPage);
  await localPage.click("#start-pairing-button");
  await localPage.waitForFunction(
    (previous) => {
      const input = document.querySelector("#pairing-link-input");
      return Boolean(
        input &&
          input.value.startsWith("http") &&
          (!previous || input.value !== previous)
      );
    },
    previousUrl,
    { timeout: TIMEOUT_MS }
  );
  return localPage.inputValue("#pairing-link-input");
}

async function openSecurityModal(page) {
  const isOpen = await page.evaluate(() => Boolean(document.querySelector("#security-modal")?.open));
  if (isOpen) {
    return;
  }

  await page.click("#open-security-modal");
  await page.waitForFunction(() => {
    const dialog = document.querySelector("#security-modal");
    return Boolean(dialog?.open);
  });
}

async function approvePendingPairing(localPage) {
  await localPage.waitForFunction(() => {
    return Boolean(document.querySelector("[data-pairing-id][data-pairing-decision='approve']"));
  }, null, { timeout: TIMEOUT_MS });
  await localPage.click("[data-pairing-id][data-pairing-decision='approve']");
}

async function waitForPairedRemote(remotePage) {
  await remotePage.waitForFunction(() => {
    const overview = document.querySelector("#remote-device-overview")?.textContent || "";
    const meta = document.querySelector("#device-meta")?.textContent || "";
    return overview.includes("Paired") || meta.includes("Paired");
  }, null, { timeout: TIMEOUT_MS });
}

async function installClaimLifecycleHook(page) {
  await page.addInitScript(() => {
    if (window.__agentRelayClaimLifecycleHookInstalled) {
      return;
    }

    window.__agentRelayClaimLifecycleHookInstalled = true;
    window.__agentRelayClaimChallengeCount = 0;
    window.__agentRelayClaimDeviceCount = 0;
    const NativeWebSocket = window.WebSocket;

    class InstrumentedWebSocket extends NativeWebSocket {
      send(data) {
        if (typeof data === "string") {
          if (data.includes('"action_id":"claim_challenge-')) {
            window.__agentRelayClaimChallengeCount += 1;
          }
          if (data.includes('"action_id":"claim_device-')) {
            window.__agentRelayClaimDeviceCount += 1;
          }
        }
        return super.send(data);
      }
    }

    window.WebSocket = InstrumentedWebSocket;
  });
}

async function readClaimCounters(page) {
  return page.evaluate(() => ({
    claimChallengeCount: window.__agentRelayClaimChallengeCount || 0,
    claimDeviceCount: window.__agentRelayClaimDeviceCount || 0,
  }));
}

async function openRemoteSessionPanel(page) {
  await page.click("#remote-session-toggle");
  await page.waitForFunction(() => {
    const panel = document.querySelector("#remote-session-panel");
    return Boolean(panel && !panel.hidden);
  });
  await page.click("#remote-session-panel summary");
  await page.waitForFunction(() => {
    const details = document.querySelector("#remote-session-panel details");
    return Boolean(details && details.open);
  });
}

async function sendPromptAndWaitForReply(page, prompt) {
  await page.waitForFunction(() => {
    const input = document.querySelector("#remote-message-input");
    return Boolean(input && !input.disabled);
  }, null, { timeout: TIMEOUT_MS });
  await page.fill("#remote-message-input", prompt);
  await page.click("#remote-send-button");

  const expectedReply = prompt.replace("Reply with exactly: ", "");
  await page.waitForFunction(
    (expected) => {
      const transcript = document.querySelector("#remote-transcript")?.textContent || "";
      return transcript.includes(expected);
    },
    expectedReply,
    { timeout: TIMEOUT_MS }
  );
}

function spawnManagedProcess(name, command, args, extraEnv) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      ...extraEnv,
    },
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
  const text = chunk.toString("utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  child._logBuffer.push(...lines);
  if (child._logBuffer.length > 200) {
    child._logBuffer.splice(0, child._logBuffer.length - 200);
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
    await delay(250);
  }
  throw new Error(`timed out waiting for health at ${url}`);
}

async function waitForBrokerConnection(url, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const payload = await response.json();
      if (response.ok && payload?.ok && payload.data?.broker_connected) {
        return payload.data;
      }
    } catch {}
    await delay(250);
  }
  throw new Error(`timed out waiting for broker connection at ${url}`);
}

async function waitForSingleStartedThread(relayPort, expectedCwd, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort);
    if (session.active_thread_id && session.current_cwd === expectedCwd) {
      return session;
    }
    await delay(250);
  }
  throw new Error(`timed out waiting for relay to start a thread in ${expectedCwd}`);
}

async function waitForPersistedRelayState(statePath, expectedThreadId, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(statePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.active_thread_id === expectedThreadId) {
        return parsed;
      }
    } catch {}
    await delay(250);
  }
  throw new Error(`timed out waiting for relay state persistence for ${expectedThreadId}`);
}

async function waitForPersistedPayloadSecret(
  statePath,
  deviceId,
  payloadSecret,
  timeoutMs = TIMEOUT_MS
) {
  const deadline = Date.now() + timeoutMs;
  let lastPersistedSecret = null;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(statePath, "utf8");
      const parsed = JSON.parse(raw);
      const persistedSecret = parsed?.paired_devices?.[deviceId]?.payload_secret || null;
      lastPersistedSecret = persistedSecret;
      if (persistedSecret === payloadSecret) {
        return parsed;
      }
    } catch {}
    await delay(250);
  }
  throw new Error(
    `timed out waiting for persisted payload secret for ${deviceId} (last seen ${lastPersistedSecret})`
  );
}

async function readStoredRemoteAuth(page) {
  return page.evaluate(
    () => JSON.parse(window.localStorage.getItem("agent-relay.remote-auth") || "null")
  );
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function dumpBrowserState(localPage, remotePage) {
  const dumps = [];
  for (const [label, page] of [
    ["local", localPage],
    ["remote", remotePage],
  ]) {
    if (!page || page.isClosed()) {
      continue;
    }
    try {
      dumps.push(`\n[${label} page]\n${await page.content()}`);
    } catch {}
    try {
      dumps.push(
        `\n[${label} localStorage]\n${JSON.stringify(
          await page.evaluate(() => {
            const values = {};
            for (let index = 0; index < window.localStorage.length; index += 1) {
              const key = window.localStorage.key(index);
              values[key] = window.localStorage.getItem(key);
            }
            return values;
          }),
          null,
          2
        )}`
      );
    } catch {}
  }
  if (dumps.length) {
    console.error(dumps.join("\n"));
  }
}

async function safeText(page, selector) {
  if (!page || page.isClosed()) {
    return null;
  }
  try {
    return await page.textContent(selector);
  } catch {
    return null;
  }
}

async function waitFor(predicate, timeoutMs = TIMEOUT_MS, pollMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(pollMs);
  }
  throw new Error("timed out waiting for condition");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to resolve free port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function resolvePrivateIpv4() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address?.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }
  return "127.0.0.1";
}

await main();
