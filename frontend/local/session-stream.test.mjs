import assert from "node:assert/strict";
import test from "node:test";

import {
  createStreamController,
  __readTranscriptFullRebuildCount,
  __resetTranscriptFullRebuildCount,
} from "./session/stream.js";
import { adoptSettledTranscript, settleTranscriptProjection } from "./transcript/store.js";
import { hydrateLocalTranscript } from "./transcript/hydration.js";
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

// A manually-resolved promise, for driving two independent in-flight fetches
// to completion in a chosen order — no fake timer can express "the network
// call itself finishes now", only when queued callbacks run.
function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeController({ ensureConversationTranscript, fetchRawTranscriptPage, isViewingConversation } = {}) {
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
    fetchRawTranscriptPage,
    // Defaults to "yes" — most tests here don't care about the background/
    // off-screen-thread gate; the tests that DO care override it explicitly.
    isViewingConversation: isViewingConversation || (() => true),
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

// P1: the test above never loads a hydration window, so the delta it applies
// lands directly in state.session.transcript and cannot exercise the deferred
// window->array projection at all — see transcript/store.js's "Deferred
// window->array projection" section. This one loads a real window, so the
// delta is pending ONLY there when the lagged notice fires, the same shape as
// remote's scheduleTranscriptGapRepair (session-ops.js:619-630).
test("transcript_stream_lagged settles the pending window delta before invalidating, so the immediate render carries the newest text", () => {
  let fetchCalls = 0;
  const ensureConversationTranscript = () => {
    fetchCalls += 1;
    return Promise.resolve();
  };
  const { clock, controller, renders, state, transcriptFlushScheduler } = makeController({
    ensureConversationTranscript,
  });

  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationOrder = ["agent-1"];
  state.transcriptHydrationEntries = new Map([
    [
      "agent-1",
      {
        item_id: "agent-1",
        kind: "agent_text",
        status: "running",
        text: "hello",
        tool: null,
        entry_seq: null,
        content_state: "full",
      },
    ],
  ]);
  state.session.transcript[0].text = "hello";

  controller.applyLocalTranscriptEntryDelta({
    delta: " world",
    item_id: "agent-1",
    revision: 6,
    text_offset: 5,
    thread_id: "thread-1",
  });

  // Preconditions: the delta reached the window (O(1) write) but the O(n)
  // projection back onto the array is deferred — this is the state a naive
  // test (like the one above) can never produce.
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world",
    "precondition: the delta landed in the window"
  );
  assert.equal(
    state.session.transcript[0].text,
    "hello",
    "precondition: the array projection is still pending"
  );
  assert.equal(renders.length, 0, "precondition: the delta is still coalescing");

  controller.applySessionStreamEvent("transcript_stream_lagged", { dropped: 3 });

  assert.equal(renders.length, 1, "the lagged notice must flush immediately");
  assert.equal(
    renders[0].transcript[0].text,
    "hello world",
    "the immediate render must carry the newest text — invalidating before the pending delta settles " +
      "makes the projection fall back to the array's stale pre-delta copy instead"
  );
  assert.equal(fetchCalls, 1, "the refetch must still have been requested");
  assert.equal(
    transcriptFlushScheduler.stats().pending,
    false,
    "the coalesced timer must be absorbed by the immediate flush"
  );

  clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
  assert.equal(renders.length, 1, "the absorbed window timer must not render a second time later");
});

