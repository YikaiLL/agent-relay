import assert from "node:assert/strict";
import test from "node:test";

import {
  createStreamController,
  __readTranscriptFullRebuildCount,
  __resetTranscriptFullRebuildCount,
} from "./session/stream.js";
import { adoptSettledTranscript, settleTranscriptProjection } from "./transcript/store.js";
import {
  cancelAndSettlePendingTranscriptFlush,
  resolveDirectRenderSession,
} from "./session/render-session-flush.js";
import {
  createTranscriptFlushScheduler,
  TRANSCRIPT_FLUSH_CHAR_THRESHOLD,
  TRANSCRIPT_FLUSH_MAX_WINDOW_MS,
  TRANSCRIPT_FLUSH_MIN_WINDOW_MS,
} from "../shared/transcript-flush-scheduler.js";

/**
 * A minimal fake clock: `tick` advances time and fires due timers (in due
 * order). Mirrors the harness in shared/transcript-flush-scheduler.test.mjs.
 */
function createManualClock(startTime = 0) {
  let currentTime = startTime;
  const timers = new Map();
  let nextId = 0;
  return {
    now: () => currentTime,
    setTimer(callback, delayMs) {
      const id = ++nextId;
      timers.set(id, { callback, dueAt: currentTime + delayMs });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    tick(ms) {
      currentTime += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= currentTime)
          .sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
        if (!due) {
          break;
        }
        const [id, timer] = due;
        timers.delete(id);
        timer.callback();
      }
    },
    pendingTimerCount: () => timers.size,
  };
}

