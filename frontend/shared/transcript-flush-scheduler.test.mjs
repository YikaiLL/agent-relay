import assert from "node:assert/strict";
import test from "node:test";

import {
  createTranscriptFlushScheduler,
  TRANSCRIPT_FLUSH_CHAR_THRESHOLD,
  TRANSCRIPT_FLUSH_MAX_WINDOW_MS,
  TRANSCRIPT_FLUSH_MIN_WINDOW_MS,
} from "./transcript-flush-scheduler.js";

/**
 * A minimal fake clock: `tick` advances time and fires due timers (in due
 * order); `advance` moves time with no side effect, for simulating render
 * duration from inside a fake `render()` without recursively firing timers.
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
    advance(ms) {
      currentTime += ms;
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

test("coalesces repeated queue() calls into a single render within one window", () => {
  const clock = createManualClock();
  const renders = [];
  let latest = "";
  const scheduler = createTranscriptFlushScheduler({
    render: () => renders.push(latest),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => false,
  });

  latest = "one";
  scheduler.queue("transcript_entry_delta");
  latest = "one two";
  scheduler.queue("transcript_entry_delta");
  latest = "one two three";
  scheduler.queue("transcript_entry_delta");

  assert.equal(clock.pendingTimerCount(), 1);
  assert.deepEqual(renders, []);

  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  assert.deepEqual(renders, ["one two three"]);
});

test("can queue another render after the window flushes", () => {
  const clock = createManualClock();
  let renderCount = 0;
  const scheduler = createTranscriptFlushScheduler({
    render: () => {
      renderCount += 1;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => false,
  });

  scheduler.queue("transcript_entry_delta");
  clock.tick(scheduler.stats().windowMs);
  scheduler.queue("transcript_entry_delta");
  clock.tick(scheduler.stats().windowMs);

  assert.equal(renderCount, 2);
});

test("flushNow brings a queued render forward and renders exactly once — no duplicate for the pending text", () => {
  const clock = createManualClock();
  const renders = [];
  let latest = "delta";
  const scheduler = createTranscriptFlushScheduler({
    render: () => renders.push(latest),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => false,
  });

  scheduler.queue("transcript_entry_delta");
  scheduler.flushNow("approval_added");

  assert.deepEqual(renders, ["delta"]);

  // The window flushNow brought forward must not also fire on its own.
  clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
  assert.deepEqual(renders, ["delta"]);

  latest = "authoritative snapshot";
  scheduler.queue("transcript_entry_delta");
  clock.tick(scheduler.stats().windowMs);

  assert.deepEqual(renders, ["delta", "authoritative snapshot"]);
});

// The settle primitive this scheduler is paired with (session-controller.js's
// renderSessionAndClearPendingFlush / cancelPendingTranscriptFlush) calls
// scheduler.cancel() itself, from INSIDE the render() callback the
// scheduler's own flush invokes — runFlush already cleared the timer and
// bumped generation before calling render(), so this is a real re-entrant
// call, not a hypothetical one. It must be inert (isPending() is already
// false), and must not leave the generation counter or pending slot in a
// state where the NEXT schedule silently fails to fire.
test("a nested cancel() from inside the render callback does not corrupt the pending slot or generation counter for the next schedule", () => {
  const clock = createManualClock();
  let renderCount = 0;
  const scheduler = createTranscriptFlushScheduler({
    render: () => {
      renderCount += 1;
      scheduler.cancel();
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => false,
  });

  scheduler.queue("transcript_entry_delta");
  clock.tick(scheduler.stats().windowMs);

  assert.equal(renderCount, 1, "the flush must have rendered exactly once");
  assert.equal(scheduler.stats().pending, false, "the re-entrant cancel must not leave anything scheduled");

  // A fresh schedule after the re-entrant cancel must still fire normally —
  // proving the generation counter was not double-bumped into mismatching
  // the timer callback's captured `scheduledGeneration`.
  scheduler.queue("transcript_entry_delta");
  assert.equal(scheduler.stats().pending, true, "a new schedule after the re-entrant cancel must still arm a timer");
  clock.tick(scheduler.stats().windowMs);
  assert.equal(renderCount, 2, "the second flush must actually fire");
});

test("cancelling a queued render invalidates it, even if the host fails to clear the real timer", () => {
  const scheduledCallbacks = [];
  let renderCount = 0;
  const scheduler = createTranscriptFlushScheduler({
    render: () => {
      renderCount += 1;
    },
    now: () => 0,
    setTimer: (callback) => {
      scheduledCallbacks.push(callback);
      return scheduledCallbacks.length;
    },
    // Deliberately a no-op: this proves the generation counter — not the
    // host's clearTimeout — is what makes a cancelled callback inert.
    clearTimer: () => {},
    isHidden: () => false,
  });

  scheduler.queue("transcript_entry_delta");
  scheduler.cancel();
  scheduledCallbacks[0]();

  assert.equal(renderCount, 0);
});

test("N deltas inside one window produce exactly one render, seeing the latest accumulated text", () => {
  const clock = createManualClock();
  let renderCount = 0;
  let latest = "";
  let seenAtRender = null;
  const scheduler = createTranscriptFlushScheduler({
    render: () => {
      renderCount += 1;
      seenAtRender = latest;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => false,
  });

  for (let i = 0; i < 20; i += 1) {
    latest += "x";
    scheduler.queue("transcript_entry_delta");
    scheduler.note(1);
  }

  assert.equal(renderCount, 0);
  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
  assert.equal(renderCount, 1);
  assert.equal(seenAtRender, "x".repeat(20));
});

test("the window never leaves [100, 300]ms regardless of how slow a render is", () => {
  const clock = createManualClock();
  const scheduler = createTranscriptFlushScheduler({
    render: () => clock.advance(10_000),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => false,
  });

  for (let i = 0; i < 3; i += 1) {
    scheduler.queue("transcript_entry_delta");
    clock.tick(scheduler.stats().windowMs);
    const { windowMs } = scheduler.stats();
    assert.ok(
      windowMs >= TRANSCRIPT_FLUSH_MIN_WINDOW_MS && windowMs <= TRANSCRIPT_FLUSH_MAX_WINDOW_MS,
      `windowMs ${windowMs} left [100, 300]`
    );
  }
  assert.equal(scheduler.stats().windowMs, TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
});

test("a render that outlasts the window stretches the next window toward 300ms", () => {
  const clock = createManualClock();
  const scheduler = createTranscriptFlushScheduler({
    render: () => clock.advance(150), // longer than the 100ms starting window
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => false,
  });

  assert.equal(scheduler.stats().windowMs, TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
  scheduler.queue("transcript_entry_delta");
  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
  assert.equal(scheduler.stats().windowMs, TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
});

test("a stretched window survives the very next queue() instead of immediately re-decaying", () => {
  // Regression: a 150ms render is slower than the 100ms window it ran under
  // (so it reports 300), but 150ms is also LESS than 300. A stretch decision
  // re-derived by comparing lastRenderDurationMs against the already-updated
  // (300ms) windowMs would read 150 > 300 as false and decay back to 100 on
  // the very next queue() — before any render had actually proven itself
  // fast enough at the wider window.
  const clock = createManualClock();
  const scheduler = createTranscriptFlushScheduler({
    render: () => clock.advance(150),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => false,
  });

  scheduler.queue("transcript_entry_delta");
  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
  assert.equal(scheduler.stats().windowMs, TRANSCRIPT_FLUSH_MAX_WINDOW_MS);

  scheduler.queue("transcript_entry_delta");
  assert.equal(
    scheduler.stats().windowMs,
    TRANSCRIPT_FLUSH_MAX_WINDOW_MS,
    "the next queue() must not decay before a render proves itself fast enough at 300ms"
  );
});

// P1 regression: `renderOutlastedWindow` used to be re-derived by comparing
// `lastRenderDurationMs` against `windowMs` captured at the START of the very
// flush being measured — which is itself last flush's OUTPUT, not a fixed
// reference point. A steady 150ms render then oscillates: flush 1 measures
// against the 100ms floor (150 > 100, stretches to 300); flush 2 measures the
// SAME 150ms render against the 300ms it just got handed (150 > 300 is
// false, decays back to 100); flush 3 is back to measuring against 100
// again. Asserting only `stats().windowMs` after a single flush (the
// existing tests above) cannot catch this — it takes three consecutive
// schedules, and inspecting the actual delay handed to `setTimer` rather
// than a value read back out of the scheduler, to see the flip-flop.
test("a persistently slow render stays stretched across three consecutive schedules — the delay handed to setTimer never decays back to 100", () => {
  const requestedDelays = [];
  let pendingCallback = null;
  let elapsed = 0;
  const scheduler = createTranscriptFlushScheduler({
    // A STEADY 150ms render, every single flush — never gets any faster.
    render: () => {
      elapsed += 150;
    },
    now: () => elapsed,
    setTimer: (callback, delayMs) => {
      requestedDelays.push(delayMs);
      pendingCallback = callback;
      return requestedDelays.length;
    },
    clearTimer: () => {
      pendingCallback = null;
    },
    isHidden: () => false,
  });

  function fireNextTimer() {
    const callback = pendingCallback;
    pendingCallback = null;
    callback();
  }

  scheduler.queue("transcript_entry_delta");
  fireNextTimer(); // flush 1 (cold start): renders inside the initial 100ms window, then stretches
  scheduler.queue("transcript_entry_delta");
  fireNextTimer(); // flush 2 (post-warm-up #1): still 150ms — must have stayed at 300
  scheduler.queue("transcript_entry_delta");
  fireNextTimer(); // flush 3 (post-warm-up #2): still 150ms — must NOT have decayed back to 100
  scheduler.queue("transcript_entry_delta");
  fireNextTimer(); // flush 4 (post-warm-up #3): still 150ms — a third consecutive stretched schedule

  assert.deepEqual(
    requestedDelays,
    [100, 300, 300, 300],
    "the cold start reads the 100ms floor; every schedule after the first stretch must read 300"
  );
  // The specific property under test: at least three CONSECUTIVE delays
  // AFTER warm-up all read 300 — not just one that happens to follow the
  // first stretch (which the old windowBeforeRender comparison also got
  // right) before decaying back on the next.
  assert.deepEqual(
    requestedDelays.slice(1),
    [300, 300, 300],
    "three consecutive post-warm-up delays must all read 300 — a bug that decays every OTHER flush would still pass a shorter check"
  );
});

test("a hidden tab stretches the window even when renders are fast", () => {
  const clock = createManualClock();
  const scheduler = createTranscriptFlushScheduler({
    render: () => {},
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => true,
  });

  scheduler.queue("transcript_entry_delta");
  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
  assert.equal(scheduler.stats().windowMs, TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
});

test("the window decays back to 100ms once renders are fast and the tab is visible", () => {
  const clock = createManualClock();
  let hidden = true;
  const scheduler = createTranscriptFlushScheduler({
    render: () => {},
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => hidden,
  });

  scheduler.queue("transcript_entry_delta");
  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
  assert.equal(scheduler.stats().windowMs, TRANSCRIPT_FLUSH_MAX_WINDOW_MS);

  hidden = false;
  scheduler.queue("transcript_entry_delta");
  clock.tick(scheduler.stats().windowMs);
  assert.equal(scheduler.stats().windowMs, TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
});

test("note() flushes early once accumulated chars cross the threshold, without waiting out the window", () => {
  const clock = createManualClock();
  let renderCount = 0;
  const scheduler = createTranscriptFlushScheduler({
    render: () => {
      renderCount += 1;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => false,
  });

  scheduler.queue("transcript_entry_delta");
  scheduler.note(TRANSCRIPT_FLUSH_CHAR_THRESHOLD - 200);
  assert.equal(renderCount, 0);

  scheduler.note(500); // crosses the threshold
  assert.equal(renderCount, 1);

  // The window this flush brought forward must not also fire.
  clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
  assert.equal(renderCount, 1);
});

test("note() alone never schedules a render — it only brings forward a render already queued", () => {
  const clock = createManualClock();
  let renderCount = 0;
  const scheduler = createTranscriptFlushScheduler({
    render: () => {
      renderCount += 1;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => false,
  });

  scheduler.note(TRANSCRIPT_FLUSH_CHAR_THRESHOLD * 5);

  assert.equal(renderCount, 0);
  assert.equal(scheduler.stats().pending, false);
});

test("cancel() resets accumulated chars so they do not leak into the next window", () => {
  const clock = createManualClock();
  let renderCount = 0;
  const scheduler = createTranscriptFlushScheduler({
    render: () => {
      renderCount += 1;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => false,
  });

  scheduler.queue("transcript_entry_delta");
  scheduler.note(600);
  scheduler.cancel();
  assert.equal(scheduler.stats().pendingChars, 0);

  scheduler.queue("transcript_entry_delta");
  scheduler.note(600); // would have crossed the 1024 threshold had the prior 600 leaked through
  assert.equal(renderCount, 0);

  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
  assert.equal(renderCount, 1);
});

test("stats() reports pending state and render count", () => {
  const clock = createManualClock();
  const scheduler = createTranscriptFlushScheduler({
    render: () => {},
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => false,
  });

  assert.equal(scheduler.stats().pending, false);
  assert.equal(scheduler.stats().renderCount, 0);

  scheduler.queue("transcript_entry_delta");
  assert.equal(scheduler.stats().pending, true);

  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
  assert.equal(scheduler.stats().pending, false);
  assert.equal(scheduler.stats().renderCount, 1);
});

test("flushNow renders even with nothing queued — an immediate-class event has no pending flush to bring forward", () => {
  const clock = createManualClock();
  let renderCount = 0;
  const scheduler = createTranscriptFlushScheduler({
    render: () => {
      renderCount += 1;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => false,
  });

  scheduler.flushNow("approval_added");
  assert.equal(renderCount, 1);
  assert.equal(scheduler.stats().pending, false);
});
