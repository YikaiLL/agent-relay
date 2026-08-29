import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHydratedTranscriptProgress,
  createMergedTranscriptHydrationPagePatch,
  prepareTranscriptHydrationState,
  restoreHydratedTranscriptSnapshot,
} from "./shared/transcript-hydration-store.js";

function hydratedState(overrides = {}) {
  return {
    session: {
      active_thread_id: "thread-1",
      transcript_revision: 10,
    },
    transcriptHydrationBaseSnapshot: {
      active_thread_id: "thread-1",
      transcript_revision: 10,
    },
    transcriptHydrationEntries: new Map([
      [
        "item-1",
        {
          item_id: "item-1",
          kind: "user_text",
          text: "older prompt",
          status: "completed",
          turn_id: "turn-1",
          tool: null,
        },
      ],
      [
        "item-2",
        {
          item_id: "item-2",
          kind: "agent_text",
          text: "older reply",
          status: "completed",
          turn_id: "turn-2",
          tool: null,
        },
      ],
      [
        "item-3",
        {
          item_id: "item-3",
          kind: "command",
          text: `cargo test\n${"passed ".repeat(400)}`,
          status: "running",
          turn_id: "turn-3",
          tool: null,
        },
      ],
    ]),
    transcriptHydrationOrder: ["item-1", "item-2", "item-3"],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationPromise: null,
    transcriptHydrationSignature: "thread-1|turn-3|1|item-3|command|turn-3||||",
    transcriptHydrationStatus: "complete",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "thread-1",
    ...overrides,
  };
}

test("restoreHydratedTranscriptSnapshot keeps older hydrated entries for compact same-thread snapshots", () => {
  const state = hydratedState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-3",
    transcript_revision: 11,
    transcript_truncated: true,
    pending_approvals: [{ request_id: "approval-1" }],
    transcript: [
      {
        item_id: "item-3",
        kind: "command",
        text: "cargo test\npassed ...",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
      },
    ],
  };

  const restored = restoreHydratedTranscriptSnapshot(state, snapshot);

  assert.deepEqual(
    restored.transcript.map((entry) => entry.item_id),
    ["item-1", "item-2", "item-3"]
  );
  assert.equal(restored.pending_approvals[0].request_id, "approval-1");
  assert.equal(restored.transcript.at(-1).status, "completed");
  assert.match(restored.transcript.at(-1).text, /passed passed/);
  assert.equal(restored.transcript_truncated, false);
});

test("restoreHydratedTranscriptSnapshot hides an uncovered emergency shell until hydration", () => {
  const state = hydratedState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-4",
    transcript_revision: 12,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-3",
        kind: "command",
        text: "cargo test\npassed ...",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
        content_state: "preview",
      },
      {
        item_id: "item-4",
        kind: "agent_text",
        // The relay clipped this to a 24-char identity shell and marked it
        // omitted; the trailing "..." is NOT what classifies it.
        text: "The relay boots with ...",
        status: "completed",
        turn_id: "turn-4",
        tool: null,
        content_state: "omitted",
      },
    ],
  };

  const restored = restoreHydratedTranscriptSnapshot(state, snapshot);
  const newEntry = restored.transcript.find((entry) => entry.item_id === "item-4");

  assert.ok(newEntry, "the new entry identity must remain visible for ordering and status");
  assert.equal(newEntry.text, null, "the clipped shell must not be rendered as message content");
  assert.equal(newEntry.content_state, "omitted", "the omitted state must survive for the renderer");
  assert.equal(
    restored.transcript_truncated,
    true,
    "the snapshot must stay truncated so the authoritative page is fetched"
  );
});

test("prepareTranscriptHydrationState patches compact tail without clearing same-thread visible history", () => {
  const state = hydratedState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-3",
    transcript_revision: 12,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-3",
        kind: "command",
        text: "cargo test\npassed ...",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
      },
      {
        item_id: "item-4",
        kind: "agent_text",
        text: "done",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);
  Object.assign(state, prepared.patch);

  assert.equal(prepared.shouldHydrate, false);
  assert.deepEqual(state.transcriptHydrationOrder, ["item-1", "item-2", "item-3", "item-4"]);
  assert.equal(state.transcriptHydrationEntries.get("item-3").status, "completed");
  assert.match(state.transcriptHydrationEntries.get("item-3").text, /passed passed/);
  assert.equal(state.transcriptHydrationEntries.get("item-4").text, "done");
});