function makeController({ ensureConversationTranscript } = {}) {
  const renders = [];
  const clock = createManualClock();
  const state = {
    session: {
      active_thread_id: "thread-1",
      transcript: [
        {
          item_id: "agent-1",
          kind: "agent_text",
          status: "running",
          text: "",
          tool: null,
          turn_id: "turn-1",
        },
      ],
      transcript_revision: 0,
    },
  };
  function baseRenderSession(session) {
    renders.push(session);
  }
  // Late-bound: the scheduler and the wrapper below are constructed before
  // the controller they flush through exists (same seam as
  // session-controller.js's real wiring).
  let controller;
  // Mirrors session-controller.js's ctx.renderSession: the ONE choke point
  // every render — the scheduler's own flush AND stream.js's own direct
  // render calls (session_meta_updated, approvals, the stream-disconnect
  // notice) alike — goes through, which is what makes
  // settleTranscriptProjection() reliable no matter which path triggered the
  // render.
  function renderSessionAndClearPendingFlush(session) {
    const settled = cancelAndSettlePendingTranscriptFlush(transcriptFlushScheduler, state);
    return baseRenderSession(adoptSettledTranscript(state, session, settled));
  }
  const transcriptFlushScheduler = createTranscriptFlushScheduler({
    render: () => {
      if (state.session) {
        renderSessionAndClearPendingFlush(state.session);
      }
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => false,
  });
  controller = createStreamController({
    applySessionSnapshot() {},
    cancelSessionPoll() {},
    cancelStreamReconnect() {},
    ensureConversationTranscript,
    handleUnauthorized() {},
    logLine() {},
    renderSession: renderSessionAndClearPendingFlush,
    scheduleSessionPoll() {},
    scheduleStreamReconnect() {},
    seedDefaults() {},
    state,
    transcriptFlushScheduler,
  });

  // The SAME function session-controller.js's exposed cancelPendingTranscriptFlush
  // calls — app.js's `renderer.renderSession` wrap (frontend/app.js:1191) calls
  // that BEFORE painting `state.session` directly, bypassing
  // renderSessionAndClearPendingFlush/ctx.renderSession entirely. Must settle
  // as well as cancel, or that direct paint sees the stale pre-projection array.
  function cancelPendingTranscriptFlush() {
    return cancelAndSettlePendingTranscriptFlush(transcriptFlushScheduler, state);
  }

  // Mirrors render-session.js's OWN renderSession after the P1 fix: it calls
  // cancelPendingTranscriptFlush itself, so callbacks defined in the SAME
  // closure that invoke it directly — never through renderSessionAndClearPendingFlush,
  // never through app.js's wrap — still cancel a pending flush instead of
  // leaving it to double-render later.
  function renderSessionBase(session) {
    const settled = cancelPendingTranscriptFlush();
    return baseRenderSession(adoptSettledTranscript(state, session, settled));
  }

  return {
    clock,
    controller,
    renders,
    state,
    transcriptFlushScheduler,
    cancelPendingTranscriptFlush,
    renderSessionBase,
  };
}

test("live transcript deltas update state immediately but render once per window", () => {
  const { clock, controller, renders, state, transcriptFlushScheduler } = makeController();

  controller.applyLocalTranscriptEntryDelta({
    delta: "one",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  controller.applyLocalTranscriptEntryDelta({
    delta: " two",
    item_id: "agent-1",
    revision: 2,
    thread_id: "thread-1",
  });
  controller.applyLocalTranscriptEntryDelta({
    delta: " three",
    item_id: "agent-1",
    revision: 3,
    thread_id: "thread-1",
  });

  assert.equal(state.session.transcript[0].text, "one two three");
  assert.equal(state.session.transcript_revision, 3);
  assert.equal(renders.length, 0);
  assert.equal(transcriptFlushScheduler.stats().pending, true);

  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  assert.equal(renders.length, 1);
  assert.equal(renders[0].transcript[0].text, "one two three");
});

test("a later window schedules another render without losing prior text", () => {
  const { clock, controller, renders, state } = makeController();

  controller.applyLocalTranscriptEntryDelta({
    delta: "first",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  controller.applyLocalTranscriptEntryDelta({
    delta: " second",
    item_id: "agent-1",
    revision: 2,
    thread_id: "thread-1",
  });

  assert.equal(clock.pendingTimerCount(), 1);
  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
  assert.equal(renders.length, 2);
  assert.equal(state.session.transcript[0].text, "first second");
});

test("a large-chunk delta flushes early via note(), without waiting out the window", () => {
  const { clock, controller, renders } = makeController();

  controller.applyLocalTranscriptEntryDelta({
    delta: "x".repeat(TRANSCRIPT_FLUSH_CHAR_THRESHOLD),
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });

  assert.equal(
    renders.length,
    1,
    "a single chunk at the char threshold must render immediately, not coalesce for the full window"
  );

  // The window this flush brought forward must not also fire on its own.
  clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
  assert.equal(renders.length, 1);
});

test("transcript_stream_lagged brings a pending render forward instead of leaving it to coalesce", () => {
  const { clock, controller, renders, transcriptFlushScheduler } = makeController();

  controller.applyLocalTranscriptEntryDelta({
    delta: "partial",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  assert.equal(renders.length, 0, "the delta must still be coalescing");

  controller.applySessionStreamEvent("transcript_stream_lagged", { dropped: 3 });

  assert.equal(
    renders.length,
    1,
    "a lagged-stream notice must flush immediately, per the scheduler's immediate-event contract"
  );
  assert.equal(
    transcriptFlushScheduler.stats().pending,
    false,
    "the delta's window timer must be absorbed by the immediate flush, not left to fire again"
  );

  clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
  assert.equal(renders.length, 1, "the absorbed window timer must not render a second time");
});

// P1 (review): a terminal entry patch used to end at the same coalescing
// queueTranscriptRender() as an ordinary streaming delta, so a completion /
// failure / error / cancellation sat behind the 100-300ms window instead of
// painting at once — the only signal local gets that a turn just went idle
// for an entry with no dedicated snapshot turn-state change of its own.
test("a completed entry patch flushes immediately instead of coalescing", () => {
  const { clock, controller, renders, transcriptFlushScheduler } = makeController();

  controller.applyLocalTranscriptEntryPatch(
    { item_id: "agent-1", text: "final answer", thread_id: "thread-1" },
    { defaultStatus: "completed" }
  );

  assert.equal(
    renders.length,
    1,
    "a terminal completion must paint at once, not wait out the coalescing window"
  );
  assert.equal(
    transcriptFlushScheduler.stats().pending,
    false,
    "nothing must be left pending to render a second time"
  );

  clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
  assert.equal(renders.length, 1, "the immediate flush must not be followed by a second, coalesced one");
});

test("failed/error/cancelled entry patches flush immediately, same as completed", () => {
  for (const status of ["failed", "error", "cancelled"]) {
    const { clock, controller, renders } = makeController();

    controller.applyLocalTranscriptEntryPatch(
      { item_id: "agent-1", status, thread_id: "thread-1" },
      { defaultStatus: null }
    );

    assert.equal(renders.length, 1, `a "${status}" patch must paint at once`);
    clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
    assert.equal(renders.length, 1, `"${status}" must not render a second time later`);
  }
});

test("a running (in-progress) entry patch still coalesces on the scheduler window", () => {
  const { clock, controller, renders } = makeController();

  controller.applyLocalTranscriptEntryPatch(
    { item_id: "agent-1", thread_id: "thread-1" },
    { defaultStatus: "running" }
  );

  assert.equal(renders.length, 0, "a non-terminal patch must still coalesce, not paint immediately");
  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
  assert.equal(renders.length, 1);
});

test("with a loaded hydration window, deltas within one window rebuild the transcript only once, at the flush", () => {
  __resetTranscriptFullRebuildCount();
  const { clock, controller, renders, state } = makeController();
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    ["agent-1", { ...state.session.transcript[0] }],
  ]);
  state.transcriptHydrationOrder = ["agent-1"];

  controller.applyLocalTranscriptEntryDelta({
    delta: "one",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  controller.applyLocalTranscriptEntryDelta({
    delta: " two",
    item_id: "agent-1",
    revision: 2,
    thread_id: "thread-1",
  });

  assert.equal(
    __readTranscriptFullRebuildCount(),
    0,
    "the window-loaded deltas must not rebuild the rendered array before the flush"
  );
  assert.equal(renders.length, 0);

  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  assert.equal(
    __readTranscriptFullRebuildCount(),
    1,
    "the flush must derive the rendered array from the window exactly once"
  );
  assert.equal(renders.length, 1);
  assert.equal(renders[0].transcript[0].text, "one two");
});

// REVIEW P1: renderSessionAndClearPendingFlush's own scheduler flush is not
// the only render path. A direct render call — session_meta_updated here,
// but any of the ~30 elsewhere in the app is the same shape — builds its own
// session object by spreading state.session and renders it immediately,
// cancelling the pending scheduled flush along the way. If the projection
// only ran inside the scheduler's own flush, that cancel would throw away
// the ONLY chance to derive the fresh array, and the direct render would
// paint the stale one with the just-streamed token missing.
test("a delta immediately followed by a direct render (session_meta_updated) still paints the fresh window text, not the stale array", () => {
  const { controller, renders, state } = makeController();
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    ["agent-1", { ...state.session.transcript[0] }],
  ]);
  state.transcriptHydrationOrder = ["agent-1"];

  controller.applyLocalTranscriptEntryDelta({
    delta: "one",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  assert.equal(renders.length, 0, "the delta must still be coalescing");

  // No scheduled flush ever fires — the direct render below is the only
  // paint this test drives.
  controller.applySessionStreamEvent("session_meta_updated", {
    session: { current_status: "idle" },
  });

  assert.equal(renders.length, 1, "the direct render must paint immediately");
  assert.equal(
    renders[0].transcript[0].text,
    "one",
    "the direct render must include the token the cancelled flush would have shown"
  );
  assert.equal(renders[0].current_status, "idle", "and still carry the metadata it was sent to apply");
});

// P1: frontend/app.js:1192 (`renderer.renderSession`'s wrap) calls
// cancelPendingTranscriptFlush() and then paints `state.session` DIRECTLY —
// it never goes through renderSessionAndClearPendingFlush/ctx.renderSession
// at all, so it never called projectTranscriptWindowIfPending either. A BARE
// cancel (the old cancelPendingTranscriptFlush) would destroy the only
// scheduled catch-up while leaving state.session.transcript on its stale
// pre-projection array — so this direct paint would show that stale array
// with the just-streamed token invisible, permanently (nothing else was
// ever going to render it). cancelPendingTranscriptFlush must settle too.
test("cancelPendingTranscriptFlush settles the pending projection, so a direct render right after paints the fresh text, not the stale array", () => {
  const { controller, state, renders, transcriptFlushScheduler, cancelPendingTranscriptFlush } = makeController();
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    ["agent-1", { ...state.session.transcript[0] }],
  ]);
  state.transcriptHydrationOrder = ["agent-1"];

  controller.applyLocalTranscriptEntryDelta({
    delta: "one",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });

  // Sanity: before settling, the array itself has not been rebuilt — only
  // the window Map has the token (this is what "deferred" means).
  assert.equal(state.session.transcript[0].text, "");
  assert.equal(transcriptFlushScheduler.stats().pending, true);

  // Drives the SAME resolveDirectRenderSession app.js's wrappedRenderSession
  // (frontend/app.js:1191) calls — not a hand-mirrored copy of its logic —
  // for every direct `renderer.renderSession(state.session)` call site there
  // (~30 of them): passes state.session, settles via cancelPendingTranscriptFlush
  // first, then hands the (possibly reassigned) session to the real renderer.
  // `renders` below stands in for that renderer, so the assertion is on what
  // it actually RECEIVED, not on state.session read back out independently of
  // any render call.
  const resolved = resolveDirectRenderSession(state.session, {
    state,
    cancelPendingTranscriptFlush,
  });
  renders.push(resolved);

  assert.equal(
    transcriptFlushScheduler.stats().pending,
    false,
    "the scheduled catch-up must be cancelled — the direct render satisfies it"
  );
  assert.equal(renders.length, 1, "the renderer must have been invoked exactly once");
  assert.equal(
    renders[0].transcript[0].text,
    "one",
    "a bare cancel would leave this stale — the RENDERER must receive the settled text, not the pre-projection array"
  );
});

// P1: render-session.js's OWN internal callbacks — teamsCache.sync's resolve
// (render-session.js:624), reviewsCache.sync's and workflowsCache.sync's
// resolves, the pairing-expiry timer — call the closure-local `renderSession`
// function DIRECTLY. None of them go through ctx.renderSession, and none of
// them go through app.js's `renderer.renderSession` wrap either (that wrap
// only intercepts the exported object property; these closures call the
// function binding itself). Settling only in those two places therefore
// leaves every one of these call sites able to paint the stale
// pre-projection array immediately and then paint AGAIN when the scheduler's
// own timer catches up. renderSessionBase below mirrors render-session.js's
// fix: renderSession calls cancelPendingTranscriptFlush itself.
test("an internal renderSession callback (mirroring render-session.js's teamsCache.sync resolve) settles the pending flush itself and is not double-rendered by the scheduler's own timer", () => {
  const { clock, controller, renders, state, transcriptFlushScheduler, renderSessionBase } = makeController();
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([["agent-1", { ...state.session.transcript[0] }]]);
  state.transcriptHydrationOrder = ["agent-1"];

  controller.applyLocalTranscriptEntryDelta({
    delta: "one",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  assert.equal(renders.length, 0, "the delta must still be coalescing");
  assert.equal(transcriptFlushScheduler.stats().pending, true);

  // Mirrors render-session.js:624 — `() => renderSession(state.session || session)`,
  // a closure over the SAME `renderSession` this file's fix lives inside,
  // never routed through any external wrapper.
  function teamsCacheResolvedCallback() {
    renderSessionBase(state.session);
  }
  teamsCacheResolvedCallback();

  assert.equal(renders.length, 1, "the internal callback must have painted");
  assert.equal(
    renders[0].transcript[0].text,
    "one",
    "and painted the settled text, not the stale pre-projection array"
  );
  assert.equal(
    transcriptFlushScheduler.stats().pending,
    false,
    "the internal callback must cancel the scheduler's pending timer too, not just settle the array"
  );

  clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
  assert.equal(
    renders.length,
    1,
    "the scheduler's own (already-cancelled) timer must not fire a second render"
  );
});

// P1: applyLocalTranscriptEntryPatch reads state.session.transcript and
// rebuilds it (for a DIFFERENT item than any pending delta targets) without
// ever touching the hydration window. Two ways that used to go wrong, both
// guarded here:
//   - The old render-time projection matched a pending append by ARRAY
//     IDENTITY. This patch's rebuild produces a new array reference, so the
//     match missed and agent-1's still-pending delta was silently dropped
//     from the eventual render (never lost from the window itself, just
//     never painted).
//   - Settling always re-derives the WHOLE array from the window
//     (settleTranscriptProjection), which does not know about this patch —
//     so if the patch does not settle FIRST, before its own read/rebuild,
//     the render chokepoint's later settle overwrites the patch's own
//     array-only change to agent-2 with the window's (unpatched) copy of it.
test("an entry patch for one item, landing between a delta for another item and the flush, does not drop the delta OR the patch", () => {
  const { clock, controller, renders, state } = makeController();
  state.session.transcript.push({
    item_id: "agent-2",
    kind: "agent_text",
    status: "running",
    text: "",
    tool: null,
    turn_id: "turn-2",
  });
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    ["agent-1", { ...state.session.transcript[0] }],
    ["agent-2", { ...state.session.transcript[1] }],
  ]);
  state.transcriptHydrationOrder = ["agent-1", "agent-2"];

  controller.applyLocalTranscriptEntryDelta({
    delta: "one",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  assert.equal(renders.length, 0, "the delta must still be coalescing");

  // The interleaved write: a patch for agent-2 lands BEFORE the delta's
  // flush fires. It reads+rewrites state.session.transcript directly,
  // producing a new array reference — exactly the write the old
  // identity-matching projection could not see past.
  controller.applyLocalTranscriptEntryPatch(
    { item_id: "agent-2", status: "completed", text: "done", thread_id: "thread-1" },
    { defaultStatus: "completed" }
  );

  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  assert.equal(renders.length, 1);
  const rendered = renders[0].transcript;
  assert.equal(
    rendered.find((entry) => entry.item_id === "agent-1").text,
    "one",
    "the delta for agent-1 must survive the interleaved patch for agent-2, not be dropped by it"
  );
  assert.equal(
    rendered.find((entry) => entry.item_id === "agent-2").text,
    "done",
    "and the patch itself must still land"
  );
});

// P1: settling before a patch reads the array only protects THAT ONE flush.
// A SECOND delta after the patch (still before the flush) re-arms
// transcriptWindowProjectionPending, and the eventual settle rebuilds the
// array from the window — which never received the patch's fields (it can
// never safely write them; see invalidateTranscriptWindowEntryForPatch) and
// was invalidated instead. renderedTranscriptFromWindow's array-fallback for
// that invalidated entry is what keeps the patch from being overwritten by
// the window's own (blanked) copy.
test("a patch survives a later delta for another item re-arming the pending projection before the flush", () => {
  const { clock, controller, renders, state } = makeController();
  state.session.transcript.push({
    item_id: "agent-2",
    kind: "agent_text",
    status: "running",
    text: "",
    tool: null,
    turn_id: "turn-2",
  });
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    ["agent-1", { ...state.session.transcript[0] }],
    ["agent-2", { ...state.session.transcript[1] }],
  ]);
  state.transcriptHydrationOrder = ["agent-1", "agent-2"];

  controller.applyLocalTranscriptEntryDelta({
    delta: "one",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  controller.applyLocalTranscriptEntryPatch(
    { item_id: "agent-2", status: "completed", text: "done", thread_id: "thread-1" },
    { defaultStatus: "completed" }
  );
  // The completion patch is terminal, so — per the immediate-flush fix — it
  // paints AT ONCE, settling agent-1's still-pending delta text along with it
  // rather than leaving both to coalesce.
  assert.equal(renders.length, 1, "a terminal patch must paint at once");
  assert.equal(
    renders[0].transcript.find((entry) => entry.item_id === "agent-1").text,
    "one",
    "the pending delta must be settled into the immediate flush, not dropped"
  );
  assert.equal(renders[0].transcript.find((entry) => entry.item_id === "agent-2").text, "done");

  // A second delta for agent-1 lands AFTER the patch's immediate flush,
  // re-arming the pending window projection for a fresh coalesced render.
  controller.applyLocalTranscriptEntryDelta({
    delta: " two",
    item_id: "agent-1",
    revision: 2,
    thread_id: "thread-1",
  });
  assert.equal(renders.length, 1, "still coalescing");

  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  assert.equal(renders.length, 2);
  const rendered = renders[1].transcript;
  assert.equal(
    rendered.find((entry) => entry.item_id === "agent-1").text,
    "one two",
    "both deltas for agent-1 must land"
  );
  assert.equal(
    rendered.find((entry) => entry.item_id === "agent-2").text,
    "done",
    "the patch must survive the later delta re-arming the window projection — it must have reached the window itself"
  );
});

// P1: applyLocalTranscriptEntryPatch wrote into the window unconditionally —
// unlike the delta path a few lines up, it never checked transcriptWindowIsLoaded
// first. A patch landing while hydration was merely armed for this thread
// (transcriptHydrationThreadId set, but entries/order still empty) therefore
// created a one-entry "loaded" window off that single patched item, and the
// very next delta for a DIFFERENT, already-visible item then settles the
// array down to just the window's contents — dropping every untouched row.
test("a completion patch before hydration has loaded anything must not turn an empty window into a one-entry one", () => {
  const { clock, controller, renders, state } = makeController();
  state.session.transcript.push(
    { item_id: "agent-2", kind: "agent_text", status: "running", text: "", tool: null, turn_id: "turn-2" },
    { item_id: "agent-3", kind: "agent_text", status: "running", text: "", tool: null, turn_id: "turn-3" }
  );
  // Hydration has been armed for this thread but nothing has landed yet.
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map();
  state.transcriptHydrationOrder = [];

  controller.applyLocalTranscriptEntryPatch(
    { item_id: "agent-3", status: "completed", text: "done", thread_id: "thread-1" },
    { defaultStatus: "completed" }
  );

  assert.equal(
    state.transcriptHydrationOrder.length,
    0,
    "a patch alone must never be the thing that makes an unhydrated window look loaded"
  );

  // A delta for a DIFFERENT item, still visible in the array — if the patch
  // above had wrongly loaded the window, this would settle the array down to
  // just the window's one entry.
  controller.applyLocalTranscriptEntryDelta({
    delta: "X",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  const rendered = renders[renders.length - 1].transcript;
  assert.equal(
    rendered.length,
    3,
    "agent-2 must not have been dropped by a window the patch alone should never have loaded"
  );
  assert.ok(rendered.some((entry) => entry.item_id === "agent-2"));
});

// P1 (review, transcriptPatchOverlay): invalidateTranscriptWindowEntryForPatch
// deliberately no-ops for an item absent from an otherwise-LOADED window — a
// patch carries no authoritative body, so it must never be what teaches the
// window about a new item (see .sealwire/PLAN.md, "Invalidate; do not
// write"). applyLocalTranscriptEntryPatch still appends the item to
// state.session.transcript so it is visible right away, and drives a real
// hydration merge (ensureConversationTranscript) so the window learns about
// it properly. A previous attempt at this ALSO blanket-invalidated every
// OTHER entry already in the window (a blunt whole-window repair) to keep a
// later settle from dropping the new item — that is no longer necessary
// (and no longer happens): renderedTranscriptFromWindow's own array-fallback
// for a window-missing item means an untouched sibling stays trusted.
test("a completion patch for an item a LOADED window has never seen survives a later settle, without invalidating its siblings", () => {
  const ensureConversationTranscriptCalls = [];
  const { clock, state, controller } = makeController({
    ensureConversationTranscript: (session) => {
      ensureConversationTranscriptCalls.push(session);
    },
  });
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationOrder = ["agent-1"];
  state.transcriptHydrationEntries = new Map([
    ["agent-1", { ...state.session.transcript[0], text: "sibling text", content_state: "full" }],
  ]);

  controller.applyLocalTranscriptEntryPatch(
    { item_id: "agent-2", status: "completed", text: "brand new", thread_id: "thread-1" },
    { defaultStatus: "completed" }
  );

  assert.ok(
    state.session.transcript.some((entry) => entry.item_id === "agent-2"),
    "the new entry must still be visible right away"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1")?.content_state,
    "full",
    "an untouched sibling must not be blanket-invalidated just because a DIFFERENT item was patched"
  );
  assert.equal(
    ensureConversationTranscriptCalls.length,
    1,
    "a real hydration merge must still be driven, so it can repair OTHER already-tracked entries"
  );
  // P1 (review): the pushed session must be the PRE-patch state.session, not
  // a patch-derived nextSession — a patch carries no content_state field, so
  // exposing agent-2's fabricated entry to hydration's tail merge would
  // default the missing field to "full" and poison the window with an
  // empty-but-"full" entry, permanently suppressing the real fetch (see
  // .sealwire/PLAN.md, "Invalidate; do not write" -> "Never route
  // non-authoritative data through the authoritative path").
  assert.ok(
    !ensureConversationTranscriptCalls[0]?.transcript?.some((entry) => entry.item_id === "agent-2"),
    "the session handed to hydration must not mention the patch-only item at all"
  );

  // A later delta for the SIBLING re-arms the pending projection; settling it
  // rebuilds the array from the window — which still has never heard of
  // agent-2. Must not silently drop it.
  controller.applyLocalTranscriptEntryDelta({
    delta: " more",
    item_id: "agent-1",
    text_offset: "sibling text".length,
    thread_id: "thread-1",
  });
  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  assert.ok(
    state.session.transcript.some((entry) => entry.item_id === "agent-2"),
    "agent-2 must survive the sibling's later settle, not vanish because the window never tracked it"
  );
});

// P1 (review, transcriptPatchOverlay): a text-replacement patch used to
// change the window's PROJECTION via a side overlay without ever touching
// entries.get's own cached body. A later delta for the SAME item reconciled
// against that untouched, pre-patch body — not the patch's replacement — and,
// on success, cleared the overlay as "stale now". So patching "Hello" ->
// "Jello" then appending "!" at offset 5 (valid against the cached "Hello",
// coincidentally the same length) resolved to "Hello!", silently discarding
// the replacement. Now the patch clears the window's own cached text
// (invalidateTranscriptWindowEntryForPatch), so that same delta's offset (5
// against a blank cache) reads as a gap and is correctly refused instead of
// silently corrupting the text — the replacement survives, uncorrupted; the
// "!" is lost until hydration re-fetches, the "coarser, not cleverer"
// tradeoff .sealwire/PLAN.md accepts.
test("a text-replacement patch is not silently discarded by a later delta for the same item", () => {
  const { controller, state } = makeController();
  state.session.transcript[0].text = "Hello";
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    ["agent-1", { ...state.session.transcript[0], content_state: "full" }],
  ]);
  state.transcriptHydrationOrder = ["agent-1"];

  controller.applyLocalTranscriptEntryPatch(
    { item_id: "agent-1", text: "Jello", status: "running", thread_id: "thread-1" }
  );
  assert.equal(state.session.transcript[0].text, "Jello", "the replacement must land immediately");

  controller.applyLocalTranscriptEntryDelta({
    delta: "!",
    item_id: "agent-1",
    text_offset: 5,
    thread_id: "thread-1",
  });
  settleTranscriptProjection(state);

  assert.equal(
    state.session.transcript[0].text,
    "Jello",
    "the replacement must survive a later delta for the same item — never revert to the pre-patch text"
  );
});