// P1 (review): transcript_stream_lagged is not the only local site that
// downgrades a loaded window entry's content_state — applyTranscriptDeltaToWindow
// (shared/transcript-hydration-store.js) does the same thing IN PLACE whenever
// an ordinary per-item delta is refused as a gap or byte mismatch. The fix
// above only covered the bulk lagged-notice path; this covers the equivalent
// per-item path reached through an everyday streaming delta, never through
// transcript_stream_lagged at all — it must get the SAME immediate
// settle -> refetch -> flush tail, not fall through to the coalesced render
// (a coalesced-only assertion reached by ticking the clock cannot tell a
// path that renders immediately apart from one that merely waits out the
// same window — this asserts the immediate render, fetch, and timer
// cancellation BEFORE the clock ever moves).
//
// P1 (review, round 2): an earlier version of this test stubbed
// ensureConversationTranscript itself and only counted that the stub was
// called. ensureConversationTranscript's own gate (prepareTranscriptHydration
// State, shared/transcript-hydration-store.js) fires off
// snapshot.transcript_truncated and the WIRE snapshot's own per-entry
// content_state — both server-computed signals a client-only window
// downgrade never touches — so in real code that call is a silent no-op:
// reproduction showed zero fetchPage calls. Stubbing it hid exactly that.
// This version stubs one level lower, at fetchRawTranscriptPage (the actual
// network boundary repairActiveTranscriptTail calls, bypassing both the
// broken gate AND queryClient's fetchQuery dedupe — see stream.js's doc on
// that function), and asserts the REAL merge landed: the window entry is
// promoted back to `full` with the fetched page's text, and a second render
// actually paints it.
//
// P1 (review): the fetch-initiation assertions used to run AFTER
// clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS), so a repair deferred into the
// coalesced window would still have passed. Initiation is synchronous — the
// call happens before repairActiveTranscriptTail's first await — so it is
// asserted immediately below, with no tick and no microtask flush.
test("a gapped delta for an item with an earlier pending append settles and flushes immediately, then repairs with the authoritative page once it lands", async () => {
  const fetchCalls = [];
  const fetchRawTranscriptPage = ({ threadId, before }) => {
    fetchCalls.push({ threadId, before });
    return Promise.resolve({
      thread_id: "thread-1",
      entries: [
        {
          item_id: "agent-1",
          kind: "agent_text",
          status: "completed",
          text: "hello world, repaired",
          tool: null,
          turn_id: "turn-1",
        },
      ],
      prev_cursor: null,
      revision: 8,
    });
  };
  const { clock, controller, renders, state, transcriptFlushScheduler } = makeController({
    fetchRawTranscriptPage,
  });

  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationOrder = ["agent-1"];
  state.transcriptHydrationEntries = new Map([
    [
      "agent-1",
      {
        item_id: "agent-1",
        kind: "agent_text",
        status: "running",
        text: "hello",
        tool: null,
        entry_seq: null,
        content_state: "full",
      },
    ],
  ]);
  state.session.transcript[0].text = "hello";

  // A valid delta appends " world" — lands only in the window (deferred
  // projection); the array still reads "hello" until something settles it.
  controller.applyLocalTranscriptEntryDelta({
    delta: " world",
    item_id: "agent-1",
    revision: 6,
    text_offset: 5,
    thread_id: "thread-1",
  });
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world",
    "precondition: the valid append landed in the window"
  );
  assert.equal(
    state.session.transcript[0].text,
    "hello",
    "precondition: the array projection is still pending"
  );
  assert.equal(renders.length, 0, "precondition: the delta is still coalescing");

  // A second, GAPPED delta for the SAME item arrives (offset far past the
  // window's current length) — applyTranscriptDeltaToWindow refuses it and
  // downgrades the window entry to preview in place, right there, with no
  // notice like transcript_stream_lagged to hang a fix off of.
  controller.applyLocalTranscriptEntryDelta({
    delta: "z",
    item_id: "agent-1",
    revision: 7,
    text_offset: 100,
    thread_id: "thread-1",
  });

  // Fetch initiation is synchronous — repairActiveTranscriptTail calls
  // fetchRawTranscriptPage before its first await, so this is observable right
  // away with no clock tick and no microtask flush. Asserted BEFORE either, or
  // a repair deferred into the coalesced window would pass this test too.
  assert.equal(fetchCalls.length, 1, "a true refusal must trigger exactly one authoritative-tail fetch");
  assert.equal(fetchCalls[0].threadId, "thread-1");
  assert.equal(fetchCalls[0].before, null, "the repair must fetch the LIVE tail, not an older page");
  assert.equal(
    renders.length,
    1,
    "the refusal must flush immediately, not sit out the coalescing window behind a copy already known stale"
  );
  assert.equal(
    renders[0].transcript[0].text,
    "hello world",
    "the immediate render must carry the earlier valid append — downgrading the window before that append " +
      "settles makes the projection fall back to the array's stale pre-append copy instead"
  );
  assert.equal(
    transcriptFlushScheduler.stats().pending,
    false,
    "the coalesced timer armed by the first (valid) delta must be absorbed by the immediate flush"
  );

  clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
  assert.equal(renders.length, 1, "the absorbed window timer must not render a second time later");
  assert.equal(fetchCalls.length, 1, "the coalesced window timer must not trigger a second repair fetch");

  // The repair fetch is fire-and-forget (`void repairActiveTranscriptTail(...)`)
  // — flush the microtask queue so its continuation (the merge + render after
  // `await fetchRawTranscriptPage(...)` resolves) has actually run before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "full",
    "the fetched page must promote the window entry back to full"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world, repaired",
    "the window must hold the AUTHORITATIVE page's text, not the refused local copy"
  );
  assert.equal(
    renders.length,
    2,
    "the landed repair is new information and must paint again, once — this is not the absorbed stale timer"
  );
  assert.equal(
    renders[1].transcript[0].text,
    "hello world, repaired",
    "the second render must carry the repaired, authoritative text"
  );
});

