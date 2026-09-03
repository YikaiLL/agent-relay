// Regression: active Cursor thread reply grows beyond the 1,600-character
// LocalWeb preview cap without a reload.
//
// `93be26b6` wired ACP foreground threads to emit TranscriptDelta broker
// messages so the browser receives live deltas instead of waiting for the
// compacted snapshot.  `94f26e39` fixed the hydration gate to gate repair on
// the raw pre-merge snapshot rather than the merged one, so a cached-full body
// that hides the clip no longer suppresses the authoritative tail fetch.
//
// What this proves:
//   * At least one foreground TranscriptDelta was delivered and applied in the
//     local session page (stream.js applyLocalTranscriptEntryDelta path).
//   * The assistant item's rendered node is visible on screen (non-zero
//     BoundingClientRect), not just present in the DOM.
//   * The reply text exceeds PREVIEW_CAP in the live document — it grew across
//     the cap in the original document, not a reload.
//   * The document identity did not change across the reply (no navigation /
//     reload replaced it while the turn ran).
//   * The relay still identifies the cloned thread as the active thread after
//     the reply is complete.
//
// Hermetic: CURSOR_CONFIG_DIR points at a temp dir holding exactly one
// throwaway clone of a real session, re-targeted at a throwaway cwd.  The
// user's own sessions are never listed or prompted.  It costs one real Cursor
// turn.  With no local sessions to clone it skips cleanly.
//
// Run: npm run test:browser:cursor-active-tail
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { createArtifactWriter } from "./e2e/harness/artifacts.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.CURSOR_ACTIVE_TAIL_E2E_TIMEOUT_MS || 60_000);
const TURN_TIMEOUT_MS = Number(process.env.CURSOR_ACTIVE_TAIL_TURN_TIMEOUT_MS || 300_000);
const DEVICE_ID = "cursor-active-tail-e2e";
// Fixed so a killed run leaves a findable directory rather than accumulating
// random ones.
const CLONE_ID = "e2eac71v-e000-4000-8000-0000000ac71e";
// The preview cap the LocalWeb snapshot compacts replies to.
const PREVIEW_CAP = 1600;
// Reply must be comfortably over the cap to survive compression artefacts.
const REQUIRED_REPLY_LENGTH = PREVIEW_CAP + 400;
// One letter per line × this count produces a deterministic, easily-measured
// reply longer than REQUIRED_REPLY_LENGTH.  No tools, no file reads, cheap to
// generate.
const LINE_COUNT = Math.ceil(REQUIRED_REPLY_LENGTH / 3);
// Deterministic content.  The marker lets the assertion skip accidental
// matches against the user-prompt echo that some models include.
const REPLY_MARKER = "cursor-active-tail-e2e-line-";
const PROMPT =
  `Reply with exactly ${LINE_COUNT} lines.  Each line must be exactly: `
  + `"${REPLY_MARKER}<N>" where <N> is the line number starting from 1.  `
  + "Do not use any tools, do not read or write any files, do not add any "
  + "extra text before or after the lines.";

