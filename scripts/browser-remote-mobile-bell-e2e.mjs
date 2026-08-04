// Regression guard for the ACTIVITY BELL on a phone-sized remote surface.
//
// The bell re-buckets the session list by state (Needs input / Working / Reviewing /
// Done) and hides idle sessions. Three things have to hold here that no unit test can
// show:
//
//   1. The bell is REACHABLE at mobile width. `.sidebar-top-bar` is `display: none`
//      under 960px and only re-shown for `.remote-app-shell`; a CSS edit could take the
//      only entry point away without failing anything else.
//   2. The buckets replace the cwd grouping in the drawer, and idle rows drop out.
//   3. Retention: a row that has matched stays listed after its state moves on. On
//      remote this is an EFFECT (the filter lives in a zustand store, so accumulating it
//      during render would be a set() mid-render), and an effect that misfires either
//      loops or never settles — neither shows up in a pure test.
//
// Deliberately lightweight, like browser-remote-mobile-session-actions-e2e.mjs: it
// serves the built web/ bundle over a static server and stubs the relay WebSocket — no
// relay / broker / worker process.

import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";

const ROOT = process.cwd();
const WEB_ROOT = path.join(ROOT, "web");
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);
const RELAY_ID = "relay-e2e";
const THREAD_ID = "thread-bell-needs-input";
const THREAD_ID_2 = "thread-bell-working";
// A third, IDLE row — the bell must drop it, and without one "the bell filtered
// something" is indistinguishable from "the bell rendered everything".
const THREAD_ID_3 = "thread-bell-idle";
const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function main() {
  const server = await startStaticServer({
    rootDir: WEB_ROOT,
    indexFile: "remote.html",
    pathAliases: {
      "/manifest.webmanifest": "remote-manifest.webmanifest",
      "/static/icon.svg": "icon.svg",
      "/static/remote-sw.js": "remote-sw.js",
    },
    stripStaticPrefix: true,
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const { browser, context } = await launchBrowser({
    contextOptions: {
      viewport: MOBILE_VIEWPORT,
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    },
  });
  const page = await context.newPage();
  attachPageDebugLogging(page, "remote", { prefix: "remote-mobile-bell-e2e" });

  try {
    await page.addInitScript(
      ({ relayId, threadId, threadId2, threadId3 }) => {
        const REMOTE_STATE_STORAGE_KEY = "agent-relay.remote-state";
        const REMOTE_STATE_SCHEMA_VERSION = 1;
        const REMOTE_SECRET_DB_NAME = "agent-relay-secrets";
        const REMOTE_SECRET_STORE_NAME = "payload-secrets";
        const REMOTE_SECRET_KEY_STORE_NAME = "secret-keys";
        const relayProfile = {
          relayId,
          relayLabel: "Fake Relay",
          brokerUrl: "ws://fake-broker.test",
          brokerChannelId: "room-e2e",
          relayPeerId: "relay-peer-e2e",
          securityMode: "managed",
          deviceId: "device-e2e",
          deviceLabel: "Browser E2E",
          hasStoredPayloadSecret: true,
          deviceJoinTicket: "device-join-ticket-e2e",
          deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        };
        const threadSummary = {
          id: threadId,
          name: "Alpha session",
          preview: "a preview",
          cwd: "/tmp/e2e-mobile-actions",
          updated_at: 1,
          source: "codex",
          provider: "codex",
          // Idle: a working thread would (correctly) have fork withheld, and this test
          // wants to see the fork entry.
          status: "completed",
          model_provider: "openai",
        };
        const threadSummary2 = {
          ...threadSummary,
          id: threadId2,
          name: "Beta session",
          updated_at: 2,
        };
        const threadSummary3 = {
          ...threadSummary,
          id: threadId3,
          name: "Quiet session",
          updated_at: 3,
        };
        const snapshot = {
          provider: "codex",
          service_ready: true,
          codex_connected: true,
          broker_connected: true,
          broker_channel_id: "room-e2e",
          broker_peer_id: "relay-peer-e2e",
          security_mode: "managed",
          e2ee_enabled: false,
          broker_can_read_content: true,
          audit_enabled: false,
          // The IDLE thread is the viewed one on purpose: attention badges are only set
          // for threads you are NOT looking at (thread-attention.js drops the badge for
          // the viewed foreground thread), so parking the approval on the active thread
          // would produce an empty bell and a test that proves nothing.
          active_thread_id: threadId3,
          active_controller_device_id: "device-e2e",
          active_controller_last_seen_at: Math.floor(Date.now() / 1000),
          controller_lease_expires_at: Math.floor(Date.now() / 1000) + 60,
          controller_lease_seconds: 15,
          // No turn in flight — otherwise the fork entry is withheld by design.
          active_turn_id: null,
          current_status: "idle",
          active_flags: [],
          // What the bell reads. `pending_approvals` → needs_input (attributed by
          // thread_id), `thread_activity` → working. The third thread appears in
          // neither, so it is idle and must not be bucketed at all.
          pending_approvals: [
            { request_id: "approval-bell-e2e", thread_id: threadId, action: "run", data: {} },
          ],
          thread_activity: [{ thread_id: threadId2, phase: "tool", tool: "bash" }],
          current_cwd: "/tmp/e2e-mobile-actions",
          model: "gpt-5.4",
          available_models: [],
          approval_policy: "never",
          sandbox: "workspace-write",
          reasoning_effort: "medium",
          allowed_roots: [],
          device_records: [],
          paired_devices: [],
          pending_pairing_requests: [],
          projects_revision: 1,
          // Drives the sidebar Providers panel: codex ships a mark, `fake` does not, so
          // one row must show a glyph and the other must keep its name.
          provider_status: [
            { provider: "codex", status: "connected", connected: true, display_name: "Codex" },
            { provider: "fake", status: "connected", connected: true, display_name: "Fake" },
          ],
          transcript_truncated: false,
          transcript: [],
          logs: [],
        };
        const projectsPayload = {
          projects_revision: 1,
          projects: [
            { id: "p1", name: "Alpha project" },
            { id: "p2", name: "Beta project" },
          ],
          thread_project_id: { [threadId]: "p1" },
        };

        window.localStorage.setItem(
          REMOTE_STATE_STORAGE_KEY,
          JSON.stringify({
            schemaVersion: REMOTE_STATE_SCHEMA_VERSION,
            activeRelayId: relayId,
            clientAuth: null,
            remoteProfiles: { [relayId]: relayProfile },
          })
        );

        window.__projectActions = [];
        window.__listThreadQueries = [];
        window.__agentRelaySecretReady = false;
        const openRequest = indexedDB.open(REMOTE_SECRET_DB_NAME, 1);
        openRequest.onupgradeneeded = () => {
          const database = openRequest.result;
          if (!database.objectStoreNames.contains(REMOTE_SECRET_STORE_NAME)) {
            database.createObjectStore(REMOTE_SECRET_STORE_NAME, { keyPath: "id" });
          }
          if (!database.objectStoreNames.contains(REMOTE_SECRET_KEY_STORE_NAME)) {
            database.createObjectStore(REMOTE_SECRET_KEY_STORE_NAME, { keyPath: "id" });
          }
        };
        openRequest.onsuccess = () => {
          const database = openRequest.result;
          const tx = database.transaction(REMOTE_SECRET_STORE_NAME, "readwrite");
          tx.objectStore(REMOTE_SECRET_STORE_NAME).put({
            id: relayId,
            kind: "software",
            payloadSecret: "payload-secret-e2e",
          });
          tx.oncomplete = () => {
            window.__agentRelaySecretReady = true;
          };
        };

        class FakeWebSocket extends EventTarget {
          static OPEN = 1;
          constructor(url) {
            super();
            this.url = url;
            this.readyState = FakeWebSocket.OPEN;
            queueMicrotask(() => {
              this.dispatchEvent(new Event("open"));
              this.#emit({
                type: "welcome",
                protocol_version: 1,
                peer_id: "surface-e2e",
                channel_id: "room-e2e",
                peers: [{ peer_id: "relay-peer-e2e", role: "relay" }],
              });
              this.#emit({
                type: "presence",
                kind: "joined",
                peer: { peer_id: "relay-peer-e2e", role: "relay" },
              });
              this.#emit({
                type: "message",
                payload: { protocol_version: 1, kind: "session_snapshot", snapshot },
              });
              // Lets the test move a thread OUT of needs_input the way answering an
              // approval would, by pushing a fresh snapshot — the same channel the real
              // relay uses, so the client path under test is the real one.
              const push = () => {
                this.#emit({
                  type: "message",
                  payload: { protocol_version: 1, kind: "session_snapshot", snapshot },
                });
              };
              // Answering the approval, the way the real relay would: the thread stops
              // needing input and starts WORKING. That intermediate live state is the
              // one a size-only retention guard silently drops.
              window.__answerApproval = () => {
                snapshot.pending_approvals = [];
                snapshot.thread_activity = [
                  { thread_id: threadId, phase: "tool", tool: "bash" },
                  { thread_id: threadId2, phase: "tool", tool: "bash" },
                ];
                push();
              };
              // ...and then it finishes, losing every state it had.
              window.__finishTurn = () => {
                snapshot.thread_activity = [
                  { thread_id: threadId2, phase: "tool", tool: "bash" },
                ];
                push();
              };
            });
          }
          send(raw) {
            const frame = JSON.parse(raw);
            const payload = frame.payload;
            const request = payload?.request || {};
            const actionId = payload?.action_id;
            if (request.type === "heartbeat") {
              this.#respond(actionId, { action: "heartbeat", ok: true, snapshot });
              return;
            }
            if (request.type === "list_threads") {
              const q = request.query?.q;
              window.__listThreadQueries.push(q ?? null);
              const all = [threadSummary, threadSummary2, threadSummary3];
              // Answer a search the way the relay does — matching server-side over the
              // whole set — so the test proves `q` reached the wire and the client
              // rendered the RESPONSE, rather than filtering rows it already had.
              const matched = q
                ? all.filter((t) => (t.name || "").toLowerCase().includes(q.toLowerCase()))
                : all;
              this.#respond(actionId, {
                action: "list_threads",
                ok: true,
                snapshot,
                threads: { threads: matched },
              });
              return;
            }
            if (request.type === "fetch_projects") {
              this.#respond(actionId, {
                action: "fetch_projects",
                ok: true,
                snapshot,
                projects: {
                  projects: [{ id: "project-alpha", name: "Alpha project" }],
                  // Every thread deliberately UNASSIGNED: Projects mode drops the
                  // Unassigned bucket, so this is what makes "the bell reads the
                  // projects-filtered source" visible as an empty bell.
                  thread_project_id: {},
                  projects_revision: 1,
                },
              });
              return;
            }
            if (request.type === "project_action") {
              // Record what the sheet actually put on the wire, so the test can assert
              // the action fired and carried the right thread/project — not merely
              // that a button existed.
              window.__projectActions.push(request.input || null);
              this.#respond(actionId, { action: "project_action", ok: true, snapshot });
              return;
            }
            if (request.type === "fetch_projects") {
              // `fetchRemoteProjects` reads result.projects, and that value IS the
              // payload object — the broker nests it under the same key.
              this.#respond(actionId, {
                action: "fetch_projects",
                ok: true,
                snapshot,
                projects: projectsPayload,
              });
              return;
            }
            if (request.type === "fetch_reviews") {
              this.#respond(actionId, { action: "fetch_reviews", ok: true, snapshot, reviews: { reviews: [] } });
              return;
            }
            if (request.type === "fetch_workflows") {
              this.#respond(actionId, { action: "fetch_workflows", ok: true, snapshot, workflows: { workflows: [] } });
              return;
            }
            if (request.type === "fetch_thread_transcript") {
              this.#respond(actionId, {
                action: "fetch_thread_transcript",
                ok: true,
                snapshot,
                thread_transcript: { thread_id: threadId, entries: [], prev_cursor: null },
              });
            }
          }
          close() {
            this.readyState = 3;
            this.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "closed" }));
          }
          #respond(actionId, result) {
            this.#emit({
              type: "message",
              payload: { protocol_version: 1, kind: "remote_action_result", action_id: actionId, ...result },
            });
          }
          #emit(frame) {
            this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
          }
        }
        window.WebSocket = FakeWebSocket;
      },
      { relayId: RELAY_ID, threadId: THREAD_ID, threadId2: THREAD_ID_2, threadId3: THREAD_ID_3 }
    );

    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });

    // Until the drawer is open the sidebar is measurable but clipped — visible to
    // Playwright, invisible to a user, and translated off-screen so every rect it
    // reports is negative.
    const openDrawer = async () => {
      await page.waitForSelector("#remote-nav-toggle-button", {
        state: "visible",
        timeout: TIMEOUT_MS,
      });
      const open = await page.evaluate(
        () => document.querySelector(".remote-app-shell")?.dataset.remoteNavState === "open"
      );
      if (!open) {
          await page.tap("#remote-nav-toggle-button");
      }
      // Wait for the GEOMETRY, not the attribute: the attribute flips first and the
      // drawer slides in on a transition, so measuring on the attribute reads the
      // sidebar still parked at translateX(-100%).
      await page.waitForFunction(
        () => {
          const shell = document.querySelector(".remote-app-shell");
          const aside = document.querySelector(".remote-app-shell .sidebar");
          if (shell?.dataset.remoteNavState !== "open" || !aside) return false;
          return aside.getBoundingClientRect().left >= 0;
        },
        undefined,
        { timeout: TIMEOUT_MS }
      );
      await page.waitForSelector("#remote-threads-list .conversation-item", {
        timeout: TIMEOUT_MS,
      });
    };

    const rowIds = () =>
      page.$$eval("#remote-threads-list .conversation-item", (els) =>
        els.map((n) => n.dataset.threadId)
      );
    const groupLabels = () =>
      page.$$eval("#remote-threads-list .thread-group-name", (els) =>
        els.map((n) => n.textContent.trim())
      );
    const countLine = () =>
      page.evaluate(() =>
        document.querySelector("#remote-threads-count")?.textContent?.trim() || ""
      );
    const bellOn = () =>
      page.evaluate(() =>
        Boolean(
          document.querySelector("#remote-sidebar-bell-toggle")?.classList.contains("is-active")
        )
      );
    // Never blind-toggle: read the control, then act. A tap that assumed the wrong
    // starting position turns "switch it off" into "switch it on" and the failure lands
    // several assertions later, pointing at the wrong thing.
    const setBell = async (want) => {
      if ((await bellOn()) !== want) {
        await page.tap("#remote-sidebar-bell-toggle");
        await page.waitForFunction(
          (expected) =>
            Boolean(
              document
                .querySelector("#remote-sidebar-bell-toggle")
                ?.classList.contains("is-active")
            ) === expected,
          want,
          { timeout: TIMEOUT_MS }
        );
      }
      assert.equal(await bellOn(), want, `bell should be ${want ? "on" : "off"}`);
    };

    await openDrawer();
    await page.waitForFunction((n) =>
      document.querySelectorAll("#remote-threads-list .conversation-item").length === n,
      3,
      { timeout: TIMEOUT_MS }
    );

    // 1. The bell has to be REACHABLE at 390px. `.sidebar-top-bar` is display:none under
    // 960px and only re-shown for `.remote-app-shell` — a CSS edit could remove the only
    // entry point on a phone while every other test still passed.
    const bellBox = await page.evaluate(() => {
      const button = document.querySelector("#remote-sidebar-bell-toggle");
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        width: rect.width,
        height: rect.height,
        visible: style.display !== "none" && style.visibility !== "hidden",
        insideViewport: rect.right <= window.innerWidth + 1 && rect.left >= -1,
        rect: { left: rect.left, right: rect.right },
        viewport: window.innerWidth,
        navState: document.querySelector(".remote-app-shell")?.dataset.remoteNavState,
        sidebar: (() => {
          const aside = document.querySelector(".remote-app-shell .sidebar");
          const r = aside?.getBoundingClientRect();
          return r ? { left: r.left, right: r.right, width: r.width } : null;
        })(),
      };
    });
    assert.ok(bellBox, "the bell button must exist on the remote surface");
    assert.equal(bellBox.visible, true, "the bell must be visible at mobile width");
    assert.ok(bellBox.width > 0 && bellBox.height > 0, `the bell must be laid out: ${JSON.stringify(bellBox)}`);
    assert.equal(bellBox.insideViewport, true, `the bell must not overflow a 390px drawer: ${JSON.stringify(bellBox)}`);
    assert.equal(await bellOn(), false, "the bell starts off");

    const restingGroups = await groupLabels();
    assert.ok(
      !restingGroups.includes("Needs input"),
      `resting groups should be workspace folders, got ${JSON.stringify(restingGroups)}`
    );

    // 2. Turning it on buckets by state and drops the idle row.
    await setBell(true);
    console.error("after click:", JSON.stringify(await page.evaluate(() => ({
      active: document.querySelector("#remote-sidebar-bell-toggle")?.classList.contains("is-active"),
      pills: document.querySelectorAll("#remote-activity-filter .activity-filter-pill").length,
      groups: [...document.querySelectorAll("#remote-threads-list .thread-group-name")].map((n) => n.textContent.trim()),
      rows: [...document.querySelectorAll("#remote-threads-list .conversation-item")].map((n) => n.dataset.threadId),
    }))));
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#remote-threads-list .thread-group-name")]
          .map((n) => n.textContent.trim())
          .join("|") === "Needs input|Working",
      undefined,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(`bell buckets were ${JSON.stringify(await groupLabels())}`);
    });
    assert.equal(await bellOn(), true);
    const bucketed = await rowIds();
    assert.deepEqual(bucketed, [THREAD_ID, THREAD_ID_2], `bucketed rows: ${JSON.stringify(bucketed)}`);
    assert.ok(!bucketed.includes(THREAD_ID_3), "an idle session has no state and no bucket");

    // The pills must fit the drawer rather than spilling out of it.
    const pills = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("#remote-activity-filter .activity-filter-pill")];
      return nodes.map((n) => {
        const rect = n.getBoundingClientRect();
        return {
          state: n.dataset.state,
          count: n.querySelector("[data-count-for]")?.textContent?.trim(),
          selected: n.classList.contains("is-selected"),
          overflows: rect.right > window.innerWidth + 1,
        };
      });
    });
    assert.equal(pills.length, 4, `four pills: ${JSON.stringify(pills)}`);
    assert.ok(pills.every((pill) => !pill.overflows), `pills must stay inside the drawer: ${JSON.stringify(pills)}`);
    assert.ok(pills.every((pill) => pill.selected), "every state starts selected");
    assert.equal(pills.find((p) => p.state === "needs_input").count, "1");
    assert.equal(pills.find((p) => p.state === "working").count, "1");

    // 3. Narrowing to one state.
    for (const state of ["working", "reviewing", "completed"]) {
      await page.tap(`#remote-activity-filter-${state}`);
    }
    await page.waitForFunction(
      (id) => {
        const rows = [...document.querySelectorAll("#remote-threads-list .conversation-item")];
        return rows.length === 1 && rows[0].dataset.threadId === id;
      },
      THREAD_ID,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(`narrowing left ${JSON.stringify(await rowIds())}`);
    });

    // 4. Retention across the FULL chain: selected state → an unselected live state →
    // stateless. Splitting it (the first draft went straight to stateless) hides the
    // bug where the store-write is guarded on Map size: a row MOVING between states
    // changes only a value, so the write is skipped and the row snaps back to the
    // bucket it started in once it loses its state.
    //
    // This is also the only coverage of the effect that drives retention on remote — if
    // it never settled, the page would spin here instead of asserting.
    await page.evaluate(() => window.__answerApproval?.());
    await page.waitForFunction(
      (id) => {
        const row = document.querySelector(`#remote-threads-list [data-thread-id="${id}"]`);
        const group = row?.closest(".thread-group, [data-thread-list-scroll-root]");
        void group;
        const labels = [...document.querySelectorAll("#remote-threads-list .thread-group-name")]
          .map((n) => n.textContent.trim());
        return Boolean(row) && labels.includes("Working");
      },
      THREAD_ID,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(
        `after answering, groups were ${JSON.stringify(await groupLabels())} rows ${JSON.stringify(await rowIds())}`
      );
    });

    await page.evaluate(() => window.__finishTurn?.());
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#remote-threads-list .thread-group-name")]
          .map((n) => n.textContent.trim())
          .includes("Done"),
      undefined,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(`after finishing, groups were ${JSON.stringify(await groupLabels())}`);
    });

    // Now make it genuinely STATELESS. A finished background thread still carries a
    // `completed` badge; opening it clears that badge (`threadAttention.clear` in
    // handleResumeThread), so the row loses every state it had at the exact moment the
    // user touches it. That is when the remembered bucket is the only thing keeping it
    // on screen — and where a store-write skipped on "same size" shows up, because the
    // memory would still say `needs_input` from three transitions ago.
    await page.tap(`#remote-threads-list [data-thread-id="${THREAD_ID}"]`);
    await page.waitForTimeout(1200);
    await openDrawer();
    const afterOpen = await rowIds();
    assert.ok(
      afterOpen.includes(THREAD_ID),
      `the row you just opened must not vanish, got ${JSON.stringify(afterOpen)}`
    );
    assert.ok(
      !(await groupLabels()).includes("Needs input"),
      `a stateless row must rest in the bucket it was LAST really in, not the one it joined by; groups: ${JSON.stringify(await groupLabels())}`
    );

    // 5. The bell must cut ACROSS Projects mode. Remote's render model drops the
    // Unassigned bucket in that mode, so a session that is WORKING but belongs to no
    // project would be missing from the one control whose job is "show me what is going
    // on" — and while the Projects payload is loading or failed it would be handed
    // nothing at all.
    await setBell(false);
    await page.tap("#remote-threads-view-projects");
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#remote-threads-list .thread-group-name")]
          .map((n) => n.textContent.trim())
          .includes("Alpha project"),
      undefined,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(`projects mode showed ${JSON.stringify(await groupLabels())}`);
    });

    await setBell(true);
    await page.waitForFunction(
      (id) => {
        const rows = [...document.querySelectorAll("#remote-threads-list .conversation-item")];
        const labels = [...document.querySelectorAll("#remote-threads-list .thread-group-name")]
          .map((n) => n.textContent.trim());
        return rows.some((row) => row.dataset.threadId === id) && labels.includes("Working");
      },
      THREAD_ID_2,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(
        `the bell did not take over Projects mode: groups ${JSON.stringify(await groupLabels())} rows ${JSON.stringify(await rowIds())}`
      );
    });
    await setBell(false);
    await page.tap("#remote-threads-view-sessions");
    await page.waitForTimeout(400);

    // 6. Search. The relay-side filter is what makes this worth having on a phone: the
    // list is truncated before it ever reaches the device, so a client-side filter could
    // only ever search the page already on screen.
    await setBell(false);
    await page.tap("#remote-sidebar-search-toggle");
    await page.waitForSelector("#remote-sidebar-search-input", {
      state: "visible",
      timeout: TIMEOUT_MS,
    });
    await page.fill("#remote-sidebar-search-input", "Quiet");
    await page.waitForFunction(
      (id) => {
        const rows = [...document.querySelectorAll("#remote-threads-list .conversation-item")];
        return rows.length === 1 && rows[0].dataset.threadId === id;
      },
      THREAD_ID_3,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(`search left ${JSON.stringify(await rowIds())}`);
    });

    // It must be a RELAY query, not a local filter over the loaded rows.
    const sentQueries = await page.evaluate(() => window.__listThreadQueries);
    assert.ok(
      sentQueries.includes("Quiet"),
      `the query must reach the wire, saw ${JSON.stringify(sentQueries)}`
    );
    assert.match(await countLine(), /result/, `count line: ${await countLine()}`);

    // A search result must stay actionable — its "⋯" resolves through the same union
    // local needed, or the sheet reports no actions and does nothing.
    // The "⋯" is a SIBLING of the row button inside `.conversation-item-wrap`, not a
    // child of it — nesting buttons would be invalid HTML.
    await page.tap(
      `.conversation-item-wrap:has([data-thread-id="${THREAD_ID_3}"]) .conversation-more`
    );
    await page.waitForSelector(".remote-sheet, [role=dialog]", { timeout: TIMEOUT_MS }).catch(() => {});
    const sheetVisible = await page.evaluate(() =>
      Boolean([...document.querySelectorAll("button")].some((b) => /Fork session/.test(b.textContent)))
    );
    assert.equal(sheetVisible, true, "a searched row's actions sheet must open");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Search and the bell compose: the bell narrows whatever the search produced.
    await setBell(true);
    await page.waitForFunction(
      () => document.querySelectorAll("#remote-threads-list .conversation-item").length === 0,
      undefined,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(
        `the idle search hit should be filtered out by the bell, got ${JSON.stringify(await rowIds())}`
      );
    });
    await setBell(false);

    // Closing the field clears the search rather than leaving the list narrowed with the
    // reason off screen.
    await page.tap("#remote-sidebar-search-toggle");
    await page.waitForFunction((n) =>
      document.querySelectorAll("#remote-threads-list .conversation-item").length === n,
      3,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(`closing search left ${JSON.stringify(await rowIds())}`);
    });

    // 7. With the bell off, the resting grouping is back.
    await setBell(false);
    await page.waitForFunction((n) =>
      document.querySelectorAll("#remote-threads-list .conversation-item").length === n,
      3,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(`turning the bell off left ${JSON.stringify(await rowIds())}`);
    });
    assert.equal(await bellOn(), false);
    assert.equal(
      await page.evaluate(() => Boolean(document.querySelector("#remote-activity-filter"))),
      false,
      "the pills go away with the filter"
    );

    console.log("REMOTE_MOBILE_BELL_E2E: PASS");
  } catch (error) {
    console.error("REMOTE_MOBILE_BELL_E2E: FAIL");
    console.error(error);
    await writeFailureArtifacts(page, "remote-mobile-bell-e2e").catch(() => {});
    process.exitCode = 1;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await server?.close?.().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