// Sibling to the refusal test above: resolveDeltaAppend returns `""` — not
// `null` — for a pure re-delivery of bytes we already hold. `""` is falsy,
// so a naive `if (!resolveDeltaAppend(...))` refusal check would treat this
// exactly like a gap and refetch on every re-delivered chunk. It must stay
// the ordinary idempotent no-op: no refetch, no immediate render.
//
// P1 (review, round 3): stubbing ensureConversationTranscript only proved
// THAT stub was never called — production stopped calling it for this path
// in ee08b1ed, so the assertion was observing an unused dependency and would
// pass even if a duplicate wrongly triggered a repair. Stubs
// fetchRawTranscriptPage instead, the dependency repairActiveTranscriptTail
// actually calls now.
test("a duplicate delta for an item already fully held triggers neither a repair fetch nor an immediate render", () => {
  const fetchCalls = [];
  const fetchRawTranscriptPage = ({ threadId, before }) => {
    fetchCalls.push({ threadId, before });
    return Promise.resolve({ thread_id: "thread-1", entries: [], prev_cursor: null });
  };
  const { clock, controller, renders, state, transcriptFlushScheduler } = makeController({
    fetchRawTranscriptPage,
  });

  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationOrder = ["agent-1"];
  state.transcriptHydrationEntries = new Map([
    [
      "agent-1",
      {
        item_id: "agent-1",
        kind: "agent_text",
        status: "running",
        text: "hello world",
        tool: null,
        entry_seq: null,
        content_state: "full",
      },
    ],
  ]);
  state.session.transcript[0].text = "hello world";

  // Re-delivery of bytes already fully covered by what the window holds —
  // resolveDeltaAppend returns "", not null.
  controller.applyLocalTranscriptEntryDelta({
    delta: "hello",
    item_id: "agent-1",
    revision: 7,
    text_offset: 0,
    thread_id: "thread-1",
  });

  assert.equal(fetchCalls.length, 0, "a duplicate must never trigger a repair fetch");
  assert.equal(renders.length, 0, "a duplicate must never flush immediately");
  assert.equal(
    transcriptFlushScheduler.stats().pending,
    true,
    "a duplicate still coalesces like any other non-refusal delta, it just has nothing new to paint"
  );

  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
  assert.equal(renders.length, 1, "the coalesced window still renders once");
});