test("buildHydratedTranscriptProgress still merges history when live revision has advanced", () => {
  const state = hydratedState({
    session: {
      active_thread_id: "thread-1",
      transcript_revision: 20,
    },
    transcriptHydrationBaseSnapshot: {
      active_thread_id: "thread-1",
      active_turn_id: "turn-3",
      transcript_revision: 10,
      transcript_truncated: true,
      transcript: [
        {
          item_id: "item-3",
          kind: "command",
          text: "cargo test\npassed ...",
          status: "running",
          turn_id: "turn-3",
          tool: null,
        },
      ],
    },
  });

  const progress = buildHydratedTranscriptProgress(state);

  assert.deepEqual(
    progress.transcript.map((entry) => entry.item_id),
    ["item-1", "item-2", "item-3"]
  );
  assert.match(progress.transcript.at(-1).text, /passed passed/);
});

test("buildHydratedTranscriptProgress preserves live session metadata", () => {
  const state = hydratedState({
    session: {
      active_thread_id: "thread-1",
      transcript_revision: 20,
      pending_approvals: [{ request_id: "approval-1" }],
    },
    transcriptHydrationBaseSnapshot: {
      active_thread_id: "thread-1",
      active_turn_id: "turn-3",
      transcript_revision: 10,
      transcript_truncated: true,
      transcript: [
        {
          item_id: "item-3",
          kind: "command",
          text: "cargo test\npassed ...",
          status: "running",
          turn_id: "turn-3",
          tool: null,
        },
      ],
    },
  });

  const progress = buildHydratedTranscriptProgress(state);

  assert.equal(progress.pending_approvals[0].request_id, "approval-1");
  assert.equal(progress.transcript_revision, 20);
});

test("buildHydratedTranscriptProgress returns null when thread ids differ", () => {
  const state = hydratedState({
    session: {
      active_thread_id: "thread-2",
    },
  });

  const progress = buildHydratedTranscriptProgress(state);

  assert.equal(progress, null);
});

test("prepareTranscriptHydrationState re-arms hydration when a new oversized entry joins a hydrated thread", () => {
  // Already hydrated (tailReady) — exactly the steady state a few hundred ms into
  // a turn. A new, truncated final message must re-arm the fetch path even though
  // the thread was previously "complete".
  const state = hydratedState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-3",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-3",
        kind: "command",
        text: "cargo test\npassed ...",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
        content_state: "preview",
      },
      {
        item_id: "item-final",
        kind: "agent_text",
        text: `${"Z".repeat(1200)}...`,
        status: "completed",
        turn_id: "turn-3",
        tool: null,
        content_state: "preview",
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);

  assert.equal(prepared.shouldHydrate, true);
  assert.equal(prepared.alreadyComplete, false);
  assert.equal(prepared.existingPromise, null);
  // The fetch path is re-armed...
  assert.equal(prepared.patch.transcriptHydrationTailReady, false);
  // ...without discarding the already-hydrated history (instant render).
  assert.deepEqual(prepared.patch.transcriptHydrationOrder, [
    "item-1",
    "item-2",
    "item-3",
    "item-final",
  ]);
});

test("prepareTranscriptHydrationState re-arms the newest entry even when a prior fetch left its promise parked", () => {
  // Regression: the in-flight guard that fixed the freeze keyed off
  // `transcriptHydrationPromise != null` as well as status. But a tail fetch's
  // promise is only cleared when its signature still matches
  // (createClearedTranscriptHydrationPromisePatch). When a NEW (newest) message
  // joins while a fetch is in flight, the signature changes, so on settle the
  // promise is never cleared — it leaks. Status, however, settles to
  // complete/idle (no fetch is actually running). If a parked promise can veto
  // re-arming, the newest message never fetches its full text and is stuck on the
  // `...` preview/omitted shell forever. A settled status (NOT "loading") must
  // re-arm regardless of a leftover promise.
  const state = hydratedState({
    transcriptHydrationPromise: Promise.resolve(),
    transcriptHydrationStatus: "complete",
  });
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-4",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-3",
        kind: "command",
        text: "cargo test\npassed ...",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
        content_state: "preview",
      },
      {
        item_id: "item-omitted",
        kind: "agent_text",
        text: "The relay boots with ...",
        status: "completed",
        turn_id: "turn-4",
        tool: null,
        content_state: "omitted",
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);

  assert.equal(
    prepared.shouldHydrate,
    true,
    "a settled (non-loading) status must re-arm the newest entry even with a leftover promise"
  );
  assert.equal(prepared.alreadyComplete, false);
  assert.equal(prepared.existingPromise, null);
  assert.equal(prepared.patch.transcriptHydrationTailReady, false);
});

