import assert from "node:assert/strict";
import test from "node:test";

import { createStreamController } from "./stream.js";

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
