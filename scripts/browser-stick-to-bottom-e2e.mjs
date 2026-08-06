// Browser e2e for the transcript's BOTTOM-FOLLOW live scrolling.
//
// The transcript follows the bottom of the stream by default; scrolling up
// escapes; returning to the bottom (or the "scroll to latest" button) re-locks.
// There is NO top-anchor / send-anchor and NO 60vh reserve (both removed) — a
// sent message is not pinned to the top, the reply streams in at the bottom.
//
// Streams a slow fake-provider turn (~9s) and asserts, inside ONE live turn:
//   A. after send, the viewport FOLLOWS the bottom — distance-to-bottom stays ~0
//      (NOT a ~60vh gap, NOT frozen off the bottom).
//   B. a real wheel-up ESCAPES the follow and stays escaped while it streams.
//   C. the "scroll to latest" button RE-LOCKS and follows again.
//   D. at turn end the viewport is at the true bottom.
// Runs on desktop, the same thread past the virtualization threshold, and phone
// (all `.chat-thread` element scrollers now — no window scroller anywhere).
//
// The follower is hand-rolled (frontend/shared/stick-to-bottom.js); this suite is
// its behavioural guard. Run:
//   npm run build && AGENT_PROVIDERS=fake node scripts/browser-stick-to-bottom-e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { prepareSeededCodexHome } from "./e2e-codex-home.mjs";
import { deleteThreadAndWait } from "./e2e-thread-cleanup.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { createFakeProviderScenarioHarness } from "./e2e/harness/fake-provider.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const TIMEOUT_MS = 45000;
const STREAM_PROMPT = "stream-live";
// A turn that parks on an approval request before it streams. Scoped to this one
// prompt via the scenario (not FAKE_PROVIDER_ENFORCE_APPROVALS), so the other
// legs keep running approval-free.
const APPROVAL_PROMPT = "approval-live";
// A turn that parks on a real AskUserQuestion, with an assistant message emitted
// AFTER the question's tool call so the question is NOT the last transcript
// entry — the case where the pin has to do actual work.
const ASK_USER_PROMPT = "ask-user-live";
const ASK_USER_TRAILING = "Meanwhile, here is some context.";
// The turn parks this long before it writes ANYTHING to the transcript (the
// fake provider sleeps first and publishes the question, its trailing message
// and the pending request together under one write lock). That makes the window
// after the send genuinely empty of agent activity — so anything that renders
// in it came from the send itself, which is what the "own message lands"
// assertion below depends on.
const ASK_USER_DELAY_MS = 4000;
// Comfortably inside the park, so the assertion can never be satisfied by the
// question arriving instead of by the send.
const OWN_MESSAGE_VISIBLE_MS = 2500;
// "Following, no gap": distance-to-bottom must stay under this the whole stream.
// It is far below 60vh (~408px @ 680, ~444 @ 740, ~840 @ 1400), so it cleanly
// separates real follow (~0) from either the old 60vh reserve or a frozen
// off-the-bottom viewport (distance climbs into the hundreds).
const FOLLOW_MAX_DISTANCE_PX = 120;
// "Escaped": a real wheel-up must leave us clearly off the bottom and stay there.
const ESCAPE_MIN_DISTANCE_PX = 120;

const LONG_PROMPT = Array.from(
  { length: 24 },
  (_, i) =>
    `Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog while the `
    + `stick-to-bottom follower decides whether to chase the stream.`
).join("\n\n");

// NOTE: the LocalWeb snapshot budget caps a live entry's text at 1600 chars
// (protocol.rs max_transcript_chars) — past that, the streamed text freezes
// until the turn completes. Keep the whole reply under the cap so the live
// window covers all phases: 32 chunks x ~46 chars ≈ 1500 chars over ~9s.
const STREAM_CHUNKS = Array.from(
  { length: 32 },
  (_, i) => `Chunk ${String(i + 1).padStart(2, "0")} keeps the live stream going.\n\n`
);