test("prepareTranscriptHydrationState does not re-hydrate when only an existing entry's preview shrinks", () => {
  // Same shape as the signature already on file (single item-3), only the
  // compacted preview text differs. The cached full text already covers it, so
  // no re-fetch — this is what keeps repeated snapshots of one turn loop-safe.
  const state = hydratedState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-3",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-3",
        kind: "command",
        text: "cargo test\npa ...",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);

  assert.equal(prepared.shouldHydrate, false);
  assert.equal(prepared.alreadyComplete, true);
});

test("prepareTranscriptHydrationState re-arms hydration when an OMITTED entry joins a hydrated thread (live path)", () => {
  // Live path: a fully-hydrated, "complete" thread receives a new entry the relay
  // dropped to an identity shell (content_state omitted). It must re-arm the
  // fetch path, keep the already-visible history, and present the omitted entry
  // with no body so the renderer shows a loading placeholder (not the shell).
  const state = hydratedState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-4",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-3",
        kind: "command",
        text: "cargo test\npassed ...",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
        content_state: "preview",
      },
      {
        item_id: "item-omitted",
        kind: "agent_text",
        // 24-char identity shell text the relay shipped; must never render.
        text: "The relay boots with ...",
        status: "completed",
        turn_id: "turn-4",
        tool: null,
        content_state: "omitted",
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);

  assert.equal(prepared.shouldHydrate, true);
  assert.equal(prepared.alreadyComplete, false);
  assert.equal(prepared.existingPromise, null);
  assert.equal(prepared.patch.transcriptHydrationTailReady, false);
  // History preserved + omitted entry appended in order.
  assert.deepEqual(prepared.patch.transcriptHydrationOrder, [
    "item-1",
    "item-2",
    "item-3",
    "item-omitted",
  ]);
  // The omitted entry's clipped shell text is dropped so the renderer shows a
  // loading placeholder, while identity/status/state survive for in-place
  // replacement after hydration.
  const omitted = prepared.patch.transcriptHydrationEntries.get("item-omitted");
  assert.equal(omitted.text, null);
  assert.equal(omitted.content_state, "omitted");
  assert.equal(omitted.status, "completed");
});

test("prepareTranscriptHydrationState does not re-fetch a still-omitted tail again at the same revision", () => {
  // candidate #3: a long entry the relay keeps shipping omitted while it streams
  // bumps transcript_revision on every delta. Re-fetching is useful once per
  // revision (it pulls the latest partial full text), but the settle of one fetch
  // re-fires onProgress -> renderSession -> hydrate at the SAME revision, and
  // status-only snapshots re-describe the same omitted tail. Those must NOT re-arm
  // an identical fetch — that is an RTT-paced storm against the relay.
  const state = hydratedState({
    transcriptHydrationEntries: new Map([
      [
        "item-x",
        {
          item_id: "item-x",
          kind: "agent_text",
          text: null,
          status: "running",
          turn_id: "turn-9",
          tool: null,
          content_state: "omitted",
        },
      ],
    ]),
    transcriptHydrationOrder: ["item-x"],
    transcriptHydrationSignature: "thread-1|turn-9|1|item-x|agent_text|turn-9||||",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationFetchedRevision: 30,
  });
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-9",
    transcript_revision: 30,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-x",
        kind: "agent_text",
        text: "shell...",
        status: "running",
        turn_id: "turn-9",
        tool: null,
        content_state: "omitted",
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);

  assert.equal(
    prepared.shouldHydrate,
    false,
    "already fetched at this revision — a still-omitted tail must not re-fetch until the revision advances"
  );
});

