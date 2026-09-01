import assert from "node:assert/strict";
import test from "node:test";

import { createStreamController } from "./stream.js";
import {
  nextOrchestratorRefreshObservations,
  nextOrchestratorWasWorking,
  orchestratorTranscriptRefreshDecision,
} from "../orchestrator-transcript-refresh.js";

// Both review rounds found bugs my earlier tests missed because they only exercised the
// hydration STORE. The defect lived in the reducer that sits on top of it: it reconciled
// the delta into the store (correctly) and then appended the same delta to the rendered
// transcript again, so a re-delivered chunk rendered as duplicated text.
//
// These tests drive the REAL controller through its real event entry point.

function harness({ threadId = "thread-1", itemId = "item-1", text = "Hello world" } = {}) {
  const entry = {
    item_id: itemId,
    kind: "agent_text",
    text,
    status: "running",
    turn_id: "turn-1",
    tool: null,
    content_state: "full",
  };
  const state = {
    session: {
      active_thread_id: threadId,
      transcript: [{ ...entry }],
      transcript_revision: 1,
    },
    transcriptHydrationThreadId: threadId,
    transcriptHydrationEntries: new Map([[itemId, { ...entry }]]),
    transcriptHydrationOrder: [itemId],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: null,
    viewOnlyThread: null,
  };
  const rendered = [];
  const hydrationCalls = [];
  const controller = createStreamController({
    state,
    ensureConversationTranscript: (session) => {
      hydrationCalls.push(session);
    },
    logLine: () => {},
    seedDefaults: () => {},
    renderSession: (session) => rendered.push(session),
    handleUnauthorized: () => {},
    applySessionSnapshot: () => {},
    cancelSessionPoll: () => {},
    cancelStreamReconnect: () => {},
    scheduleSessionPoll: () => {},
    scheduleStreamReconnect: () => {},
    // Render synchronously so assertions do not race an animation frame.
    scheduleRenderFrame: (callback) => callback(),
  });
  const deliver = (event) =>
    controller.applySessionStreamEvent("transcript_entry_delta", {
      thread_id: threadId,
      item_id: itemId,
      delta_kind: "agent_text",
      turn_id: "turn-1",
      ...event,
    });
  const renderedText = () =>
    state.session.transcript.find((candidate) => candidate.item_id === itemId)?.text;
  const storedText = () => state.transcriptHydrationEntries.get(itemId)?.text;
  return { state, deliver, renderedText, storedText, rendered, controller, hydrationCalls };
}

test("a contiguous delta extends both the stored and the rendered text once", () => {
  const h = harness({ text: "Hello" });

  h.deliver({ delta: " world", text_offset: 5 });

  assert.equal(h.storedText(), "Hello world");
  assert.equal(h.renderedText(), "Hello world");
});

// THE BUG: the SSE stream subscribes to deltas before it renders the initial snapshot,
// so a chunk can arrive both inside the snapshot and again as a buffered delta.
test("a re-delivered delta does not render duplicated text", () => {
  const h = harness({ text: "Hello world" });

  h.deliver({ delta: " world", text_offset: 5 });

  assert.equal(h.storedText(), "Hello world", "the store stays correct");
  assert.equal(
    h.renderedText(),
    "Hello world",
    "and the RENDERED transcript must not double-append"
  );
});

test("a partially-overlapping re-delivery renders exactly the missing tail", () => {
  const h = harness({ text: "Hello wor" });

  h.deliver({ delta: " world", text_offset: 5 });

  assert.equal(h.renderedText(), "Hello world");
});

// A gap means earlier text was lost. The reducer must not splice, and must leave the
// entry flagged for an authoritative refetch rather than freezing on a partial body.
test("a gapped delta neither splices nor renders, and marks the entry for repair", () => {
  const h = harness({ text: "Hello" });

  h.deliver({ delta: "tail", text_offset: 99 });

  assert.equal(h.renderedText(), "Hello", "no splice");
  assert.equal(
    h.state.transcriptHydrationEntries.get("item-1").content_state,
    "preview",
    "a refused delta must mark our copy non-authoritative so hydration refetches it"
  );
});

test("a divergent overlap is refused and marked for repair", () => {
  const h = harness({ text: "Hello XXXXX" });

  h.deliver({ delta: " world", text_offset: 5 });

  assert.equal(h.renderedText(), "Hello XXXXX");
  assert.equal(h.state.transcriptHydrationEntries.get("item-1").content_state, "preview");
});

// Command output carries no offset (the relay inserts separators server-side), so it
// stays append-only — but still must not double-append in the render.
test("command output appends once", () => {
  const h = harness({ text: "line 1" });

  h.deliver({ delta: "\nline 2", delta_kind: "command_output" });

  assert.equal(h.storedText(), "line 1\nline 2");
  assert.equal(h.renderedText(), "line 1\nline 2");
});

