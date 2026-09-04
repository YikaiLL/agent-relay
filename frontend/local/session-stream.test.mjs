import assert from "node:assert/strict";
import test from "node:test";

import {
  createStreamController,
  __readTranscriptFullRebuildCount,
  __resetTranscriptFullRebuildCount,
} from "./session/stream.js";
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
  // projectTranscriptWindowIfPending() reliable no matter which path
  // triggered the render.
  function renderSessionAndClearPendingFlush(session) {
    transcriptFlushScheduler.cancel();
    return baseRenderSession(controller.projectTranscriptWindowIfPending(session));
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

  return { clock, controller, renders, state, transcriptFlushScheduler };
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
