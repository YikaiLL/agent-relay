import test from "node:test";
import assert from "node:assert/strict";

import { hydrateLocalTranscript, selectHydrationSnapshot } from "./hydration.js";
import {
  restoreHydratedTranscript,
  invalidateTranscriptWindowForRepair,
} from "./store.js";
import { prepareTranscriptHydrationState } from "../../shared/transcript-hydration-store.js";

// lifecycle.js:898 used to hydrate from an already-merged snapshot:
// mergeTranscriptEntry promotes a clipped tail entry to `full` when a cached
// full body covers it, so the gate trusted that promotion and never checked the
// cache — even though transcript_truncated was correctly true.

const PREVIEW_CAP = 1600;

function cachedState(chars, overrides = {}) {
  return {
    session: { active_thread_id: "thread-1" },
    rawSessionSnapshot: null,
    transcriptHydrationBaseSnapshot: null,
    transcriptHydrationThreadId: "thread-1",
    transcriptHydrationOrder: ["item-9"],
    transcriptHydrationEntries: new Map([
      [
        "item-9",
        {
          item_id: "item-9",
          kind: "agent_text",
          status: "completed",
          content_state: "full",
          text: "x".repeat(chars),
        },
      ],
    ]),
    transcriptHydrationOlderCursor: null,
    transcriptHydrationPromise: null,
    transcriptHydrationSignature: null,
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationFetchedRevision: null,
    // Already hydrated at an earlier revision — the body predates the turn's end.
    transcriptHydrationBodyRevision: 40,
    ...overrides,
  };
}

function rawSettledSnapshot(overrides = {}) {
  return {
    active_thread_id: "thread-1",
    active_turn_id: null,
    transcript_revision: 41,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-9",
        kind: "agent_text",
        status: "completed",
        content_state: "preview",
        text: "x".repeat(PREVIEW_CAP),
      },
    ],
    ...overrides,
  };
}

test("a snapshot that has been through restoreHydratedTranscript still yields shouldHydrate at turn end", () => {
  const state = cachedState(3000);
  const raw = rawSettledSnapshot();
  state.rawSessionSnapshot = raw;
  const merged = restoreHydratedTranscript(state, raw);

  assert.equal(
    merged.transcript[0].content_state,
    "full",
    "precondition: the merge promoted the clipped tail entry to full"
  );
  assert.equal(
    prepareTranscriptHydrationState(state, merged).shouldHydrate,
    false,
    "precondition: the merged snapshot alone hides the clip from the gate"
  );

  const selected = selectHydrationSnapshot(state, merged);
  assert.equal(
    prepareTranscriptHydrationState(state, selected).shouldHydrate,
    true,
    "the raw snapshot's true preview state must drive the gate, not the merge's promoted full"
  );
});

test("after a lagged-stream repair, hydration fires even mid-turn", () => {
  const state = cachedState(2000, { transcriptHydrationBodyRevision: 41 });
  const raw = rawSettledSnapshot({ active_turn_id: "turn-7" });
  state.rawSessionSnapshot = raw;
  const merged = restoreHydratedTranscript(state, raw);
  assert.equal(
    merged.transcript[0].content_state,
    "full",
    "precondition: the merge promoted the clipped tail entry to full"
  );

  // The delta stream dropped frames: the cache can no longer be trusted, however
  // long it is — mark it non-authoritative the way stream.js does on the
  // transcript_stream_lagged event.
  invalidateTranscriptWindowForRepair(state);

  assert.equal(
    prepareTranscriptHydrationState(state, merged).shouldHydrate,
    false,
    "precondition: the gate checks the already-promoted merged entry first and never reaches the demoted cache"
  );

  const selected = selectHydrationSnapshot(state, merged);
  assert.equal(
    prepareTranscriptHydrationState(state, selected).shouldHydrate,
    true,
    "a lagged-stream repair must force a refetch even while the turn is still running"
  );
});

test("a stashed raw snapshot for a different thread is not used", () => {
  const state = cachedState(3000);
  const staleRawForOtherThread = rawSettledSnapshot({ active_thread_id: "thread-2" });
  state.rawSessionSnapshot = staleRawForOtherThread;

  const currentSession = {
    active_thread_id: "thread-1",
    active_turn_id: null,
    transcript_truncated: false,
  };

  assert.equal(
    selectHydrationSnapshot(state, currentSession),
    currentSession,
    "a raw stash left over from a different thread must never be used to decide this thread's hydration"
  );
});

// --- hydrateLocalTranscript integration: the gate must observe a real fetch ---
//
// The scenarios below call hydrateLocalTranscript (not just the boolean helpers)
// so the regression encodes an actual fetch call rather than a gate predicate.

