import test from "node:test";
import assert from "node:assert/strict";

import { selectHydrationSnapshot } from "./hydration.js";
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