async function startThread(relayPort, { cwd, deviceId, initialPrompt }) {
  const response = await fetch(`http://127.0.0.1:${relayPort}/api/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd,
      device_id: deviceId,
      initial_prompt: initialPrompt,
      approval_policy: "never",
      sandbox: "workspace-write",
      effort: "medium",
      provider: "fake",
      model: "fake-echo",
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, "thread start should return 200");
  assert.ok(payload?.data?.active_thread_id, "thread id missing");
  return payload.data.active_thread_id;
}

// The transcript is a `.chat-thread` element scroller on every surface now.
function readMetricsInPage() {
  const t = document.querySelector(".chat-thread");
  if (!t) return { scrollTop: 0, clientHeight: 0, scrollHeight: 0, distance: 0 };
  const scrollTop = Math.round(t.scrollTop);
  const distance = Math.max(0, t.scrollHeight - t.clientHeight - scrollTop);
  return { scrollTop, clientHeight: t.clientHeight, scrollHeight: t.scrollHeight, distance: Math.round(distance) };
}

function scrollToBottomInPage() {
  const t = document.querySelector(".chat-thread");
  if (t) t.scrollTop = t.scrollHeight;
}

// A REAL upward wheel over the transcript. Unlike a synthetic WheelEvent + direct
// `scrollTop = …` write (which applies synchronously, leaving no window for a
// streaming follow to interleave), this drives Chromium's real input path: the
// scroll is delivered asynchronously and can race the ResizeObserver pin — which
// is exactly the "can't scroll up while it streams" hazard phase B guards.
async function realWheelUp(page, deltaPx) {
  const x = Math.round(await page.evaluate(() => window.innerWidth / 2));
  const y = Math.round(await page.evaluate(() => window.innerHeight / 2));
  await page.mouse.move(x, y);
  await delay(60); // let the hover/target settle so the wheel actually lands
  await page.mouse.wheel(0, -deltaPx);
}

// A REAL, SLOW upward touch drag over the transcript, via CDP trusted input.
// The finger moves DOWN in many small steps (2-4px each) -> content scrolls UP.
// This is the case a per-move-delta escape heuristic misses (each step is below
// any single-event threshold); bottom-follow must still release.
async function touchDragUp(client, x, startY, steps, stepPx) {
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: startY }],
  });
  let y = startY;
  for (let i = 0; i < steps; i += 1) {
    y += stepPx; // finger DOWN => content scrolls UP
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y }],
    });
    await delay(16);
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

// Length of the streaming reply's DOM text. Grows for every chunk even when the
// row is off-screen and `content-visibility: auto` freezes its layout height —
// so this, not scrollHeight, is the "is the stream still alive" signal.
function readStreamTextLenInPage() {
  const messages = document.querySelectorAll(".chat-thread .chat-message-assistant");
  const last = messages[messages.length - 1];
  return last ? (last.textContent || "").length : 0;
}

async function sample(page, count, everyMs) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const metrics = await page.evaluate(readMetricsInPage);
    metrics.streamTextLen = await page.evaluate(readStreamTextLenInPage);
    out.push(metrics);
    await delay(everyMs);
  }
  return out;
}

const maxOf = (samples, key) => Math.max(...samples.map((s) => s[key]));
const minOf = (samples, key) => Math.min(...samples.map((s) => s[key]));

async function turnInFlight(page) {
  return page.evaluate(() => {
    const stop = document.querySelector(".stop-button");
    return Boolean(stop && !stop.hasAttribute("hidden") && stop.offsetParent !== null);
  });
}

async function waitTurnSettled(page) {
  await page.waitForFunction(
    () => {
      const stop = document.querySelector(".stop-button");
      return !stop || stop.hasAttribute("hidden") || stop.offsetParent === null;
    },
    null,
    { timeout: TIMEOUT_MS }
  );
}

// The stop button briefly hides during the approval -> streaming handover, so a
// DOM-based settle can return while a turn is still in flight — and the next
// send then QUEUES behind it, landing seconds later. Ask the relay instead.
async function waitTurnFullySettled(page) {
  await page.waitForFunction(
    async () => {
      const payload = await fetch("/api/session", { credentials: "same-origin" })
        .then((response) => response.json())
        .catch(() => null);
      return Boolean(payload?.data) && !payload.data.active_turn_id;
    },
    null,
    { timeout: TIMEOUT_MS }
  );
}

async function sendStreamPrompt(page) {
  const preText = await page.evaluate(() => {
    const replies = document.querySelectorAll(".chat-thread .chat-message-assistant");
    return replies[replies.length - 1]?.textContent || "";
  });
  await page.fill("#message-input", STREAM_PROMPT);
  await page.click("#send-button");
  await page.waitForFunction(
    (pre) => {
      const replies = document.querySelectorAll(".chat-thread .chat-message-assistant");
      const text = replies[replies.length - 1]?.textContent || "";
      return text !== pre && text.length > 40;
    },
    preText,
    { timeout: TIMEOUT_MS }
  );
  await delay(200);
}

async function clickScrollToLatest(page) {
  await page.waitForFunction(
    () => document.querySelector(".scroll-to-bottom")?.getAttribute("data-visible") === "true",
    null,
    { timeout: TIMEOUT_MS }
  );
  await page.click(".scroll-to-bottom-button");
  await delay(500);
}

async function exercise(page, label) {
  await page.waitForFunction(
    () => document.querySelectorAll(".chat-thread .chat-message").length > 0,
    null,
    { timeout: TIMEOUT_MS }
  );
  await waitTurnSettled(page);
  await delay(400);
  await page.evaluate(scrollToBottomInPage);
  await delay(200);

  await sendStreamPrompt(page);

  // ---- Phase A: after send the viewport FOLLOWS the bottom (no gap, no freeze).
  const phaseA = await sample(page, 10, 180);
  const maxDistA = maxOf(phaseA, "distance");
  console.log(`[${label}] A distances: ${phaseA.map((s) => s.distance).join(", ")};`,
    `text growth ${phaseA.at(-1).streamTextLen - phaseA[0].streamTextLen}; maxDist ${maxDistA}`);
  assert.ok(
    phaseA.at(-1).streamTextLen - phaseA[0].streamTextLen > 80,
    `${label} A: stream should be growing (${phaseA[0].streamTextLen} -> ${phaseA.at(-1).streamTextLen})`
  );
  assert.ok(
    maxDistA <= FOLLOW_MAX_DISTANCE_PX,
    `${label} A: after send the viewport must FOLLOW the bottom — no 60vh gap, no `
    + `freeze (distances: ${phaseA.map((s) => s.distance).join(", ")})`
  );
  assert.ok(
    phaseA.at(-1).scrollTop >= phaseA[0].scrollTop,
    `${label} A: following must ride the growing bottom DOWN, never yank up `
    + `(scrollTops: ${phaseA.map((s) => s.scrollTop).join(", ")})`
  );

  // ---- Phase B: a REAL upward wheel mid-stream escapes the follow at once.
  // Retry the wheel: after a virtualized reload the first synthetic wheel can be
  // dropped by Chromium before it registers a scroll (a Playwright input quirk,
  // not the follower). We re-read the baseline each attempt so stream growth
  // while following doesn't confuse the "moved up" check.
  let beforeWheelTop = 0;
  let afterWheelTop = 0;
  let wheelEscaped = false;
  for (let attempt = 0; attempt < 3 && !wheelEscaped; attempt += 1) {
    beforeWheelTop = (await page.evaluate(readMetricsInPage)).scrollTop;
    await realWheelUp(page, 800);
    await delay(400); // let the async scroll settle before sampling
    afterWheelTop = (await page.evaluate(readMetricsInPage)).scrollTop;
    wheelEscaped = afterWheelTop < beforeWheelTop - 40;
  }
  assert.ok(
    wheelEscaped,
    `${label} B: a real wheel-up must move the viewport UP (before ${beforeWheelTop}, `
    + `after ${afterWheelTop}); the stream must not snap it back to the bottom`
  );
  // Confirm we escaped MID-stream (not at turn end). The text-growth probe can't
  // be used here: escaped far up a virtualized list, the streaming row is
  // rendered OUT of the DOM, so its growth is invisible from the reader's
  // scrolled-up position — which is fine. The turn being in flight is the signal.
  assert.ok(
    await turnInFlight(page),
    `${label} B: the turn must still be streaming while we test the escape`
  );
  const phaseB = await sample(page, 8, 150);
  const minDistB = minOf(phaseB, "distance");
  console.log(`[${label}] B distances: ${phaseB.map((s) => s.distance).join(", ")}; minDist ${minDistB}`);
  assert.ok(
    minDistB > ESCAPE_MIN_DISTANCE_PX,
    `${label} B: a real wheel-up must escape and STAY escaped — the stream must not `
    + `snap the reader back to the bottom (distances: ${phaseB.map((s) => s.distance).join(", ")})`
  );

  // ---- Phase C: the "scroll to latest" button re-locks and follows again.
  await clickScrollToLatest(page);
  const phaseC = await sample(page, 8, 150);
  const maxDistC = maxOf(phaseC, "distance");
  console.log(`[${label}] C distances: ${phaseC.map((s) => s.distance).join(", ")}; maxDist ${maxDistC}`);
  assert.ok(
    maxDistC <= FOLLOW_MAX_DISTANCE_PX,
    `${label} C: scroll-to-latest must re-lock and follow the bottom `
    + `(distances: ${phaseC.map((s) => s.distance).join(", ")})`
  );

  // ---- Phase D: let the turn end -> we are at the true bottom.
  await waitTurnSettled(page);
  await delay(600);
  const final = await page.evaluate(readMetricsInPage);
  console.log(`[${label}] D final distance ${final.distance}`);
  assert.ok(
    final.distance <= FOLLOW_MAX_DISTANCE_PX,
    `${label} D: turn end must land at the true bottom (distance ${final.distance})`
  );
  return { final };
}

// When the agent blocks on the reader, the request must be ON SCREEN — and then
// the reader must still be free to leave it.
//
// The approval card is pushed LAST in the transcript but is not a transcript
// entry (no item_id, never in the hydration window), so before
// `decideTranscriptScrollAction` learned about pending requests, nothing brought
// it into view: the session looked hung with the approval below the fold. The
// fix emits a fire-once `input-required` action.
//
// The leg drives the ordering that actually reproduces the bug: send, let the
// send's own jump-bottom settle, scroll UP, and only THEN let the request arrive
// (the scenario delays it). Without the trigger the reader stays parked in
// history and never sees it.
//
// Then the converse, which matters just as much: firing on EVERY render rather
// than once per request_id would make it impossible to scroll up and re-read the
// command you are being asked to approve — the exact class of regression this
// whole architecture exists to prevent.
//
// Runs against the virtualized thread on purpose: the card is the last virtual
// row and `estimateTranscriptRowSize` guesses 140/180px for a card that is much
// taller, so a bottom computed from `getTotalSize()` lands short until the row
// is measured.
async function exerciseApprovalVisibility(page, label) {
  await waitTurnFullySettled(page);
  await page.evaluate(scrollToBottomInPage);
  await delay(200);

  await page.fill("#message-input", APPROVAL_PROMPT);
  await page.click("#send-button");
  // Wait for the SEND to land and settle first: that fires jump-bottom and leaves
  // the follower stuck at the bottom. Only then escape upward. The scenario holds
  // the approval back (`approval_delay_ms`) so this ordering is deterministic —
  // otherwise the request arrives in the same beat as the user message and the
  // send's own jump-bottom would satisfy the assertion below on its own.
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll(".chat-thread .chat-message-user")].some((node) =>
        (node.textContent || "").includes(text)
      ),
    APPROVAL_PROMPT,
    { timeout: TIMEOUT_MS }
  );
  await delay(300);

  let leftBottom = false;
  let preTop = 0;
  let postTop = 0;
  for (let attempt = 0; attempt < 3 && !leftBottom; attempt += 1) {
    preTop = (await page.evaluate(readMetricsInPage)).scrollTop;
    await realWheelUp(page, 900);
    await delay(300);
    postTop = (await page.evaluate(readMetricsInPage)).scrollTop;
    leftBottom = postTop < preTop - 40;
  }
  assert.ok(
    leftBottom,
    `${label}: precondition — the reader must be scrolled UP before the request `
    + `arrives (before ${preTop}, after ${postTop})`
  );
  assert.ok(
    !(await page.$("[data-approval-id]")),
    `${label}: precondition — the approval must not have arrived yet`
  );

  await page.waitForSelector("[data-approval-id]", { timeout: TIMEOUT_MS });
  await delay(700); // let the card measure + the follow settle on its real height

  const placement = await page.evaluate(() => {
    const card = document.querySelector("[data-approval-id]");
    const scroller = document.querySelector(".chat-thread");
    if (!card || !scroller) return null;
    const c = card.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    return {
      cardTop: Math.round(c.top),
      cardBottom: Math.round(c.bottom),
      viewTop: Math.round(s.top),
      viewBottom: Math.round(s.bottom),
      distance: Math.round(
        Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)
      ),
    };
  });
  assert.ok(placement, `${label}: approval card and scroller must both exist`);
  console.log(`[${label}] approval placement ${JSON.stringify(placement)}`);
  // Geometry, never DOM child index: past the virtualization threshold rows are
  // absolutely positioned, so DOM order and visual order are different things.
  assert.ok(
    placement.cardTop < placement.viewBottom && placement.cardBottom > placement.viewTop,
    `${label}: the approval card must be within the transcript viewport `
    + `(card ${placement.cardTop}-${placement.cardBottom}, view ${placement.viewTop}-${placement.viewBottom})`
  );
  assert.ok(
    placement.distance <= FOLLOW_MAX_DISTANCE_PX,
    `${label}: an arriving approval must bring the transcript to the bottom `
    + `(distance ${placement.distance})`
  );

  // The reader escapes upward while the SAME approval stays pending. The relay
  // keeps notifying throughout, so this samples many renders — every one of them
  // a chance for a mis-scoped trigger to yank the reader back down.
  let escaped = false;
  let beforeTop = 0;
  let afterTop = 0;
  for (let attempt = 0; attempt < 3 && !escaped; attempt += 1) {
    beforeTop = (await page.evaluate(readMetricsInPage)).scrollTop;
    await realWheelUp(page, 800);
    await delay(400);
    afterTop = (await page.evaluate(readMetricsInPage)).scrollTop;
    escaped = afterTop < beforeTop - 40;
  }
  assert.ok(
    escaped,
    `${label}: the reader must be able to scroll up while an approval is pending `
    + `(before ${beforeTop}, after ${afterTop})`
  );
  const samples = await sample(page, 10, 200);
  const minDist = minOf(samples, "distance");
  console.log(`[${label}] escaped distances: ${samples.map((s) => s.distance).join(", ")}; min ${minDist}`);
  assert.ok(
    minDist > ESCAPE_MIN_DISTANCE_PX,
    `${label}: input-required must fire ONCE per request — a pending approval must `
    + `not re-yank a reader who scrolled up (distances: ${samples.map((s) => s.distance).join(", ")})`
  );

  // Release the turn so the leg leaves the thread idle for cleanup.
  await page.evaluate(() => {
    document.querySelector('[data-approval-decision="approve"]')?.click();
  });
  await waitTurnSettled(page);
  return "pass";
}

// An UNANSWERED question must be the last thing in the transcript, exactly once,
// and must drop back into place once answered.
//
// The scenario emits an assistant message AFTER the question's tool call, so the
// question's natural position is NOT the bottom — a real shape, because a turn
// can issue AskUserQuestion alongside other tool uses. Without the pin the
// question renders buried above that message; with it, it is moved (not copied)
// to the bottom while pending, and returns to its original position on answer.
//
// Scroll coverage here is deliberately the SECOND half only — the reader escapes
// AFTER the question lands, and must then be left alone (fire-once). The first
// half ("escaped reader, request arrives, gets brought into view") is covered by
// the approval leg above, which exercises the very same `input-required` action;
// duplicating it here would only re-test shared code.
//
// The parked window is also where this leg guards a fixed bug: with the turn
// held back by `ask_user_delay_ms`, the browser used to render NOTHING between
// the send and the next transcript change — including the user's own message.
// The relay builds the `/api/session/message` response snapshot BEFORE it
// appends the user message, so that response reliably resolved a few ms after
// the SSE frame that carried the message and reverted the render. Fixed by
// `transcriptIsPreWrite` in frontend/local/session/lifecycle.js (unit-covered in
// frontend/local/session/send-snapshot-clobber.test.mjs); this is the end-to-end
// half, and the only layer that would catch the relay ceasing to push the
// post-append snapshot at all.
async function exerciseAskUserPin(page, label) {
  await waitTurnFullySettled(page);
  await page.evaluate(scrollToBottomInPage);
  await delay(200);

  await page.fill("#message-input", ASK_USER_PROMPT);
  await page.click("#send-button");

  // Nothing agent-side can write to the transcript for ASK_USER_DELAY_MS, so
  // this can only pass because the send itself rendered.
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll(".chat-thread .chat-message-user")].some((node) =>
        (node.textContent || "").includes(text)
      ),
    ASK_USER_PROMPT,
    { timeout: OWN_MESSAGE_VISIBLE_MS }
  );
  console.log(`[${label}] own message rendered while the turn was still parked`);
  // The question and its trailing message become visible together (the relay
  // publishes both under one write lock), so either selector implies both.
  await page.waitForSelector(".chat-message-ask-user-interactive", { timeout: TIMEOUT_MS });
  await page.waitForFunction(
    (needle) => (document.querySelector(".chat-thread")?.textContent || "").includes(needle),
    ASK_USER_TRAILING,
    { timeout: TIMEOUT_MS }
  );
  await delay(700);

  const pinned = await page.evaluate((needle) => {
    const scroller = document.querySelector(".chat-thread");
    const card = document.querySelector(".chat-message-ask-user");
    const trailing = [...document.querySelectorAll(".chat-thread .chat-message")].find((node) =>
      (node.textContent || "").includes(needle)
    );
    if (!scroller || !card || !trailing) return null;
    const c = card.getBoundingClientRect();
    const t = trailing.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    return {
      cards: document.querySelectorAll(".chat-message-ask-user").length,
      cardTop: Math.round(c.top),
      cardBottom: Math.round(c.bottom),
      trailingTop: Math.round(t.top),
      viewTop: Math.round(s.top),
      viewBottom: Math.round(s.bottom),
      distance: Math.round(
        Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)
      ),
    };
  }, ASK_USER_TRAILING);
  assert.ok(pinned, `${label}: question card, trailing message and scroller must all exist`);
  console.log(`[${label}] pinned ${JSON.stringify(pinned)}`);

  // MOVED, not copied: two live question dialogs must never be on screen.
  assert.equal(pinned.cards, 1, `${label}: the question must render exactly once`);
  // Geometry, never DOM index — above the virtualization threshold rows are
  // absolutely positioned, so DOM order and visual order are different things.
  assert.ok(
    pinned.cardTop > pinned.trailingTop,
    `${label}: an unanswered question must be pinned BELOW the message that follows `
    + `its tool call (card ${pinned.cardTop}, trailing ${pinned.trailingTop})`
  );
  assert.ok(
    pinned.cardTop < pinned.viewBottom && pinned.cardBottom > pinned.viewTop,
    `${label}: the pinned question must be within the viewport `
    + `(card ${pinned.cardTop}-${pinned.cardBottom}, view ${pinned.viewTop}-${pinned.viewBottom})`
  );

  // The reader may still leave, and must be left alone while it stays pending.
  let escaped = false;
  let beforeTop = 0;
  let afterTop = 0;
  for (let attempt = 0; attempt < 3 && !escaped; attempt += 1) {
    beforeTop = (await page.evaluate(readMetricsInPage)).scrollTop;
    await realWheelUp(page, 800);
    await delay(400);
    afterTop = (await page.evaluate(readMetricsInPage)).scrollTop;
    escaped = afterTop < beforeTop - 40;
  }
  assert.ok(
    escaped,
    `${label}: the reader must be able to scroll up while a question is pending `
    + `(before ${beforeTop}, after ${afterTop})`
  );
  const samples = await sample(page, 8, 200);
  const minDist = minOf(samples, "distance");
  console.log(`[${label}] escaped distances: ${samples.map((s) => s.distance).join(", ")}; min ${minDist}`);
  assert.ok(
    minDist > ESCAPE_MIN_DISTANCE_PX,
    `${label}: a pending question must fire once, not re-yank the reader `
    + `(distances: ${samples.map((s) => s.distance).join(", ")})`
  );

  // Answer it (single-select quick path: one option click submits).
  await page.click(".chat-message-ask-user-interactive .ask-user-option-button");
  await page.waitForFunction(
    () => !document.querySelector(".chat-message-ask-user-interactive"),
    null,
    { timeout: TIMEOUT_MS }
  );
  await waitTurnSettled(page);
  await page.evaluate(scrollToBottomInPage);
  await delay(600);

  const unpinned = await page.evaluate((needle) => {
    const card = document.querySelector(".chat-message-ask-user");
    const trailing = [...document.querySelectorAll(".chat-thread .chat-message")].find((node) =>
      (node.textContent || "").includes(needle)
    );
    if (!card || !trailing) return null;
    return {
      cards: document.querySelectorAll(".chat-message-ask-user").length,
      cardTop: Math.round(card.getBoundingClientRect().top),
      trailingTop: Math.round(trailing.getBoundingClientRect().top),
    };
  }, ASK_USER_TRAILING);
  assert.ok(unpinned, `${label}: the answered question must still be in the transcript`);
  console.log(`[${label}] unpinned ${JSON.stringify(unpinned)}`);
  assert.equal(unpinned.cards, 1, `${label}: still exactly one question card after answering`);
  assert.ok(
    unpinned.cardTop < unpinned.trailingTop,
    `${label}: an answered question returns to its ORIGINAL position, above the `
    + `message that followed it (card ${unpinned.cardTop}, trailing ${unpinned.trailingTop})`
  );
  return "pass";
}

// A SLOW touch drag (real trusted touch input, many 3px moves) must escape the
// follow — the regression a per-move-delta heuristic missed. Runs on the phone
// leg where touch is the primary input.
async function exerciseTouchEscape(page, label) {
  const client = await page.context().newCDPSession(page);
  try {
    await page.evaluate(scrollToBottomInPage);
    await delay(200);
    await sendStreamPrompt(page);
    const before = await sample(page, 4, 150);
    assert.ok(
      maxOf(before, "distance") <= FOLLOW_MAX_DISTANCE_PX,
      `${label} touch: must be following before the drag (distances: ${before.map((s) => s.distance).join(", ")})`
    );
    assert.ok(await turnInFlight(page), `${label} touch: turn must still be streaming`);

    const x = Math.round(await page.evaluate(() => window.innerWidth / 2));
    const startY = Math.round(await page.evaluate(() => window.innerHeight / 2));
    await touchDragUp(client, x, startY, 50, 3); // ~150px in 3px steps
    await delay(400);

    const after = await sample(page, 6, 150);
    const minDist = minOf(after, "distance");
    console.log(`[${label}] touch-escape distances: ${after.map((s) => s.distance).join(", ")}; minDist ${minDist}`);
    assert.ok(
      minDist > ESCAPE_MIN_DISTANCE_PX,
      `${label} touch: a slow touch drag up must escape and STAY escaped — the stream `
      + `must not snap the reader back (distances: ${after.map((s) => s.distance).join(", ")})`
    );

    // The scroll-to-latest button is visible now (we are escaped). On the narrow
    // local layout it must float ABOVE the docked composer, not sit inside it.
    const overlap = await page.evaluate(() => {
      const btn = document.querySelector(".scroll-to-bottom-button");
      const input = document.querySelector("#message-input");
      if (!btn || !input) return { ok: false, reason: "button or input missing" };
      const b = btn.getBoundingClientRect();
      const c = input.getBoundingClientRect();
      const intersects = !(b.right <= c.left || b.left >= c.right || b.bottom <= c.top || b.top >= c.bottom);
      return { ok: !intersects, button: { top: b.top, bottom: b.bottom }, input: { top: c.top, bottom: c.bottom } };
    });
    assert.ok(
      overlap.ok,
      `${label} touch: the scroll-to-latest button must not overlap the composer input `
      + `(${JSON.stringify(overlap)})`
    );

    await clickScrollToLatest(page);
    const rejoined = await sample(page, 4, 150);
    assert.ok(
      maxOf(rejoined, "distance") <= FOLLOW_MAX_DISTANCE_PX,
      `${label} touch: scroll-to-latest must re-lock (distances: ${rejoined.map((s) => s.distance).join(", ")})`
    );
    await waitTurnSettled(page);
  } finally {
    await client.detach().catch(() => {});
  }
}

// The FIRST prompt into an EMPTY thread must behave like every later send: land
// at the bottom and FOLLOW the reply (bottom-follow), not pin the message to the
// top. Regression shape: the empty render records no scroll snapshot, or the
// follower's listener attaches too late to hear the jump-bottom broadcast.
async function exerciseEmptyFirstSend(page, label, workspaceDir) {
  await page.click("#open-start-session-dialog");
  await page.waitForFunction(
    () => document.querySelector("#launch-start-session-dialog")?.open,
    null,
    { timeout: TIMEOUT_MS }
  );
  await page.fill("#cwd-input", workspaceDir);
  await page.selectOption("#provider-input", "fake");
  await page.selectOption("#approval-policy-input", "never");
  await page.click("#start-session-button");
  await page.waitForFunction(
    () => (document.querySelector("#transcript")?.textContent || "").includes("Session ready"),
    null,
    { timeout: TIMEOUT_MS }
  );

  await sendStreamPrompt(page);
  const samples = await sample(page, 10, 180);
  const maxDist = maxOf(samples, "distance");
  console.log(`[${label}] first-send distances: ${samples.map((s) => s.distance).join(", ")};`,
    `text growth ${samples.at(-1).streamTextLen - samples[0].streamTextLen}; maxDist ${maxDist}`);
  assert.ok(
    samples.at(-1).streamTextLen - samples[0].streamTextLen > 80,
    `${label}: stream should be growing`
  );
  assert.ok(
    maxDist <= FOLLOW_MAX_DISTANCE_PX,
    `${label}: the FIRST send must land at the bottom and FOLLOW the stream `
    + `(distances: ${samples.map((s) => s.distance).join(", ")})`
  );

  await waitTurnSettled(page);
  return page.evaluate(async () =>
    (await fetch("/api/session", { credentials: "same-origin" }).then((r) => r.json()))
      ?.data?.active_thread_id || null);
}

// Grow the thread past the 20-row virtualization threshold with quick echo turns,
// so the streaming phases also run against the TanStack virtualizer (whose
// multi-frame measurement corrections must not un-stick the follow).
async function growUntilVirtualized(page) {
  for (let i = 0; i < 12; i += 1) {
    await page.fill("#message-input", `filler ${i + 1}`);
    await page.click("#send-button");
    await waitTurnSettled(page);
    await delay(120);
  }
}

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "stick-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const codexHomeDir = await prepareSeededCodexHome("stick-e2e-codex-", { requireAuth: false });
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "stick-e2e-workspace-"))
  );
  const scenario = await createFakeProviderScenarioHarness(stateDir, {
    prompts: {
      [STREAM_PROMPT]: {
        chunks: STREAM_CHUNKS,
        chunk_delay_ms: 280,
      },
      [ASK_USER_PROMPT]: {
        chunks: STREAM_CHUNKS,
        chunk_delay_ms: 280,
        ask_user: true,
        ask_user_trailing_text: ASK_USER_TRAILING,
        // Holds the whole turn back so the leg can assert the user's own
        // message renders on the strength of the send alone. See
        // ASK_USER_DELAY_MS.
        ask_user_delay_ms: ASK_USER_DELAY_MS,
      },
      [APPROVAL_PROMPT]: {
        chunks: STREAM_CHUNKS,
        chunk_delay_ms: 280,
        require_approval: true,
        // Long enough for the leg to observe the send settle and then scroll up
        // before the request appears — the ordering the assertion depends on.
        approval_delay_ms: 3500,
      },
    },
  });

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    codexHomeDir,
    extraEnv: { AGENT_PROVIDERS: "fake", ...scenario.env },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let desktop;
  let phone;
  const threadIds = [];
  const results = {};
  try {
    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 680 } },
    }));

    const bootstrap = await context.newPage();
    await bootstrap.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await bootstrap.waitForFunction(
      () => Boolean(window.localStorage.getItem("agent-relay.device-id")),
      null,
      { timeout: TIMEOUT_MS }
    );
    const deviceId = await bootstrap.evaluate(() =>
      window.localStorage.getItem("agent-relay.device-id")
    );
    await bootstrap.close();

    // Empty thread, first-ever send.
    let fresh = await context.newPage();
    attachPageDebugLogging(fresh, "empty-first-send", { prefix: "stick-e2e" });
    await fresh.setViewportSize({ width: 1280, height: 680 });
    await fresh.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    const freshThread = await exerciseEmptyFirstSend(fresh, "empty-first-send", workspaceDir);
    if (freshThread) threadIds.push(freshThread);
    await fresh.close();
    fresh = null;
    results.emptyFirstSend = "pass";

    // Desktop.
    const desktopThread = await startThread(relayPort, {
      cwd: workspaceDir,
      deviceId,
      initialPrompt: LONG_PROMPT,
    });
    threadIds.push(desktopThread);
    desktop = await context.newPage();
    attachPageDebugLogging(desktop, "desktop", { prefix: "stick-e2e" });
    await desktop.setViewportSize({ width: 1280, height: 680 });
    await desktop.goto(`http://127.0.0.1:${relayPort}/?thread=${desktopThread}`, {
      waitUntil: "domcontentloaded",
    });
    await desktop.waitForFunction(
      () => document.querySelector(".chat-shell")?.dataset.view === "conversation",
      null,
      { timeout: TIMEOUT_MS }
    );
    results.desktop = await exercise(desktop, "desktop");

    // Same thread past the virtualization threshold.
    await growUntilVirtualized(desktop);
    await desktop.setViewportSize({ width: 1280, height: 1400 });
    await desktop.reload({ waitUntil: "domcontentloaded" });
    await desktop.waitForFunction(
      () => document.querySelector(".chat-shell")?.dataset.view === "conversation",
      null,
      { timeout: TIMEOUT_MS }
    );
    await desktop.waitForFunction(
      () => Boolean(document.querySelector(".thread-content-virtualized")),
      null,
      { timeout: TIMEOUT_MS }
    );
    results.desktopVirtualized = await exercise(desktop, "desktop-virtualized");
    results.approvalVisibility = await exerciseApprovalVisibility(
      desktop,
      "desktop-virtualized-approval"
    );
    results.askUserPin = await exerciseAskUserPin(desktop, "desktop-virtualized-ask-user");
    await desktop.close();
    desktop = null;

    // Phone: narrow local conversation layout, also a `.chat-thread` element
    // scroller. (STICK_E2E_SKIP_PHONE=1 skips it for a faster desktop-only run.)
    if (process.env.STICK_E2E_SKIP_PHONE === "1") {
      results.phone = "skipped";
      console.log("\nPASS", JSON.stringify(results, null, 2));
      return;
    }
    const phoneThread = await startThread(relayPort, {
      cwd: workspaceDir,
      deviceId,
      initialPrompt: LONG_PROMPT,
    });
    threadIds.push(phoneThread);
    phone = await context.newPage();
    attachPageDebugLogging(phone, "phone", { prefix: "stick-e2e" });
    await phone.setViewportSize({ width: 390, height: 740 });
    await phone.goto(`http://127.0.0.1:${relayPort}/?thread=${phoneThread}`, {
      waitUntil: "domcontentloaded",
    });
    await phone.waitForFunction(
      () => document.querySelector(".chat-shell")?.dataset.view === "conversation",
      null,
      { timeout: TIMEOUT_MS }
    );
    results.phone = await exercise(phone, "phone");
    // Real slow touch-drag escape (the wheel legs above cannot exercise touch).
    await exerciseTouchEscape(phone, "phone-touch");
    results.phoneTouch = "pass";
    await phone.close();
    phone = null;

    console.log("\nPASS", JSON.stringify(results, null, 2));
  } catch (error) {
    console.error(error);
    await writeFailureArtifacts({
      scenario: "stick-to-bottom-e2e",
      relay,
      relayPort,
      localPage: desktop || phone,
      extraPages: [],
      metadata: { relayPort, workspaceDir, threadIds },
    }).catch((artifactError) => {
      console.error(`[e2e-artifacts] failed: ${artifactError.message}`);
    });
    dumpProcessLogs(relay);
    process.exitCode = 1;
  } finally {
    for (const id of threadIds) {
      await deleteThreadAndWait(relayPort, id, { cwd: workspaceDir }).catch(() => {});
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(codexHomeDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

main();