function makeHydrateState(chars, overrides = {}) {
  return {
    session: { active_thread_id: "thread-1", active_turn_id: null },
    rawSessionSnapshot: null,
    transcriptHydrationBaseSnapshot: null,
    transcriptHydrationThreadId: "thread-1",
    transcriptHydrationOrder: ["item-9"],
    transcriptHydrationEntries: new Map([
      [
        "item-9",
        {
          item_id: "item-9",
          kind: "agent_text",
          status: "completed",
          content_state: "full",
          text: "x".repeat(chars),
        },
      ],
    ]),
    transcriptHydrationOlderCursor: null,
    transcriptHydrationPromise: null,
    transcriptHydrationSignature: "thread-1|prior",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationFetchedRevision: null,
    transcriptHydrationBodyRevision: 40,
    ...overrides,
  };
}

test("hydrateLocalTranscript fires a fetch when the raw snapshot is truncated even though the merged view looks full", async () => {
  // Lifecycle sets state.rawSessionSnapshot = snapshot (pre-merge), then calls
  // restoreHydratedTranscript to get the merged view, then passes the merged view to
  // hydrateLocalTranscript. The gate must reach past the merge and read the raw stash.
  const state = makeHydrateState(3000);
  const raw = rawSettledSnapshot(); // transcript_truncated: true, content_state: "preview"
  state.rawSessionSnapshot = raw;
  const merged = restoreHydratedTranscript(state, raw);

  assert.equal(
    merged.transcript[0].content_state,
    "full",
    "precondition: the merge promoted the clipped entry to full, hiding the truncation"
  );
  assert.equal(
    merged.transcript_truncated,
    true,
    "precondition: the merge still exposes transcript_truncated from the raw source"
  );

  let fetchCalled = false;
  await hydrateLocalTranscript(state, merged, {
    async fetchPage() {
      fetchCalled = true;
      return {
        thread_id: "thread-1",
        prev_cursor: null,
        entries: [
          {
            item_id: "item-9",
            kind: "agent_text",
            status: "completed",
            content_state: "full",
            text: "x".repeat(3000),
          },
        ],
      };
    },
    onProgress(next) {
      state.session = next;
    },
  });

  assert.equal(
    fetchCalled,
    true,
    "the raw snapshot's transcript_truncated must drive a tail fetch even though the merged view's content_state is full"
  );
});

test("hydrateLocalTranscript suppresses the fetch when the input is merged-only and appears full (no raw stash)", async () => {
  // Without rawSessionSnapshot, hydrateLocalTranscript uses the merged view directly.
  // The merged view has content_state: "full" for item-9, so no fetch should fire.
  const state = makeHydrateState(3000);
  // rawSessionSnapshot stays null

  const mergedOnlySnapshot = {
    active_thread_id: "thread-1",
    active_turn_id: null,
    transcript_revision: 41,
    transcript_truncated: false,
    transcript: [
      {
        item_id: "item-9",
        kind: "agent_text",
        status: "completed",
        content_state: "full",
        text: "x".repeat(3000),
      },
    ],
  };

  let fetchCalled = false;
  const result = await hydrateLocalTranscript(state, mergedOnlySnapshot, {
    async fetchPage() {
      fetchCalled = true;
      return { thread_id: "thread-1", prev_cursor: null, entries: [] };
    },
    onProgress(next) {
      state.session = next;
    },
  });

  assert.equal(
    fetchCalled,
    false,
    "a merged-only snapshot with transcript_truncated: false must not trigger a fetch"
  );
  assert.equal(result, null, "no hydration work when already full");
});

test("hydrateLocalTranscript ignores a raw stash from another thread and does not fetch", async () => {
  // state.rawSessionSnapshot belongs to thread-2; the current session is thread-1.
  // selectHydrationSnapshot must discard the cross-thread stash and use the passed
  // snapshot, which is non-truncated — so no fetch should fire.
  const state = makeHydrateState(3000, {
    rawSessionSnapshot: rawSettledSnapshot({ active_thread_id: "thread-2" }),
  });

  const currentMerged = {
    active_thread_id: "thread-1",
    active_turn_id: null,
    transcript_revision: 41,
    transcript_truncated: false,
    transcript: [
      {
        item_id: "item-9",
        kind: "agent_text",
        status: "completed",
        content_state: "full",
        text: "x".repeat(3000),
      },
    ],
  };

  let fetchCalled = false;
  const result = await hydrateLocalTranscript(state, currentMerged, {
    async fetchPage() {
      fetchCalled = true;
      return { thread_id: "thread-1", prev_cursor: null, entries: [] };
    },
    onProgress(next) {
      state.session = next;
    },
  });

  assert.equal(
    fetchCalled,
    false,
    "a raw stash for thread-2 must be discarded; thread-1's non-truncated merged view must not trigger a fetch"
  );
  assert.equal(result, null);
});