test("prepareTranscriptHydrationState re-fetches the omitted tail once the revision advances, recording it", () => {
  const state = hydratedState({
    transcriptHydrationEntries: new Map([
      [
        "item-x",
        {
          item_id: "item-x",
          kind: "agent_text",
          text: null,
          status: "running",
          turn_id: "turn-9",
          tool: null,
          content_state: "omitted",
        },
      ],
    ]),
    transcriptHydrationOrder: ["item-x"],
    transcriptHydrationSignature: "thread-1|turn-9|1|item-x|agent_text|turn-9||||",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationFetchedRevision: 30,
  });
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-9",
    transcript_revision: 31,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-x",
        kind: "agent_text",
        text: "shell...",
        status: "running",
        turn_id: "turn-9",
        tool: null,
        content_state: "omitted",
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);

  assert.equal(
    prepared.shouldHydrate,
    true,
    "a bumped revision means new data — re-fetch the latest partial"
  );
  assert.equal(
    prepared.patch.transcriptHydrationFetchedRevision,
    31,
    "the fetched revision is recorded so same-revision settles don't re-fetch"
  );
});

test("prepareTranscriptHydrationState does not hydrate when a new FULL entry ending in '...' joins", () => {
  // P1.2: a genuine, complete message whose text legitimately ends in "..." is
  // content_state full. Adding it to a hydrated thread must NOT trigger a wasteful
  // re-fetch, and its text must be preserved verbatim (never nulled/treated as a
  // shell), even though the snapshot is flagged truncated for other reasons.
  const state = hydratedState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-4",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-3",
        kind: "command",
        text: "cargo test\npassed ...",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
        content_state: "preview",
      },
      {
        item_id: "item-trailing",
        kind: "agent_text",
        text: "All set. Let me know if you want more...",
        status: "completed",
        turn_id: "turn-4",
        tool: null,
        content_state: "full",
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);

  assert.equal(prepared.shouldHydrate, false, "a full '...'-ending entry must not re-hydrate");
  const full = prepared.patch.transcriptHydrationEntries.get("item-trailing");
  assert.equal(full.text, "All set. Let me know if you want more...");
  assert.equal(full.content_state, "full");
});

test("re-hydrates when an already-hydrated full-but-partial entry is later compacted to omitted (streaming settle)", () => {
  // Review finding F1: content_state `full` means "complete as of this
  // revision", not "final". An entry hydrated mid-stream as full+partial, then
  // later shelled to `omitted` by the server (its body grew/over budget), must
  // re-hydrate — not stay frozen on the stale partial body promoted back to full.
  const state = hydratedState({
    transcriptHydrationEntries: new Map([
      [
        "item-x",
        {
          item_id: "item-x",
          kind: "agent_text",
          text: "PARTIAL",
          status: "running",
          turn_id: "turn-9",
          tool: null,
          content_state: "full",
        },
      ],
    ]),
    transcriptHydrationOrder: ["item-x"],
    transcriptHydrationSignature: "thread-1|turn-9|1|item-x|agent_text|turn-9||||",
  });
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-9",
    transcript_revision: 30,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-x",
        kind: "agent_text",
        text: "PARTIALplusmuchmore th...",
        status: "completed",
        turn_id: "turn-9",
        tool: null,
        content_state: "omitted",
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);
  Object.assign(state, prepared.patch);

  assert.equal(prepared.shouldHydrate, true, "an omitted same-id transition must re-hydrate");
  assert.equal(prepared.alreadyComplete, false);
  // The clipped shell text must never become the rendered body.
  const merged = state.transcriptHydrationEntries.get("item-x");
  assert.notEqual(merged.text, "PARTIALplusmuchmore th...");
});