// P1 (review): the two tests above only cover an item the window ALREADY
// tracks — resolveDeltaAppend, and the isRefusal check built on it, never run
// for an item the window has never seen at all. applyTranscriptDeltaToWindow
// has its OWN refusal for that case: a first delta with a nonzero offset
// means the entry's opening text went missing, so it stores an empty preview
// rather than ever marking the entry `full`. Before this fix that shape fell
// straight through to the ordinary coalesced path with no refetch requested —
// reproducing as fetchCalls: 0, renders: 0, pending: true, the same signature
// the original per-item defect had.
//
// P1 (review, round 2): same correction as the sibling test above — stubbing
// ensureConversationTranscript only proved the stub was called, not that a
// real fetch (or its merge) ever happens; reproduction showed zero
// fetchPage calls for this shape too. Stubs fetchRawTranscriptPage instead
// (the dependency repairActiveTranscriptTail actually calls) and asserts the
// previously-missing item is actually promoted to `full` with real text once
// the repair lands.
test("a first delta for a new item with a missing head (nonzero offset) flushes immediately, then repairs once the authoritative page lands", async () => {
  const fetchCalls = [];
  const fetchRawTranscriptPage = ({ threadId, before }) => {
    fetchCalls.push({ threadId, before });
    return Promise.resolve({
      thread_id: "thread-1",
      entries: [
        {
          item_id: "agent-1",
          kind: "agent_text",
          status: "completed",
          text: "hello",
          tool: null,
          turn_id: "turn-1",
        },
        {
          item_id: "agent-2",
          kind: "agent_text",
          status: "completed",
          text: "full body the client never saw the head of",
          tool: null,
          turn_id: "turn-2",
        },
      ],
      prev_cursor: null,
      revision: 2,
    });
  };
  const { clock, controller, renders, state, transcriptFlushScheduler } = makeController({
    fetchRawTranscriptPage,
  });

  // The window is loaded for the thread (it already tracks "agent-1"), but
  // "agent-2" has never been seen by it — this exercises
  // applyTranscriptDeltaToWindow's "unknown item" branch, not the
  // resolveDeltaAppend-guarded "existing item" branch the sibling test does.
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationOrder = ["agent-1"];
  state.transcriptHydrationEntries = new Map([
    [
      "agent-1",
      {
        item_id: "agent-1",
        kind: "agent_text",
        status: "running",
        text: "hello",
        tool: null,
        entry_seq: null,
        content_state: "full",
      },
    ],
  ]);
  state.session.transcript[0].text = "hello";

  controller.applyLocalTranscriptEntryDelta({
    delta: "world",
    item_id: "agent-2",
    revision: 1,
    text_offset: 5,
    thread_id: "thread-1",
  });

  assert.equal(
    state.transcriptHydrationEntries.get("agent-2")?.content_state,
    "preview",
    "precondition: a missing head is recorded as an untrusted preview, never full"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-2")?.text,
    "",
    "precondition: the tail must not be stored as if it were the whole body"
  );

  assert.equal(
    renders.length,
    1,
    "a missing-head delta for a brand-new item must flush immediately, not sit out the coalescing window"
  );
  assert.equal(
    transcriptFlushScheduler.stats().pending,
    false,
    "no coalesced timer may be left armed behind the immediate flush"
  );

  clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
  assert.equal(renders.length, 1, "the absorbed window timer must not render a second time later");

  // Flush the microtask queue so the fire-and-forget repair's continuation
  // (the merge + render after `await fetchRawTranscriptPage(...)` resolves)
  // has actually run before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(fetchCalls.length, 1, "a missing head must trigger exactly one authoritative-tail fetch");
  assert.equal(fetchCalls[0].threadId, "thread-1");
  assert.equal(fetchCalls[0].before, null, "the repair must fetch the LIVE tail, not an older page");
  assert.equal(
    state.transcriptHydrationEntries.get("agent-2")?.content_state,
    "full",
    "the fetched page must promote the previously-missing-head item to full"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-2")?.text,
    "full body the client never saw the head of",
    "the window must hold the AUTHORITATIVE page's text for the item the stream never delivered a head for"
  );
  assert.equal(
    renders.length,
    2,
    "the landed repair is new information and must paint again, once"
  );
  const repairedEntry = renders[1].transcript.find((entry) => entry.item_id === "agent-2");
  assert.ok(repairedEntry, "the repaired item must actually appear in the rendered transcript");
  assert.equal(
    repairedEntry.text,
    "full body the client never saw the head of",
    "the second render must carry the repaired, authoritative text for the previously-missing item"
  );
});

// P1 (review): the race the repair fetch above must survive. Two writers can
// merge a tail page into the same window: this repair, and a PRE-GAP
// hydration fetch already in flight through the shared hydrateTranscript
// driver (shared/transcript-hydration.js) — e.g. a re-hydration armed before
// this gap happened, still awaiting its own fetchPage. isStaleTranscriptPage
// used to check only thread id, so nothing discarded that fetch's
// continuation once it landed, in either completion order. Each order below
// drives two independently-controlled deferreds and asserts the FINAL window
// state (text + content_state) — never that a function was called, which is
// what let the original defect through review three times over.
function setUpRaceState(fetchRawTranscriptPage) {
  const helpers = makeController({ fetchRawTranscriptPage });
  const { state } = helpers;
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationOrder = ["agent-1"];
  state.transcriptHydrationEntries = new Map([
    [
      "agent-1",
      {
        item_id: "agent-1",
        kind: "agent_text",
        status: "running",
        text: "hello world",
        tool: null,
        entry_seq: null,
        content_state: "full",
      },
    ],
  ]);
  state.session.transcript[0].text = "hello world";
  return helpers;
}

// Deliberately at least as long as "hello world, repaired" (22 chars): the
// merge keeps the LONGER of two same-rank (full) bodies, so this is what
// would let a stale page overwrite the repair if nothing discarded it — see
// mergeTranscriptEntry (shared/transcript-hydration-store.js).
const STALE_PRE_GAP_TEXT = "hello world STALE PRE-GAP BODY THAT MUST NOT WIN";

