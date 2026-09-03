import assert from "node:assert/strict";
import test from "node:test";

import {
  countTranscriptEntryDeltas,
  findReducerAppliedCrossing,
  findLiveDomNodeEvidence,
  parseSseEventBlock,
  PREVIEW_CAP,
  rectIntersectsViewport,
} from "./browser-cursor-active-tail-e2e.mjs";

test("parseSseEventBlock returns the event name and joined data payload", () => {
  assert.deepEqual(
    parseSseEventBlock([
      "event: session",
      "data: {\"active_thread_id\":\"thread-1\",",
      "data: \"active_turn_id\":\"turn-1\"}",
    ].join("\n")),
    {
      type: "session",
      data: "{\"active_thread_id\":\"thread-1\",\n\"active_turn_id\":\"turn-1\"}",
    }
  );
});

test("countTranscriptEntryDeltas keys off the SSE event name, not JSON kind", () => {
  // The relay emits `event: transcript_entry_delta` with a payload that has
  // `delta_kind` / `item_id` and no `kind` field.  Counting `obj.kind` is how
  // the first recorded run reported deltaCount: 0 while the stream was live.
  const frames = [
    "event: session",
    "data: {\"kind\":\"session\",\"active_thread_id\":\"t\"}",
    "",
    "event: transcript_entry_delta",
    "data: {\"item_id\":\"acp-msg-9\",\"delta_kind\":\"agent_text\",\"delta\":\"hello\"}",
    "",
    "event: transcript_entry_delta",
    "data: {\"item_id\":\"acp-msg-9\",\"delta_kind\":\"agent_text\",\"delta\":\" world\"}",
    "",
  ].join("\n");

  const counted = countTranscriptEntryDeltas(frames);
  assert.equal(counted.count, 2);
  assert.equal(counted.lastItemId, "acp-msg-9");
});

test("countTranscriptEntryDeltas ignores a JSON kind that is not the SSE event", () => {
  const frames = [
    "event: session",
    "data: {\"kind\":\"transcript_entry_delta\",\"item_id\":\"nope\"}",
    "",
  ].join("\n");
  assert.equal(countTranscriptEntryDeltas(frames).count, 0);
});

test("rectIntersectsViewport rejects a nonzero rect entirely above the viewport", () => {
  // The first recorded run treated top: -5208 / height: 85 as visible.
  assert.equal(
    rectIntersectsViewport({ top: -5208, left: 0, width: 400, height: 85 }, { width: 1280, height: 900 }),
    false
  );
});

test("rectIntersectsViewport accepts a rect that overlaps the viewport", () => {
  assert.equal(
    rectIntersectsViewport({ top: 200, left: 40, width: 600, height: 120 }, { width: 1280, height: 900 }),
    true
  );
});

test("findReducerAppliedCrossing requires one accepted delta that itself crosses the cap", () => {
  // SSE-counted growth and hydration-only jumps are not this observation:
  // only a reducer-applied before/after pair that straddles PREVIEW_CAP counts.
  assert.equal(
    findReducerAppliedCrossing([
      { itemId: "item-1", textLengthBefore: 100, textLengthAfter: 400 },
      { itemId: "item-1", textLengthBefore: 1700, textLengthAfter: 1900 },
    ]),
    null
  );
  assert.deepEqual(
    findReducerAppliedCrossing([
      { itemId: "item-1", textLengthBefore: 100, textLengthAfter: 400 },
      { itemId: "item-1", textLengthBefore: 1500, textLengthAfter: PREVIEW_CAP + 80 },
    ]),
    { itemId: "item-1", textLengthBefore: 1500, textLengthAfter: PREVIEW_CAP + 80 }
  );
});

test("findLiveDomNodeEvidence requires one element instance on both sides of the cap", () => {
  const base = {
    itemId: "item-1",
    documentUid: "doc-1",
    activeThreadId: "thread-1",
    activeTurnId: "turn-1",
    inViewport: true,
  };

  assert.equal(
    findLiveDomNodeEvidence(
      [
        { ...base, nodeUid: "node-a", textLength: PREVIEW_CAP, sampledAt: 1 },
        {
          ...base,
          nodeUid: "node-b",
          textLength: PREVIEW_CAP + 1,
          sampledAt: 2,
          postActiveThreadId: "thread-1",
          postActiveTurnId: "turn-1",
        },
      ],
      {
        itemId: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        documentUid: "doc-1",
        requirePostSampleLive: true,
      }
    ),
    null,
    "item id continuity is not enough when React replaced the DOM node"
  );

  assert.deepEqual(
    findLiveDomNodeEvidence(
      [
        { ...base, nodeUid: "node-a", textLength: PREVIEW_CAP, sampledAt: 1 },
        {
          ...base,
          nodeUid: "node-a",
          textLength: PREVIEW_CAP + 1,
          sampledAt: 2,
          postActiveThreadId: "thread-1",
          postActiveTurnId: "turn-1",
        },
      ],
      {
        itemId: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        documentUid: "doc-1",
        requirePostSampleLive: true,
      }
    ),
    {
      below: { ...base, nodeUid: "node-a", textLength: PREVIEW_CAP, sampledAt: 1 },
      above: {
        ...base,
        nodeUid: "node-a",
        textLength: PREVIEW_CAP + 1,
        sampledAt: 2,
        postActiveThreadId: "thread-1",
        postActiveTurnId: "turn-1",
      },
    }
  );
});

test("findLiveDomNodeEvidence rejects samples that were not live when captured", () => {
  const notLiveUntilLater = [
    {
      itemId: "item-1",
      nodeUid: "node-a",
      textLength: PREVIEW_CAP,
      sampledAt: 1,
      inViewport: true,
      documentUid: "doc-1",
      activeThreadId: "thread-1",
      activeTurnId: null,
    },
    {
      itemId: "item-1",
      nodeUid: "node-a",
      textLength: PREVIEW_CAP + 1,
      sampledAt: 2,
      inViewport: true,
      documentUid: "doc-1",
      activeThreadId: "thread-1",
      activeTurnId: "turn-1",
      postActiveThreadId: "thread-1",
      postActiveTurnId: "turn-1",
    },
  ];

  assert.equal(
    findLiveDomNodeEvidence(notLiveUntilLater, {
      itemId: "item-1",
      threadId: "thread-1",
      turnId: "turn-1",
      documentUid: "doc-1",
      requirePostSampleLive: true,
    }),
    null,
    "a later live poll must not relabel older DOM samples as live"
  );
});

test("findLiveDomNodeEvidence requires the post-sample relay state for above-cap proof", () => {
  const base = {
    itemId: "item-1",
    nodeUid: "node-a",
    documentUid: "doc-1",
    activeThreadId: "thread-1",
    activeTurnId: "turn-1",
    inViewport: true,
  };

  assert.equal(
    findLiveDomNodeEvidence(
      [
        { ...base, textLength: PREVIEW_CAP, sampledAt: 1 },
        {
          ...base,
          textLength: PREVIEW_CAP + 1,
          sampledAt: 2,
          postActiveThreadId: "thread-1",
          postActiveTurnId: null,
        },
      ],
      {
        itemId: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        documentUid: "doc-1",
        requirePostSampleLive: true,
      }
    ),
    null,
    "post-turn hydration must not pass with a stale pre-sample activeTurnId"
  );
});
