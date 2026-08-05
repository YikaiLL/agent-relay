import assert from "node:assert/strict";
import test from "node:test";

import { appendTranscriptDelta, restoreHydratedTranscript } from "./store.js";

// A local surface renders from the HYDRATION STORE merged with the snapshot tail —
// `state.session.transcript` is not an input to that merge. So a live delta that only
// updates `state.session` is erased by the very next snapshot.
//
// That matters because the relay compacts the local snapshot's transcript to
// SESSION_SNAPSHOT_LOCAL_WEB_BUDGET.max_transcript_chars (1600) and marks the entry
// `preview`. Before deltas existed, that cap WAS the live tail: in-flight text stopped
// at 1600 characters and only caught up when a hydration fetch landed at end of turn.
// Deltas only actually fix that if they land where the merge can see them.

function seededState({ threadId = "thread-1", itemId = "item-1", text = "Hello" } = {}) {
  const state = {
    transcriptHydrationThreadId: threadId,
    transcriptHydrationEntries: new Map([
      [
        itemId,
        {
          item_id: itemId,
          kind: "agent_text",
          text,
          status: "running",
          turn_id: "turn-1",
          tool: null,
          content_state: "full",
        },
      ],
    ]),
    transcriptHydrationOrder: [itemId],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: null,
  };
  return state;
}

/** A snapshot the relay has compacted: same entry, clipped body, marked `preview`. */
function truncatedSnapshot({ threadId = "thread-1", itemId = "item-1", text = "Hel..." } = {}) {
  return {
    active_thread_id: threadId,
    transcript: [
      {
        item_id: itemId,
        kind: "agent_text",
        text,
        status: "running",
        turn_id: "turn-1",
        tool: null,
        content_state: "preview",
      },
    ],
    transcript_truncated: true,
  };
}

test("a live delta grows the entry the renderer actually reads", () => {
  const state = seededState();

  appendTranscriptDelta(state, {
    thread_id: "thread-1",
    item_id: "item-1",
    delta: " world",
    delta_kind: "agent_text",
    turn_id: "turn-1",
  });

  assert.equal(state.transcriptHydrationEntries.get("item-1").text, "Hello world");
});

// THE REGRESSION THIS FILE EXISTS FOR: the delta-grown body must survive the next
// snapshot. If it does not, live text visibly snaps back to the relay's compacted
// preview on every snapshot — which is the 1600-character freeze, just faster.
test("a compacted snapshot does not shrink text a delta already grew", () => {
  const state = seededState();

  appendTranscriptDelta(state, {
    thread_id: "thread-1",
    item_id: "item-1",
    delta: " world, this is a much longer body than the preview carries",
    delta_kind: "agent_text",
    turn_id: "turn-1",
  });
  const grown = state.transcriptHydrationEntries.get("item-1").text;

  const merged = restoreHydratedTranscript(state, truncatedSnapshot());

  assert.equal(
    merged.transcript.find((entry) => entry.item_id === "item-1").text,
    grown,
    "the compacted preview must not replace the longer live body"
  );
});

test("a delta for an unknown item starts a new entry at the tail", () => {
  const state = seededState();

  appendTranscriptDelta(state, {
    thread_id: "thread-1",
    item_id: "item-2",
    delta: "second message",
    delta_kind: "agent_text",
    turn_id: "turn-1",
  });

  assert.deepEqual(state.transcriptHydrationOrder, ["item-1", "item-2"]);
  assert.equal(state.transcriptHydrationEntries.get("item-2").text, "second message");
});

test("command output deltas land as command entries", () => {
  const state = seededState();

  appendTranscriptDelta(state, {
    thread_id: "thread-1",
    item_id: "cmd-1",
    delta: "build output",
    delta_kind: "command_output",
  });

  assert.equal(state.transcriptHydrationEntries.get("cmd-1").kind, "command");
});