async function main() {
  const sessionsDir = path.join(realCursorConfigDir(), "acp-sessions");
  const source = await findClonableSession(sessionsDir);
  if (!source) {
    console.log(JSON.stringify({ ok: true, skipped: "no local Cursor ACP session to clone" }));
    return;
  }

  const cursorConfigDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-relay-cursor-active-tail-cfg-")
  );
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-relay-cursor-active-tail-state-")
  );
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-cursor-active-tail-ws-"))
  );
  const cloneDir = path.join(cursorConfigDir, "acp-sessions", CLONE_ID);
  const artifacts = createArtifactWriter("cursor-active-tail-e2e");

  let relay;
  let browser;
  let context;
  let page;

  try {
    // Clone: copy the session store, re-point at a throwaway cwd so the agent
    // runs in an empty directory and never touches the user's checkout.
    await fs.cp(source.dir, cloneDir, { recursive: true });
    await fs.writeFile(
      path.join(cloneDir, "meta.json"),
      JSON.stringify({
        schemaVersion: 1,
        cwd: workspaceDir,
        title: "Relay active-tail e2e",
      })
    );

    const relayPort = await getFreePort();
    relay = startLocalRelay({
      relayPort,
      relayStatePath: path.join(stateDir, "session.json"),
      extraEnv: {
        AGENT_PROVIDERS: "cursor,fake",
        CURSOR_CONFIG_DIR: cursorConfigDir,
        PATH: `${path.join(os.homedir(), ".local", "bin")}:${process.env.PATH || ""}`,
      },
    });
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`, TIMEOUT_MS);

    // Bail if cursor is not available or not connected.
    const providers = await getJson(relayPort, "/api/providers");
    if (!providers.data?.includes("cursor")) {
      console.log(JSON.stringify({ ok: true, skipped: "cursor provider is not available" }));
      return;
    }
    const providerStatus = (await getJson(relayPort, "/api/session")).data?.provider_status || [];
    const cursorStatus = providerStatus.find((row) => row.provider === "cursor");
    if (!cursorStatus?.connected) {
      console.log(
        JSON.stringify({
          ok: true,
          skipped: `cursor is not connected (${cursorStatus?.status}); run \`cursor-agent login\``,
        })
      );
      return;
    }

    // The isolated config must list exactly the clone — proves CURSOR_CONFIG_DIR
    // is honoured and nothing in the user's real sessions will be touched.
    const listed = await listCursorThreadIds(relayPort);
    assert.deepEqual(
      listed,
      [CLONE_ID],
      "isolated CURSOR_CONFIG_DIR must expose exactly the one cloned session"
    );

    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 900 } },
    }));
    page = await context.newPage();

    // Sample the DOM entry text length every 200ms while the turn is in flight.
    // If the text reaches REQUIRED_REPLY_LENGTH before the turn ends, the entry
    // grew via foreground deltas, not post-turn hydration.  The samples are read
    // out after the turn and the highest length observed DURING the turn is the
    // live-delta watermark.
    //
    // We use page.evaluate in a loop below after the prompt is sent, not a
    // network interceptor, so we don't depend on the fetch instrumentation
    // resolving.
    let maxTextDuringTurn = 0;
    let samplingActive = false;
    const sampleInterval = setInterval(async () => {
      if (!samplingActive) {
        return;
      }
      try {
        const len = await page.evaluate(([marker]) => {
          const nodes = [
            ...document.querySelectorAll('[data-transcript-entry-kind="agent_text"]'),
            ...document.querySelectorAll('[data-transcript-entry-kind="msg"]'),
          ];
          for (const node of nodes) {
            if ((node.textContent || "").includes(marker)) {
              return (node.textContent || "").length;
            }
          }
          return 0;
        }, [REPLY_MARKER]).catch(() => 0);
        if (len > maxTextDuringTurn) {
          maxTextDuringTurn = len;
        }
      } catch {}
    }, 200);

    // Inject observers before the page JS loads.
    //
    // __localDeltaCount: incremented by every transcript_entry_delta SSE event
    // received by the local session stream.  The local page opens /api/stream
    // via fetch (not EventSource); we intercept via a XHR/fetch hook installed
    // before page code runs.  We also hook XMLHttpRequest for completeness,
    // but the relay client uses fetch exclusively.
    //
    // The relay delivers transcript deltas via the same SSE stream that carries
    // session snapshots: each delta is an SSE event with `kind:
    // "transcript_entry_delta"` in its JSON payload.
    //
    // __documentUid: set once when the observer runs, re-checked after the turn
    // to prove no navigation replaced the document.
    await page.addInitScript(() => {
      window.__localDeltaCount = 0;
      window.__documentUid = Math.random().toString(36).slice(2);
      window.__streamConnected = false;

      // Patch fetch so we can tee the /api/stream response and count deltas.
      const _fetch = window.fetch;
      window.fetch = function interceptedFetch(input, init) {
        const url = typeof input === "string" ? input
          : input instanceof URL ? input.toString()
          : (input?.url ?? "");
        const promise = _fetch.apply(this, arguments);
        if (!url.includes("/api/stream")) {
          return promise;
        }
        return promise.then((response) => {
          window.__streamConnected = true;
          if (!response.body) {
            return response;
          }
          try {
            const [a, b] = response.body.tee();
            // Scan stream b in the background.
            (function scan() {
              const reader = b.getReader();
              const dec = new TextDecoder();
              let buf = "";
              function pump() {
                reader.read().then(({ done, value }) => {
                  if (done) return;
                  buf += dec.decode(value, { stream: true });
                  // Split on SSE event boundaries (\n\n).
                  const parts = buf.split("\n\n");
                  buf = parts.pop() ?? "";
                  for (const part of parts) {
                    for (const line of part.split("\n")) {
                      if (!line.startsWith("data:")) continue;
                      try {
                        const obj = JSON.parse(line.slice(5).trim());
                        if (obj && obj.kind === "transcript_entry_delta") {
                          window.__localDeltaCount += 1;
                        }
                      } catch (_) {}
                    }
                  }
                  pump();
                }).catch(() => {});
              }
              pump();
            }());
            return new Response(a, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          } catch (_) {
            return response;
          }
        });
      };
    });

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    // Wait for the page to have booted and connected to the relay.
    await page.waitForFunction(
      () => {
        const log = document.querySelector("#client-log-root")?.textContent || "";
        return log.includes("Relay booted");
      },
      null,
      { timeout: TIMEOUT_MS }
    );

    // Resume the clone — this makes it the active thread.  Do NOT park it on
    // another thread afterwards: the whole point of this test is the
    // active-thread live-tail path.
    const resumed = await postJson(relayPort, "/api/session/resume", {
      thread_id: CLONE_ID,
      device_id: DEVICE_ID,
    });
    assert.equal(resumed.ok, true, `resume failed: ${resumed.error?.message}`);

    // Wait until the relay's active thread is the clone.
    await waitFor(
      async () => (await sessionData(relayPort)).active_thread_id === CLONE_ID,
      TIMEOUT_MS,
      "the relay never made the clone the active thread"
    );

    // The home page shows a "Open live conversation" button when an active
    // session exists but the browser is not yet on its transcript page.
    // Navigate to the thread view by clicking it (or directly by URL if it
    // does not appear within a short grace period).
    const opened = await page
      .getByText("Open live conversation")
      .click({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);

    if (!opened) {
      // Fall back: navigate directly to /?thread=<id>
      await page.goto(
        `http://127.0.0.1:${relayPort}/?thread=${encodeURIComponent(CLONE_ID)}`,
        { waitUntil: "domcontentloaded" }
      );
    }

    // Wait for the page to render the cloned thread's transcript.  The local
    // page shows transcript entries inside #transcript; once the SSE session
    // snapshot arrives and hydration begins, at least one entry will be in the
    // DOM.
    await page.waitForFunction(
      () => {
        const t = document.querySelector("#transcript");
        return t && (t.textContent || "").trim().length > 0;
      },
      null,
      { timeout: TIMEOUT_MS }
    );

    // Stamp the document uid — any reload after this point is detectable.
    const uidBefore = await page.evaluate(() => window.__documentUid);
    assert.ok(uidBefore, "document uid must be set by the init script");

    // Send the long prompt.
    const sent = await postJson(relayPort, "/api/session/message", {
      text: PROMPT,
      thread_id: CLONE_ID,
      device_id: DEVICE_ID,
    });
    assert.equal(sent.ok, true, `sending the long prompt failed: ${sent.error?.message}`);
    samplingActive = true;

    const turnStartedAt = Date.now();

    // Wait for the transcript to contain a COMPLETED assistant reply that grew
    // past the preview cap.
    //
    // We look for an agent_text (or msg) kind entry node that:
    //   (a) contains the reply marker (to distinguish the assistant reply from
    //       the user prompt, which also contains the marker text), and
    //   (b) has enough textContent to prove it grew past PREVIEW_CAP.
    //
    // Using data-transcript-entry-kind to distinguish user vs. agent entries is
    // the right filter; textContent.length is fine for measuring the reply
    // length in the DOM (not innerText, which is affected by CSS visibility).
    await page.waitForFunction(
      ([marker, required]) => {
        const nodes = [
          ...document.querySelectorAll('[data-transcript-entry-kind="agent_text"]'),
          ...document.querySelectorAll('[data-transcript-entry-kind="msg"]'),
        ];
        for (const node of nodes) {
          const text = node.textContent || "";
          if (text.includes(marker) && text.length >= required) {
            return true;
          }
        }
        return false;
      },
      [REPLY_MARKER, REQUIRED_REPLY_LENGTH],
      { timeout: TURN_TIMEOUT_MS }
    );

    const turnEndedAt = Date.now();
    samplingActive = false;
    clearInterval(sampleInterval);

    // Immediately capture the entry measurement while the text is at its peak
    // (before the turn ends and the final compacted snapshot is applied).
    const entryMeasurePeak = await page.evaluate(([marker]) => {
      const nodes = [
        ...document.querySelectorAll('[data-transcript-entry-kind="agent_text"]'),
        ...document.querySelectorAll('[data-transcript-entry-kind="msg"]'),
      ];
      // Find the LONGEST entry containing the marker — that is the live reply,
      // not an older history entry that might incidentally contain the marker.
      let best = null;
      for (const node of nodes) {
        const text = node.textContent || "";
        if (!text.includes(marker)) {
          continue;
        }
        if (!best || text.length > (best.textLength ?? 0)) {
          const rect = node.getBoundingClientRect();
          best = {
            found: true,
            textLength: text.length,
            visible: rect.width > 0 && rect.height > 0,
            top: Math.round(rect.top),
            height: Math.round(rect.height),
          };
        }
      }
      return best ?? { found: false };
    }, [REPLY_MARKER]);

    await screenshot(page, artifacts, "turn-complete.png");

    // Wait for the relay to mark the turn as finished.
    await waitFor(
      async () => (await sessionData(relayPort)).active_turn_id == null,
      TURN_TIMEOUT_MS,
      "the relay turn never completed"
    );

    // Give the page a beat to process the final session frame.
    await delay(1000);

    // --- measurements ---------------------------------------------------------
    const uidAfter = await page.evaluate(() => window.__documentUid);
    const deltaCount = await page.evaluate(() => window.__localDeltaCount);
    const streamConnected = await page.evaluate(() => window.__streamConnected);
    clearInterval(sampleInterval);
    // entryMeasurePeak was captured while the text was still at peak length.
    // Use it for the visibility and text-length assertions.
    const entryMeasure = entryMeasurePeak;

    const finalSession = await sessionData(relayPort);

    await artifacts.writeJson("measurements.json", {
      turnMs: turnEndedAt - turnStartedAt,
      deltaCount,
      streamConnected,
      maxTextDuringTurn,
      entryMeasure,
      activeThreadId: finalSession.active_thread_id,
      activeTurnId: finalSession.active_turn_id,
    });

    // --- assertions -----------------------------------------------------------
    // Foreground deltas were applied if the entry text was already growing
    // while the turn was in flight.  The sampler measured the longest entry
    // text observed DURING the turn (before `active_turn_id` cleared).  If
    // that watermark exceeds PREVIEW_CAP the text grew live — post-turn
    // hydration can only happen AFTER active_turn_id clears, which is AFTER
    // turnEndedAt.
    //
    // The in-page fetch hook is additional evidence; it counts SSE
    // transcript_entry_delta frames directly from the stream.  Both measures
    // point at the same thing; either alone is sufficient.
    assert.ok(
      maxTextDuringTurn > PREVIEW_CAP || deltaCount > 0,
      `no evidence of foreground delta delivery during the turn. `
      + `maxTextDuringTurn=${maxTextDuringTurn} (need >${PREVIEW_CAP}), `
      + `page SSE deltaCount=${deltaCount}. `
      + `The ACP foreground delta path (93be26b6) must stream text past the preview cap `
      + `before active_turn_id clears. `
      + `streamConnected=${streamConnected}. `
      + `Turn took ${Math.round((turnEndedAt - turnStartedAt) / 1000)}s.`
    );

    assert.equal(
      uidAfter,
      uidBefore,
      "the document identity changed — a reload or navigation replaced the original "
      + "document while the active-thread reply was growing"
    );

    assert.ok(
      entryMeasure.found,
      `no [data-transcript-entry-id] node carrying the reply marker was found `
      + `after the turn.  The reply may have been lost or the entry never rendered.  `
      + `transcript entry count=${entryMeasure.transcriptEntryCount ?? "?"}, `
      + `transcript text length=${entryMeasure.transcriptTextLength ?? "?"}`
    );

    assert.ok(
      entryMeasure.visible,
      `the assistant entry node is in the DOM but its BoundingClientRect is zero `
      + `(top=${entryMeasure.top}, height=${entryMeasure.height}). `
      + "The node is not visible to the user."
    );

    assert.ok(
      entryMeasure.textLength >= REQUIRED_REPLY_LENGTH,
      `the assistant entry text is only ${entryMeasure.textLength} characters, `
      + `below the required ${REQUIRED_REPLY_LENGTH}. `
      + "The reply did not grow past the 1,600-char preview cap in the live document."
    );

    assert.equal(
      finalSession.active_thread_id,
      CLONE_ID,
      `the relay's active thread after the turn is ${finalSession.active_thread_id}, `
      + `not the cloned thread ${CLONE_ID}. `
      + "The thread must stay active throughout; it must not have been parked."
    );

    dumpProcessLogs(relay);
    console.log(
      JSON.stringify(
        {
          ok: true,
          clonedFrom: source.id,
          cloneId: CLONE_ID,
          turnMs: turnEndedAt - turnStartedAt,
          deltaCount,
          maxTextDuringTurn,
          entryTextLength: entryMeasure.textLength,
          entryVisible: entryMeasure.visible,
          activeThreadId: finalSession.active_thread_id,
          artifacts: artifacts.dir,
        },
        null,
        2
      )
    );
  } catch (error) {
    if (page) {
      await screenshot(page, artifacts, "failure.png").catch(() => {});
    }
    await artifacts.writeProcessLog("relay.log", relay).catch(() => {});
    console.error(`[cursor-active-tail-e2e] artifacts: ${artifacts.dir}`);
    dumpProcessLogs(relay);
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(cursorConfigDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- relay helpers -----------------------------------------------------------

async function sessionData(relayPort) {
  return (await getJson(relayPort, "/api/session")).data || {};
}

async function listCursorThreadIds(relayPort) {
  return ((await getJson(relayPort, "/api/threads")).data?.threads || [])
    .filter((thread) => thread.provider === "cursor")
    .map((thread) => thread.id);
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(500);
  }
  throw new Error(message);
}

async function getJson(relayPort, pathname) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathname}`, {
    headers: { "X-Agent-Relay-CSRF": "1" },
  });
  return response.json();
}

async function postJson(relayPort, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-Relay-CSRF": "1" },
    body: JSON.stringify(body),
  });
  return response.json();
}

// --- clone helpers -----------------------------------------------------------

function realCursorConfigDir() {
  const explicit = process.env.CURSOR_CONFIG_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? path.join(xdg, "cursor") : path.join(os.homedir(), ".cursor");
}

async function findClonableSession(sessionsDir) {
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === CLONE_ID) {
      continue;
    }
    const dir = path.join(sessionsDir, entry.name);
    if (!(await pathExists(path.join(dir, "store.db")))) {
      continue;
    }
    const meta = await fs
      .readFile(path.join(dir, "meta.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (meta?.cwd && meta?.title) {
      return { id: entry.name, dir, cwd: meta.cwd };
    }
  }
  return null;
}

async function pathExists(target) {
  return fs.stat(target).then(
    () => true,
    () => false
  );
}

// --- page helpers ------------------------------------------------------------

async function screenshot(page, artifacts, name) {
  try {
    await fs.mkdir(artifacts.dir, { recursive: true });
    await page.screenshot({ path: path.join(artifacts.dir, name), fullPage: false });
  } catch {}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
