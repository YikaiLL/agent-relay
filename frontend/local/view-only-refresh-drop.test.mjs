import test from "node:test";
import assert from "node:assert/strict";

import { mergeRefreshedViewOnlyPage } from "./view-only-thread.js";

// The bug this pins, reported as "sometimes it loses my own message".
//
// While a viewed thread is working, `shouldRefreshViewedThread` refetches its
// tail every 300ms. `mergeRefreshedViewOnlyPage` only preserves what the pin
// already holds when `historyExtended` is true -- i.e. only after the reader has
// scrolled up and paged in older history. In the ordinary case, where nobody
// scrolled, it returns `entries: freshEntries` WHOLESALE.
//
// So every 300ms the pin's live tail is replaced by a server page that may not
// have caught up yet, and anything the delta stream appended in between is
// gone. The user's just-sent message is the most visible casualty because it is
// the newest entry in the pin and the likeliest to be missing from a page that
// was built moments earlier.
test("a refresh must not drop entries the stream already appended", () => {
  const pin = {
    threadId: "thread-1",
    historyExtended: false, // nobody scrolled up -- the ordinary case
    olderCursor: null,
    entries: [
      { item_id: "a", kind: "agent_text", text: "earlier reply" },
      { item_id: "mine", kind: "user_text", text: "my question" },
      { item_id: "b", kind: "agent_text", text: "streaming answ", status: "running" },
    ],
  };

  // The server page was built before the last two arrived.
  const merged = mergeRefreshedViewOnlyPage(pin, {
    thread_id: "thread-1",
    entries: [{ item_id: "a", kind: "agent_text", text: "earlier reply" }],
    prev_cursor: null,
  });

  const ids = merged.entries.map((entry) => entry.item_id);
  assert.ok(ids.includes("mine"), "the user's own message must survive a tail refresh");
  assert.ok(ids.includes("b"), "and so must the reply that was streaming into it");
});

// The bound the old gate was really for, kept: transport pages are byte-sized
// while dozens of adjacent tool calls collapse into one visual row, so
// retaining every older page forever would grow the window without limit for a
// reader who never scrolled. It is the OLD end that gets trimmed now.
test("a reader who never scrolled does not accumulate old history", () => {
  const pin = {
    threadId: "thread-1",
    historyExtended: false,
    entries: [
      { item_id: "ancient", entry_seq: 1 },
      { item_id: "shared", entry_seq: 2 },
      { item_id: "streamed", entry_seq: 3 },
    ],
  };

  const merged = mergeRefreshedViewOnlyPage(pin, {
    thread_id: "thread-1",
    entries: [{ item_id: "shared", entry_seq: 2 }],
    prev_cursor: "c1",
  });

  assert.deepEqual(
    merged.entries.map((e) => e.item_id),
    ["shared", "streamed"],
    "the page's window plus what the stream appended after it — no older prefix"
  );
});

// And a reader who DID scroll keeps the history they paged in, which is what
// the gate protected in the first place.
test("a reader who scrolled keeps their history and their live tail", () => {
  const pin = {
    threadId: "thread-1",
    historyExtended: true,
    olderCursor: "c0",
    entries: [
      { item_id: "paged-in", entry_seq: 1 },
      { item_id: "shared", entry_seq: 2 },
      { item_id: "streamed", entry_seq: 3 },
    ],
  };

  const merged = mergeRefreshedViewOnlyPage(pin, {
    thread_id: "thread-1",
    entries: [{ item_id: "shared", entry_seq: 2 }],
    prev_cursor: "c1",
  });

  assert.deepEqual(merged.entries.map((e) => e.item_id), ["paged-in", "shared", "streamed"]);
  assert.equal(merged.olderCursor, "c0", "their own cursor, not the tail page's");
});

// An empty page used to wipe the conversation outright.
test("an empty page leaves the pin alone", () => {
  const pin = { threadId: "thread-1", entries: [{ item_id: "a" }], historyExtended: false };
  const merged = mergeRefreshedViewOnlyPage(pin, { thread_id: "thread-1", entries: [] });
  assert.deepEqual(merged.entries.map((e) => e.item_id), ["a"]);
});

// ---- a refused delta has to say so -----------------------------------------

// The active thread has had precise gap repair all along: when
// `resolveDeltaAppend` refuses a chunk, the entry is downgraded to `preview`
// (transcript-hydration-store.js:829-835), which makes the tail look
// non-authoritative and re-arms hydration on the very next render.
//
// The pin's reducer refused the same chunk and then returned the pin unchanged,
// deferring to "its next authoritative refresh". That used to be the 300ms
// poll. With the poll gone it is the end of the turn, so a hole that the
// conversation repairs in one frame sat there for the rest of the run. Two
// answers to one question; this makes it one.
const { applyDeltaToViewOnlyPin } = await import("./view-only-thread.js");

function pinWith(text) {
  return {
    threadId: "thread-1",
    entries: [{ item_id: "a1", kind: "agent_text", text, status: "running" }],
  };
}

test("a delta refused for a gap marks the pin's tail as needing repair", () => {
  const pin = pinWith("hello");

  // offset 400 with only 5 characters held: the text in between never arrived.
  const next = applyDeltaToViewOnlyPin(pin, {
    thread_id: "thread-1",
    item_id: "a1",
    delta: "world",
    text_offset: 400,
  });

  assert.notEqual(next, pin, "a refusal is a state change, not a no-op");
  assert.equal(next.tailGap, true, "so the refresh decision can act on it now");
  assert.equal(
    next.entries[0].content_state,
    "preview",
    "and the body is marked non-authoritative, as the conversation marks it"
  );
  assert.equal(next.entries[0].text, "hello", "refusing must never splice");
});

// A re-delivered chunk is not a gap. Treating it as one would refetch on every
// duplicate the stream replays, which it does routinely after a snapshot.
test("a pure duplicate is still a silent no-op", () => {
  const pin = pinWith("hello");

  const next = applyDeltaToViewOnlyPin(pin, {
    thread_id: "thread-1",
    item_id: "a1",
    delta: "hel",
    text_offset: 0,
  });

  assert.equal(next, pin, "identical text already held — nothing happened");
});

test("a normal contiguous delta does not mark a gap", () => {
  const pin = pinWith("hello");

  const next = applyDeltaToViewOnlyPin(pin, {
    thread_id: "thread-1",
    item_id: "a1",
    delta: " world",
    text_offset: 5,
  });

  assert.equal(next.entries[0].text, "hello world");
  assert.notEqual(next.tailGap, true);
});