// The store holds ONE thread's window. A delta for a different thread would splice
// another conversation's text into the one on screen.
test("a delta for a different thread is ignored", () => {
  const state = seededState();

  appendTranscriptDelta(state, {
    thread_id: "thread-other",
    item_id: "x-1",
    delta: "stray",
    delta_kind: "agent_text",
  });

  assert.equal(state.transcriptHydrationEntries.has("x-1"), false);
  assert.deepEqual(state.transcriptHydrationOrder, ["item-1"]);
});

test("a delta with no item id is ignored", () => {
  const state = seededState();

  appendTranscriptDelta(state, { thread_id: "thread-1", delta: "stray" });

  assert.deepEqual(state.transcriptHydrationOrder, ["item-1"]);
});

// A delta arriving for a thread whose window has not been hydrated yet must not
// fabricate a window — the hydration fetch owns that.
test("a delta is ignored when no thread window is loaded", () => {
  const state = seededState();
  state.transcriptHydrationThreadId = null;

  appendTranscriptDelta(state, {
    thread_id: "thread-1",
    item_id: "item-1",
    delta: " world",
  });

  assert.equal(state.transcriptHydrationEntries.get("item-1").text, "Hello");
});

// REVIEW P1 — DELTA RE-DELIVERY MUST BE IDEMPOTENT.
//
// The SSE stream subscribes to deltas BEFORE it generates the initial snapshot, so a
// chunk emitted in that window arrives twice: once inside the snapshot, once as a
// buffered delta. Blind appending turns "Hello world" into "Hello world world" — and
// because a delta marks the body `full`, the authoritative hydration page can never
// correct it (selectTranscriptText keeps the longer text).
//
// `text_offset` is the fix: it states where this delta starts, so a re-delivery is
// detectable instead of being appended again.
test("a re-delivered delta is not appended twice", () => {
  const state = seededState({ text: "Hello world" });

  // The snapshot already contained " world" (offset 5). Re-delivery must be a no-op.
  appendTranscriptDelta(state, {
    thread_id: "thread-1",
    item_id: "item-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  assert.equal(
    state.transcriptHydrationEntries.get("item-1").text,
    "Hello world",
    "a duplicate delta must not extend the body"
  );
});

test("a partially-overlapping re-delivery appends only the missing tail", () => {
  const state = seededState({ text: "Hello wor" });

  appendTranscriptDelta(state, {
    thread_id: "thread-1",
    item_id: "item-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  assert.equal(state.transcriptHydrationEntries.get("item-1").text, "Hello world");
});

// A delta starting past the end of what we hold means earlier text was lost. Appending
// would splice the stream out of order and silently corrupt the message.
test("a delta that starts past the end of our text is refused, not spliced", () => {
  const state = seededState({ text: "Hello" });

  const applied = appendTranscriptDelta(state, {
    thread_id: "thread-1",
    item_id: "item-1",
    delta: "tail",
    delta_kind: "agent_text",
    text_offset: 99,
  });

  assert.equal(applied, false, "a gapped delta must report that it did not apply");
  assert.equal(
    state.transcriptHydrationEntries.get("item-1").text,
    "Hello",
    "text must be left alone so an authoritative fetch can repair it"
  );
});

// Divergence (same range, different bytes) means our copy is wrong. Keeping or
// extending it would preserve corruption.
test("a delta whose overlap disagrees with our text is refused", () => {
  const state = seededState({ text: "Hello XXXXX" });

  const applied = appendTranscriptDelta(state, {
    thread_id: "thread-1",
    item_id: "item-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  assert.equal(applied, false);
  assert.equal(state.transcriptHydrationEntries.get("item-1").text, "Hello XXXXX");
});

// Command output carries no offset (the relay inserts separators server-side), so it
// keeps the append-only path.
test("an offset-less delta still appends", () => {
  const state = seededState({ text: "line 1" });

  appendTranscriptDelta(state, {
    thread_id: "thread-1",
    item_id: "item-1",
    delta: "\nline 2",
    delta_kind: "command_output",
  });

  assert.equal(state.transcriptHydrationEntries.get("item-1").text, "line 1\nline 2");
});