// A first delta for an unknown item that does NOT start at 0 means the opening text was
// lost. Storing that tail as a complete body would present a truncated message as whole.
test("an unknown item arriving mid-stream is flagged instead of shown as complete", () => {
  const h = harness();

  h.deliver({ item_id: "item-late", delta: "middle of a message", text_offset: 42 });

  const late = h.state.transcriptHydrationEntries.get("item-late");
  assert.equal(late.content_state, "preview", "must not claim to be the full body");
  assert.equal(late.text, "", "a body that starts mid-stream must not masquerade as whole");
});

test("an unknown item starting at offset 0 is stored as a full body", () => {
  const h = harness();

  h.deliver({ item_id: "item-new", delta: "a new message", text_offset: 0 });

  const created = h.state.transcriptHydrationEntries.get("item-new");
  assert.equal(created.text, "a new message");
  assert.equal(created.content_state, "full");
});

// Deltas for a thread this surface is not showing must not touch the live transcript.
test("a delta for another thread leaves the rendered transcript alone", () => {
  const h = harness({ text: "Hello" });

  h.deliver({ thread_id: "thread-other", delta: " stray", text_offset: 5 });

  assert.equal(h.renderedText(), "Hello");
});

// REVIEW P1: a lagged broadcast means frames were DROPPED. A compacted snapshot cannot
// repair that on its own — the merge keeps the longer local body over a shorter
// preview, so a stale-but-longer cache would win forever. The stream therefore tells
// the client explicitly, and the client must mark its window for refetch.
test("a lagged stream marks the loaded window for authoritative refetch", () => {
  const h = harness({ text: "a".repeat(1700) });
  assert.equal(h.state.transcriptHydrationEntries.get("item-1").content_state, "full");

  h.controller.applySessionStreamEvent("transcript_stream_lagged", { dropped: 12 });

  assert.equal(
    h.state.transcriptHydrationEntries.get("item-1").content_state,
    "preview",
    "a dropped-frame notice must make our cached body non-authoritative"
  );
});

// Marking dirty is NOT convergence. The re-hydration gate only fires on a later render
// whose snapshot still says truncated — and the server merges snapshot and delta frames
// with `stream::select`, so the newest snapshot can arrive BEFORE the lag notice. With
// no further state change afterwards, nothing would ever refetch and the tail would sit
// short forever. The notice must therefore drive the fetch itself.
test("a lagged stream starts an authoritative fetch, not just a dirty flag", () => {
  const h = harness({ text: "a".repeat(1700) });

  h.controller.applySessionStreamEvent("transcript_stream_lagged", { dropped: 3 });

  assert.equal(
    h.hydrationCalls.length,
    1,
    "the lag notice must trigger the transcript fetch itself"
  );
});

// REVIEW P2: a delta already covered by the initial snapshot legitimately arrives after
// it (the stream subscribes before the snapshot renders). Taking its revision verbatim
// walked the cursor BACKWARDS, making later snapshots look stale.
test("an already-covered delta does not roll the revision backwards", () => {
  const h = harness({ text: "Hello world" });
  h.state.session.transcript_revision = 10;

  h.deliver({ delta: " world", text_offset: 5, revision: 9 });

  assert.equal(
    h.state.session.transcript_revision,
    10,
    "the revision cursor must be monotonic"
  );
});

test("a newer delta still advances the revision", () => {
  const h = harness({ text: "Hello" });
  h.state.session.transcript_revision = 10;

  h.deliver({ delta: " world", text_offset: 5, revision: 11 });

  assert.equal(h.state.session.transcript_revision, 11);
  assert.equal(h.renderedText(), "Hello world");
});

// ---- the Orchestrator's transcript -----------------------------------------