test("a stale pre-gap hydration fetch resolving BEFORE the repair must not block or get overwritten by it (old, then repair)", async () => {
  const oldFetch = createDeferred();
  const repairFetch = createDeferred();
  const { controller, state } = setUpRaceState(() => repairFetch.promise);

  // The pre-gap re-hydration fetch, in flight through the REAL shared driver
  // (not a stub) — the same driver production's ensureConversationTranscript
  // uses. Its own fetchPage is a second, independently-controlled deferred.
  void hydrateLocalTranscript(
    state,
    {
      active_thread_id: "thread-1",
      transcript_truncated: true,
      transcript: [
        {
          item_id: "agent-1",
          kind: "agent_text",
          status: "running",
          text: "hello world",
          tool: null,
          turn_id: "turn-1",
          content_state: "full",
        },
      ],
    },
    { fetchPage: () => oldFetch.promise, onProgress() {}, onError() {} }
  );

  // A gapped delta for the SAME item arrives — refused, which downgrades the
  // window entry, bumps the refusal epoch, and fires the repair fetch above.
  controller.applyLocalTranscriptEntryDelta({
    delta: "z",
    item_id: "agent-1",
    revision: 7,
    text_offset: 100,
    thread_id: "thread-1",
  });
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "preview",
    "precondition: the refusal downgraded the window entry"
  );

  // Old resolves first, with a page a real server could plausibly have
  // returned before the gap.
  oldFetch.resolve({
    thread_id: "thread-1",
    entries: [{ item_id: "agent-1", kind: "agent_text", status: "running", text: STALE_PRE_GAP_TEXT }],
    prev_cursor: null,
    revision: 6,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "preview",
    "the pre-gap page was fetched under an epoch the refusal already invalidated, so it must be discarded"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world",
    "the stale pre-gap page's text must never land in the window"
  );

  // Repair resolves second, with the authoritative post-gap text.
  repairFetch.resolve({
    thread_id: "thread-1",
    entries: [
      { item_id: "agent-1", kind: "agent_text", status: "completed", text: "hello world, repaired", turn_id: "turn-1" },
    ],
    prev_cursor: null,
    revision: 8,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "full",
    "the repair's authoritative page must land"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world, repaired",
    "the window must hold the repair's text"
  );
});

test("a stale pre-gap hydration fetch resolving AFTER the repair must not overwrite it (repair, then old)", async () => {
  const oldFetch = createDeferred();
  const repairFetch = createDeferred();
  const { controller, state } = setUpRaceState(() => repairFetch.promise);

  void hydrateLocalTranscript(
    state,
    {
      active_thread_id: "thread-1",
      transcript_truncated: true,
      transcript: [
        {
          item_id: "agent-1",
          kind: "agent_text",
          status: "running",
          text: "hello world",
          tool: null,
          turn_id: "turn-1",
          content_state: "full",
        },
      ],
    },
    { fetchPage: () => oldFetch.promise, onProgress() {}, onError() {} }
  );

  controller.applyLocalTranscriptEntryDelta({
    delta: "z",
    item_id: "agent-1",
    revision: 7,
    text_offset: 100,
    thread_id: "thread-1",
  });
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "preview",
    "precondition: the refusal downgraded the window entry"
  );

  // Repair resolves first this time — the authoritative post-gap text lands.
  repairFetch.resolve({
    thread_id: "thread-1",
    entries: [
      { item_id: "agent-1", kind: "agent_text", status: "completed", text: "hello world, repaired", turn_id: "turn-1" },
    ],
    prev_cursor: null,
    revision: 8,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "full",
    "precondition: the repair landed before the stale pre-gap fetch resolves"
  );
  assert.equal(state.transcriptHydrationEntries.get("agent-1").text, "hello world, repaired");

  // The dangerous order: the stale pre-gap page resolves AFTER the repair
  // already landed. Both are now `full`, so without the epoch guard the
  // merge's length tie-break (mergeTranscriptEntry) would let the longer,
  // stale body win and get re-marked authoritative — exactly the bug this
  // guard exists to stop.
  oldFetch.resolve({
    thread_id: "thread-1",
    entries: [{ item_id: "agent-1", kind: "agent_text", status: "running", text: STALE_PRE_GAP_TEXT }],
    prev_cursor: null,
    revision: 6,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "full",
    "the repair's content_state must survive the stale page landing late"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world, repaired",
    "the stale pre-gap page must not overwrite the already-repaired, authoritative text"
  );
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