test("a longer preview replaces a stale shorter cached body and re-hydrates", () => {
  // Review finding F1 (preview variant): a stale, shorter cached `full` body must
  // not win over the server's newer, longer preview, and the entry must still
  // re-hydrate for the remaining text.
  const state = hydratedState({
    transcriptHydrationEntries: new Map([
      [
        "item-x",
        {
          item_id: "item-x",
          kind: "agent_text",
          text: "short",
          status: "running",
          turn_id: "turn-9",
          tool: null,
          content_state: "full",
        },
      ],
    ]),
    transcriptHydrationOrder: ["item-x"],
    transcriptHydrationSignature: "thread-1|turn-9|1|item-x|agent_text|turn-9||||",
  });
  const longPreview = `${"Z".repeat(1200)}...`;
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-9",
    transcript_revision: 30,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-x",
        kind: "agent_text",
        text: longPreview,
        status: "running",
        turn_id: "turn-9",
        tool: null,
        content_state: "preview",
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);
  Object.assign(state, prepared.patch);

  assert.equal(prepared.shouldHydrate, true, "a longer preview over a stale cache must re-hydrate");
  assert.equal(
    state.transcriptHydrationEntries.get("item-x").text,
    longPreview,
    "the longer preview must win over the stale shorter cached body"
  );
});

// --- entry ORDER (Bug A) ----------------------------------------------------
//
// `transcriptHydrationOrder` is the ONLY thing that decides render order — there
// is no comparator anywhere on the render path, and `TranscriptEntryView` carries
// no seq/timestamp for settled entries. Three writers feed that array (tail page
// merge, snapshot tail merge, live SSE delta), and they used to disagree about
// where a late-arriving id belongs. These tests pin the conversation order the
// server actually reported.

function orderedEntry(itemId, kind, text, turnId, overrides = {}) {
  return {
    item_id: itemId,
    kind,
    text,
    status: "completed",
    turn_id: turnId,
    tool: null,
    content_state: "full",
    ...overrides,
  };
}

test("a user message that settles AFTER its reply already streamed still renders above it", () => {
  // The SSE delta stream and the snapshot stream are independent, so the
  // agent_text delta for turn 2's reply can join the window BEFORE the settled
  // user_text that triggered it ever appears in a snapshot. (This is the review
  // post-back shape: the relay injects the user message server-side while the
  // reply is already streaming.) Appending that late user message at the tail is
  // what rendered it BELOW its own reply. The snapshot's transcript IS the
  // server's authoritative order, so a genuinely-new id must be spliced in where
  // the snapshot puts it, not blindly at the end.
  const streamingReply = orderedEntry("a2", "agent_text", "Test suite is green", "turn-2", {
    status: "running",
  });
  const state = {
    session: { active_thread_id: "thread-1", transcript_revision: 10 },
    transcriptHydrationBaseSnapshot: { active_thread_id: "thread-1" },
    transcriptHydrationEntries: new Map([
      ["u1", orderedEntry("u1", "user_text", "first prompt", "turn-1")],
      ["a1", orderedEntry("a1", "agent_text", "first reply", "turn-1")],
      // a2 arrived over SSE before any snapshot carried u2.
      ["a2", streamingReply],
    ]),
    transcriptHydrationOrder: ["u1", "a1", "a2"],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationPromise: null,
    transcriptHydrationSignature: "thread-1|turn-1|stale",
    transcriptHydrationStatus: "complete",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "thread-1",
  };
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-2",
    transcript_revision: 11,
    transcript_truncated: true,
    transcript: [
      orderedEntry("u1", "user_text", "first prompt", "turn-1"),
      orderedEntry("a1", "agent_text", "first reply", "turn-1"),
      orderedEntry("u2", "user_text", "Run the relay-server test suite", "turn-2"),
      streamingReply,
    ],
  };

  // The immediate render overlay must already be in conversation order...
  const rendered = restoreHydratedTranscriptSnapshot(state, snapshot);
  assert.deepEqual(
    rendered.transcript.map((entry) => entry.item_id),
    ["u1", "a1", "u2", "a2"],
    "the settled user message must render ABOVE the reply it triggered"
  );

  // ...and so must the merged window every later render reads back.
  const prepared = prepareTranscriptHydrationState(state, snapshot);
  Object.assign(state, prepared.patch);
  assert.deepEqual(
    state.transcriptHydrationOrder,
    ["u1", "a1", "u2", "a2"],
    "the merged window keeps the server's order, not transport-arrival order"
  );
});