// The Orchestrator is drawn BESIDE the conversation, so while you are reading a
// session it is never the active thread. Every non-active delta was routed to
// `state.viewOnlyThread` — the CONVERSATION's pin — and with no pin of its own
// the Orchestrator's deltas were dropped on the floor. Its pane then moved only
// when something re-fetched the whole page, which reads as "no streaming".
//
// The fix reuses `applyDeltaToViewOnlyPin` rather than growing a second reducer:
// offset reconciliation, gap refusal and thread-id ownership get decided once.
function orchHarness({ orchThreadId = "orch-1", entries = null } = {}) {
  const state = {
    session: {
      active_thread_id: "thread-1",
      transcript: [],
      transcript_revision: 1,
    },
    viewOnlyThread: null,
    orchestratorEntriesThreadId: orchThreadId,
    orchestratorEntries: entries ?? [
      { item_id: "orch-item-1", kind: "agent_text", text: "Look", status: "running" },
    ],
  };
  const rendered = [];
  const controller = createStreamController({
    state,
    ensureConversationTranscript: () => {},
    logLine: () => {},
    seedDefaults: () => {},
    renderSession: (session) => rendered.push(session),
    handleUnauthorized: () => {},
    applySessionSnapshot: () => {},
    cancelSessionPoll: () => {},
    cancelStreamReconnect: () => {},
    scheduleSessionPoll: () => {},
    scheduleStreamReconnect: () => {},
    scheduleRenderFrame: (callback) => callback(),
  });
  const deliver = (event) =>
    controller.applySessionStreamEvent("transcript_entry_delta", {
      item_id: "orch-item-1",
      delta_kind: "agent_text",
      turn_id: "orch-turn-1",
      ...event,
    });
  const orchText = () =>
    state.orchestratorEntries.find((entry) => entry.item_id === "orch-item-1")?.text;
  return { state, deliver, orchText, rendered };
}

test("a delta for the Orchestrator extends its entries and repaints", () => {
  const h = orchHarness();

  h.deliver({ thread_id: "orch-1", delta: "ing at it", text_offset: 4 });

  assert.equal(h.orchText(), "Looking at it");
  assert.equal(h.rendered.length, 1, "the pane must be repainted, not just mutated");
});

test("the Orchestrator gets the same offset reconciliation as a pinned thread", () => {
  const h = orchHarness();

  // Re-delivery of a chunk the entries already carry must not double-append.
  h.deliver({ thread_id: "orch-1", delta: "ok", text_offset: 4 });
  h.deliver({ thread_id: "orch-1", delta: "ok", text_offset: 4 });

  assert.equal(h.orchText(), "Lookok");
});

test("a delta for the Orchestrator leaves the conversation's own pin alone", () => {
  const h = orchHarness();
  h.state.viewOnlyThread = {
    threadId: "pinned-1",
    entries: [{ item_id: "pinned-item", text: "untouched", status: "running" }],
  };
  const pinBefore = h.state.viewOnlyThread;

  h.deliver({ thread_id: "orch-1", delta: "ing", text_offset: 4 });

  assert.equal(h.state.viewOnlyThread, pinBefore, "the pin object must not be replaced");
});

test("a delta for some third thread touches neither", () => {
  const h = orchHarness();

  h.deliver({ thread_id: "someone-else", delta: "nope", text_offset: 4 });

  assert.equal(h.orchText(), "Look");
  assert.equal(h.rendered.length, 0);
});

test("nothing happens when the Tasks screen has never loaded a transcript", () => {
  const h = orchHarness({ entries: [] });
  h.state.orchestratorEntriesThreadId = null;

  h.deliver({ thread_id: "orch-1", delta: "hi", text_offset: 0 });

  assert.deepEqual(h.state.orchestratorEntries, []);
  assert.equal(h.rendered.length, 0);
});

// The bug this pins: the reducer returns `wasWorking: true` and an
// `activeTurnId` alongside the entries (view-only-thread.js:146-148) precisely
// so a pin carrying live deltas is known to be mid-turn. The Orchestrator's
// routing kept only `.entries` and threw the rest away, and then derived
// "was working" from `thread_activity` instead. When that array does not list
// the Orchestrator -- or the Tasks screen is not mounted for the frame that
// carries the phase -- the working->idle refresh never fires and the last
// message renders as forever-streaming.
test("a streamed delta marks the Orchestrator as mid-turn", () => {
  const h = orchHarness();
  assert.notEqual(h.state.orchestratorWasWorking, true);

  h.deliver({ thread_id: "orch-1", delta: "ing", text_offset: 4 });

  assert.equal(h.state.orchestratorWasWorking, true, "text is arriving, so it is working");
  assert.equal(h.state.orchestratorDeltaRaisedWorking, true);
});

test("a delta for another thread does not mark the Orchestrator working", () => {
  const h = orchHarness();

  h.deliver({ thread_id: "someone-else", delta: "x", text_offset: 4 });

  assert.notEqual(h.state.orchestratorWasWorking, true);
});

const ORCH_THREAD = "orch-1";
const LIVE_THREAD = "thread-1";

function orchSession({ threadActivity = [] } = {}) {
  return {
    active_thread_id: LIVE_THREAD,
    orchestrator_thread_id: ORCH_THREAD,
    thread_activity: threadActivity,
  };
}

