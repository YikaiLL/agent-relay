import assert from "node:assert/strict";
import test from "node:test";

import {
  createStreamController,
  __readTranscriptFullRebuildCount,
  __resetTranscriptFullRebuildCount,
} from "./session/stream.js";
import { settleTranscriptProjection } from "./transcript/store.js";
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

function makeController() {
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
    transcriptFlushScheduler.cancel();
    const settled = settleTranscriptProjection(state);
    if (!settled) {
      return baseRenderSession(session);
    }
    // settleTranscriptProjection materialises into state.session, not
    // necessarily into THIS `session` — a direct call (session_meta_updated
    // below) builds its own `{...state.session, override}` copy captured
    // before the settle above ran. Recognise "the same live thread" by id,
    // not array identity, and adopt the freshly-settled transcript into it.
    const isLiveThreadSession =
      session
      && state.session
      && session.active_thread_id
      && session.active_thread_id === state.session.active_thread_id;
    return baseRenderSession(
      isLiveThreadSession ? { ...session, transcript: state.session.transcript } : session
    );
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
    handleUnauthorized() {},
    logLine() {},
    renderSession: renderSessionAndClearPendingFlush,
    scheduleSessionPoll() {},
    scheduleStreamReconnect() {},
    seedDefaults() {},
    state,
    transcriptFlushScheduler,
  });

  // Mirrors session-controller.js's exposed cancelPendingTranscriptFlush —
  // app.js's `renderer.renderSession` wrap (frontend/app.js:1192) calls this
  // BEFORE painting `state.session` directly, bypassing
  // renderSessionAndClearPendingFlush/ctx.renderSession entirely. Must
  // settle as well as cancel, or that direct paint sees the stale
  // pre-projection array.
  function cancelPendingTranscriptFlush() {
    transcriptFlushScheduler.cancel();
    settleTranscriptProjection(state);
  }

  return { clock, controller, renders, state, transcriptFlushScheduler, cancelPendingTranscriptFlush };
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

  // Reproduces app.js's wrappedRenderSession EXACTLY (frontend/app.js:1184):
  // every direct `renderer.renderSession(state.session)` call site there
  // (~30 of them) passes state.session, calls cancelPendingTranscriptFlush()
  // first — never ctx.renderSession — then hands the (possibly reassigned)
  // session to the real renderer. `renders` below stands in for that
  // renderer, so the assertion is on what it actually RECEIVED, not on
  // state.session read back out independently of any render call.
  function wrappedRenderSession(session) {
    const wasLiveSession = session === state.session;
    cancelPendingTranscriptFlush();
    if (wasLiveSession) {
      session = state.session;
    }
    renders.push(session);
  }

  wrappedRenderSession(state.session);

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
// A patch that never writes into the hydration window is still invisible to
// it — so a SECOND delta after the patch (still before the flush) re-arms
// transcriptWindowProjectionPending, and the eventual settle rebuilds the
// array PURELY from the window, which has never heard of the patch. The
// patch must therefore also land in the window itself, not just the array.
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
  // A second delta for agent-1 lands AFTER the patch, still before the
  // flush — this re-arms the pending window projection the patch's own
  // settle-before-read already cleared once.
  controller.applyLocalTranscriptEntryDelta({
    delta: " two",
    item_id: "agent-1",
    revision: 2,
    thread_id: "thread-1",
  });
  assert.equal(renders.length, 0, "still coalescing");

  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  assert.equal(renders.length, 1);
  const rendered = renders[0].transcript;
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