test("a tail page merges into the loaded window instead of replacing its order", () => {
  // `createMergedTranscriptHydrationPagePatch` used to RESET order to the page's
  // ids on a non-prepend (tail) merge while `entries` kept everything. Anything
  // the page did not carry — older history the reader scrolled in, or an id a
  // live SSE delta had just appended — was orphaned in the map: still present,
  // never rendered again, and unrecoverable, because both re-add sites only fire
  // for ids that are NEW to `entries`.
  const state = {
    transcriptHydrationEntries: new Map([
      ["old-1", orderedEntry("old-1", "user_text", "scrolled-in prompt", "turn-0")],
      ["old-2", orderedEntry("old-2", "agent_text", "scrolled-in reply", "turn-0")],
      ["u1", orderedEntry("u1", "user_text", "prompt", "turn-1")],
      ["a1", orderedEntry("a1", "agent_text", "reply", "turn-1")],
      ["live", orderedEntry("live", "agent_text", "streaming now", "turn-2", { status: "running" })],
    ]),
    transcriptHydrationOrder: ["old-1", "old-2", "u1", "a1", "live"],
    transcriptHydrationOlderCursor: "cursor-older",
    transcriptHydrationSignature: "thread-1|turn-2|sig",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "thread-1",
  };
  const page = {
    thread_id: "thread-1",
    prev_cursor: "cursor-older",
    entries: [
      orderedEntry("u1", "user_text", "prompt", "turn-1"),
      orderedEntry("a1", "agent_text", "reply", "turn-1"),
    ],
  };

  const patch = createMergedTranscriptHydrationPagePatch(state, page, { prepend: false });

  assert.deepEqual(
    patch.transcriptHydrationOrder,
    ["old-1", "old-2", "u1", "a1", "live"],
    "a tail page is authoritative for the ids it carries, not for the whole window"
  );
  assert.equal(
    patch.transcriptHydrationEntries.size,
    5,
    "no entry may be left orphaned in the map without a slot in the order"
  );
});

test("a new user message that OPENS the snapshot tail still lands above its reply", () => {
  // The compacted snapshot carries only the last few entries (8 local / 6 remote,
  // protocol.rs), so a turn's user message can be the FIRST thing in the tail
  // while the reply that follows it is already in the window via a live delta.
  // With no EARLIER tail entry to anchor against, appending at the end of the
  // window puts the user message below its own reply all over again — the same
  // bug, one row further left. Fall back to the first LATER tail id we can locate
  // and land just before it.
  const streamingReply = orderedEntry("a2", "agent_text", "Test suite is green", "turn-2", {
    status: "running",
  });
  const state = {
    session: { active_thread_id: "thread-1", transcript_revision: 10 },
    transcriptHydrationBaseSnapshot: { active_thread_id: "thread-1" },
    transcriptHydrationEntries: new Map([
      ["old-1", orderedEntry("old-1", "agent_text", "older, below the tail window", "turn-0")],
      ["a2", streamingReply],
    ]),
    transcriptHydrationOrder: ["old-1", "a2"],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationPromise: null,
    transcriptHydrationSignature: "thread-1|turn-1|stale",
    transcriptHydrationStatus: "complete",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "thread-1",
  };
  // The tail window has slid forward: it now STARTS with the new user message.
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-2",
    transcript_revision: 11,
    transcript_truncated: true,
    transcript: [
      orderedEntry("u2", "user_text", "Run the relay-server test suite", "turn-2"),
      streamingReply,
    ],
  };

  const rendered = restoreHydratedTranscriptSnapshot(state, snapshot);
  assert.deepEqual(
    rendered.transcript.map((entry) => entry.item_id),
    ["old-1", "u2", "a2"],
    "immediate overlay: the tail-opening user message goes above its reply, below older history"
  );

  const prepared = prepareTranscriptHydrationState(state, snapshot);
  Object.assign(state, prepared.patch);
  assert.deepEqual(
    state.transcriptHydrationOrder,
    ["old-1", "u2", "a2"],
    "merged window: same placement, persisted"
  );
});