// Drive the same refresh decision renderTaskTeam uses. Deltas land through the
// stream controller; the Tasks pane applies the policy on the next render.
function maybeRefreshOrchestrator(state, session, loads) {
  const orchId = state.orchestratorEntriesThreadId;
  const decision = orchestratorTranscriptRefreshDecision(state, session, orchId);
  state.orchestratorWasWorking = nextOrchestratorWasWorking(state, decision.orchWorking);
  Object.assign(state, nextOrchestratorRefreshObservations(state, decision.orchWorking));
  if (decision.refresh) {
    if (decision.repair) {
      state.orchestratorTailGapRepairing = true;
    }
    loads.push({ threadId: orchId, terminal: decision.terminal, repair: decision.repair });
  }
}

test("orchestrator idle refresh fires when thread_activity clears after a delta", () => {
  const h = orchHarness();

  h.deliver({ thread_id: ORCH_THREAD, delta: "ing", text_offset: 4 });
  assert.equal(h.state.orchestratorWasWorking, true);

  const loads = [];
  const workingSession = orchSession({
    threadActivity: [{ thread_id: ORCH_THREAD, phase: "tool", tool: "Bash" }],
  });
  maybeRefreshOrchestrator(h.state, workingSession, loads);
  assert.equal(loads.length, 0, "no refresh while the orchestrator is still working");
  assert.equal(h.state.orchestratorWasWorking, true);

  const idleSession = orchSession();
  maybeRefreshOrchestrator(h.state, idleSession, loads);
  assert.equal(loads.length, 1, "phase clearing must trigger an authoritative refetch");
  assert.equal(loads[0].threadId, ORCH_THREAD);
  assert.equal(loads[0].terminal, true);
});

test("a fresh orchestrator delta is not mistaken for an observed idle edge", () => {
  const h = orchHarness();

  h.deliver({ thread_id: ORCH_THREAD, delta: "ing", text_offset: 4 });
  assert.equal(h.state.orchestratorWasWorking, true);
  assert.equal(h.state.orchestratorDeltaRaisedWorking, true);

  const loads = [];
  maybeRefreshOrchestrator(h.state, orchSession(), loads);

  assert.equal(loads.length, 0, "thread_activity omission must not arm a terminal fetch mid-turn");
  assert.equal(h.state.orchestratorWasWorking, true);
  assert.equal(h.state.orchestratorDeltaRaisedWorking, false, "the suppression latch is consumed on render");

  maybeRefreshOrchestrator(h.state, orchSession(), loads);
  assert.equal(loads.length, 1, "a later idle render must still refetch");
  assert.equal(loads[0].terminal, true);
});

test("orchestrator idle refresh survives thread_activity omitting the orchestrator during work", () => {
  const h = orchHarness();
  h.state.orchestratorEntriesLoading = true;

  h.deliver({ thread_id: ORCH_THREAD, delta: "ing", text_offset: 4 });
  assert.equal(h.state.orchestratorWasWorking, true);

  const loads = [];
  const workingSession = orchSession();
  maybeRefreshOrchestrator(h.state, workingSession, loads);

  assert.equal(loads.length, 0, "an in-flight page load must not swallow the idle edge");
  assert.equal(
    h.state.orchestratorWasWorking,
    true,
    "thread_activity must not clobber a delta-raised working latch"
  );

  h.state.orchestratorEntriesLoading = false;
  maybeRefreshOrchestrator(h.state, workingSession, loads);
  assert.equal(loads.length, 1, "the settled working→idle edge must refetch");
  assert.equal(loads[0].threadId, ORCH_THREAD);
  assert.equal(loads[0].terminal, true);
});

test("orchestrator tailGap triggers refresh even while entries are loading", () => {
  const h = orchHarness();
  h.state.orchestratorEntriesLoading = true;

  h.deliver({ thread_id: ORCH_THREAD, delta: "tail", text_offset: 99 });
  assert.equal(h.state.orchestratorTailGap, true);

  const loads = [];
  maybeRefreshOrchestrator(h.state, orchSession(), loads);

  assert.equal(loads.length, 1, "a refused delta must not wait behind orchestratorEntriesLoading");
  assert.equal(loads[0].threadId, ORCH_THREAD);
  assert.equal(loads[0].repair, true);
});

test("orchestrator tailGap repair does not start a second fetch while one is in flight", () => {
  const h = orchHarness();
  h.state.orchestratorTailGap = true;

  const loads = [];
  maybeRefreshOrchestrator(h.state, orchSession(), loads);
  assert.equal(loads.length, 1);
  assert.equal(h.state.orchestratorTailGapRepairing, true);

  maybeRefreshOrchestrator(h.state, orchSession(), loads);
  assert.equal(loads.length, 1, "tail-gap repair must be single-flight while the gap remains");
});
