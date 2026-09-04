// Store-level coverage for the patch overlay that replaced writing non-delta
// entry patches directly into the hydration window (see .sealwire/PLAN.md,
// "Invalidate; do not write", and the two P1s it fixes: a status-only patch
// promoting a cached body to `full`, and a patch alone turning an unhydrated
// window "loaded"). Surface-level reproductions of those two P1s live in
// frontend/remote/session-ops.test.mjs and frontend/local/session-stream.test.mjs;
// this file pins the shared primitive's own contract.

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyTranscriptDeltaToWindow,
  applyTranscriptPatchOverlay,
  prepareTranscriptHydrationState,
  renderedTranscriptFromWindow,
} from "./shared/transcript-hydration-store.js";

function loadedWindowState(threadId, entries) {
  return {
    transcriptHydrationThreadId: threadId,
    transcriptHydrationEntries: new Map(entries.map((entry) => [entry.item_id, entry])),
    transcriptHydrationOrder: entries.map((entry) => entry.item_id),
  };
}

test("applyTranscriptPatchOverlay is a no-op on an empty (unloaded) window — it must never be what makes the window look loaded", () => {
  const state = {
    transcriptHydrationThreadId: "thread-1",
    transcriptHydrationEntries: new Map(),
    transcriptHydrationOrder: [],
  };

  const changed = applyTranscriptPatchOverlay(state, "thread-1", {
    item_id: "item-1",
    status: "completed",
    text: "done",
  });

  assert.equal(changed, false);
  assert.equal(state.transcriptHydrationOrder.length, 0);
  assert.equal(state.transcriptHydrationEntries.size, 0);
});

test("applyTranscriptPatchOverlay is a no-op for an item the window has never tracked, even when the window IS loaded for other items", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "item-1", kind: "agent_text", text: "hi", status: "running", turn_id: "turn-1", tool: null, content_state: "full" },
  ]);

  applyTranscriptPatchOverlay(state, "thread-1", { item_id: "item-2", status: "completed", text: "done" });

  assert.equal(state.transcriptHydrationOrder.includes("item-2"), false);
  assert.equal(state.transcriptHydrationEntries.has("item-2"), false);
});

test("applyTranscriptPatchOverlay never touches the cached entry's own content_state — hydration's re-fetch gate keeps reading the real value", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "item-1", kind: "agent_text", text: null, status: "running", turn_id: "turn-1", tool: null, content_state: "omitted" },
  ]);

  applyTranscriptPatchOverlay(state, "thread-1", { item_id: "item-1", status: "completed" });

  assert.equal(state.transcriptHydrationEntries.get("item-1").content_state, "omitted");
});

test("renderedTranscriptFromWindow overlays status/text/tool/turn_id onto the projected entry without mutating the cache", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "item-1", kind: "agent_text", text: "partial", status: "running", turn_id: "turn-1", tool: null, content_state: "preview" },
  ]);

  applyTranscriptPatchOverlay(state, "thread-1", { item_id: "item-1", status: "completed", tool: { name: "done" } });

  const projected = renderedTranscriptFromWindow(state, { active_thread_id: "thread-1" });
  assert.equal(projected[0].status, "completed");
  assert.deepEqual(projected[0].tool, { name: "done" });
  // text was not part of this patch (undefined -> null in the overlay), so the
  // cached body must show through rather than being nulled out.
  assert.equal(projected[0].text, "partial");
  // The cache itself is untouched — only the projection is overlaid.
  assert.equal(state.transcriptHydrationEntries.get("item-1").status, "running");
});

test("a later delta for the same item clears its patch overlay — fresh authoritative data wins, not a stale status", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "item-1", kind: "agent_text", text: "hi", status: "running", turn_id: "turn-1", tool: null, content_state: "full" },
  ]);
  applyTranscriptPatchOverlay(state, "thread-1", { item_id: "item-1", status: "completed" });
  assert.equal(renderedTranscriptFromWindow(state, { active_thread_id: "thread-1" })[0].status, "completed");

  applyTranscriptDeltaToWindow(state, { item_id: "item-1", delta: " there", text_offset: 2, thread_id: "thread-1" });

  const projected = renderedTranscriptFromWindow(state, { active_thread_id: "thread-1" });
  assert.equal(projected[0].status, "running", "the delta's own status must win — the completed overlay is stale now");
  assert.equal(projected[0].text, "hi there");
});

test("an authoritative snapshot/hydration merge for the same item clears its patch overlay", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "item-1", kind: "agent_text", text: "hi", status: "running", turn_id: "turn-1", tool: null, content_state: "full" },
  ]);
  applyTranscriptPatchOverlay(state, "thread-1", { item_id: "item-1", status: "completed" });

  prepareTranscriptHydrationState(state, {
    active_thread_id: "thread-1",
    transcript_truncated: true,
    transcript_revision: 5,
    transcript: [
      { item_id: "item-1", kind: "agent_text", text: "hi", status: "running", turn_id: "turn-1", tool: null, content_state: "full" },
    ],
  });

  assert.equal(state.transcriptPatchOverlay.has("item-1"), false);
});