test("a tail page that shares nothing with the window keeps the live delta BELOW it", () => {
  // Reviewer open question: what is the invariant when a tail page and the window
  // do not intersect? It is reachable — a thread switch clears the window, a live
  // delta lands before the first page does, and cold hydration then merges a page
  // that predates it. The window cannot be OLDER than a tail page it does not
  // intersect (older pages are only ever prepended onto a window that already
  // holds the tail), so the leftover is the NEWER entry and must stay last.
  const state = {
    transcriptHydrationEntries: new Map([
      ["live", orderedEntry("live", "agent_text", "streaming now", "turn-9", { status: "running" })],
    ]),
    transcriptHydrationOrder: ["live"],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: "thread-1|turn-9|sig",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "thread-1",
  };
  const page = {
    thread_id: "thread-1",
    prev_cursor: null,
    entries: [
      orderedEntry("u1", "user_text", "prompt", "turn-8"),
      orderedEntry("a1", "agent_text", "reply", "turn-8"),
    ],
  };

  const patch = createMergedTranscriptHydrationPagePatch(state, page, { prepend: false });

  assert.deepEqual(
    patch.transcriptHydrationOrder,
    ["u1", "a1", "live"],
    "the live entry is newer than a page it does not intersect, so it stays last"
  );
});

test("a snapshot tail with no anchor at all appends — the window really is older", () => {
  // Pins the invariant behind the asymmetry with mergeTailPageOrder. A snapshot
  // tail is just the last N entries, so an empty intersection with the window is
  // the ordinary "a burst of new entries pushed the whole window out of the tail"
  // case: the window is older and the tail belongs at the end. (The page branch
  // assumes the opposite, for a reason spelled out at that call site.)
  const state = {
    session: { active_thread_id: "thread-1", transcript_revision: 10 },
    transcriptHydrationBaseSnapshot: { active_thread_id: "thread-1" },
    transcriptHydrationEntries: new Map([
      ["e1", orderedEntry("e1", "user_text", "older prompt", "turn-1")],
      ["e2", orderedEntry("e2", "agent_text", "older reply", "turn-1")],
    ]),
    transcriptHydrationOrder: ["e1", "e2"],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationPromise: null,
    transcriptHydrationSignature: "thread-1|turn-1|stale",
    transcriptHydrationStatus: "complete",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "thread-1",
  };
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-2",
    transcript_revision: 11,
    transcript_truncated: true,
    transcript: [
      orderedEntry("e3", "user_text", "next prompt", "turn-2"),
      orderedEntry("e4", "agent_text", "next reply", "turn-2"),
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);
  Object.assign(state, prepared.patch);
  assert.deepEqual(state.transcriptHydrationOrder, ["e1", "e2", "e3", "e4"]);
});

test("a newly sent user message at the end of a compact tail lands at the END of a deep window", () => {
  // The shape a long virtualized thread produces: the window holds the whole
  // conversation, the snapshot carries only the last few entries, and the newest
  // of those is a just-sent user message. It must land at the very end — putting
  // it anywhere else hides it below the fold of a virtualized list.
  const windowIds = Array.from({ length: 30 }, (_, i) => `e${i}`);
  const state = {
    session: { active_thread_id: "thread-1", transcript_revision: 30 },
    transcriptHydrationBaseSnapshot: { active_thread_id: "thread-1" },
    transcriptHydrationEntries: new Map(
      windowIds.map((id, i) => [id, orderedEntry(id, i % 3 === 0 ? "user_text" : "agent_text", `msg ${i}`, `turn-${i}`)])
    ),
    transcriptHydrationOrder: [...windowIds],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationPromise: null,
    transcriptHydrationSignature: "thread-1|stale",
    transcriptHydrationStatus: "complete",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "thread-1",
  };
  const tail = windowIds.slice(-7).map((id, i) =>
    orderedEntry(id, "agent_text", `msg ${23 + i}`, `turn-${23 + i}`)
  );
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-new",
    transcript_revision: 31,
    transcript_truncated: true,
    transcript: [...tail, orderedEntry("sent", "user_text", "ask-user-live", "turn-new")],
  };

  const rendered = restoreHydratedTranscriptSnapshot(state, snapshot);
  assert.equal(
    rendered.transcript.at(-1).item_id,
    "sent",
    "the just-sent message must render as the LAST entry"
  );
  assert.equal(rendered.transcript.length, 31);

  const prepared = prepareTranscriptHydrationState(state, snapshot);
  Object.assign(state, prepared.patch);
  assert.equal(state.transcriptHydrationOrder.at(-1), "sent");
  assert.equal(state.transcriptHydrationOrder.length, 31);
});
