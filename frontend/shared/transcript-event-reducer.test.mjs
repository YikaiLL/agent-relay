import test from "node:test";
import assert from "node:assert/strict";

import {
  reduceTranscriptDeltaEvent,
  reduceTranscriptEntryPatchEvent,
} from "./transcript-event-reducer.js";

const SURFACES = [
  {
    name: "Local",
    deltaOptions: {},
    patchOptions: {},
    staleDeltaKind: "append",
    baseGapKind: "append",
    emptyOffsetlessDeltaKind: "noop",
    stalePatchKind: "accepted_patch",
  },
  {
    name: "Remote",
    deltaOptions: {
      rejectStaleRevision: true,
      enforceBaseRevisionWithoutOffset: true,
      useDeltaEventKindFallback: true,
      unknownDeltaKindFallback: "agent_text",
      appendEmptyOffsetlessDelta: true,
    },
    patchOptions: {
      rejectStaleRevision: true,
      enforceBaseRevision: true,
      useEventKindFallback: true,
    },
    staleDeltaKind: "noop",
    baseGapKind: "needs_repair",
    emptyOffsetlessDeltaKind: "append",
    stalePatchKind: "rejected_patch",
  },
];

function session(overrides = {}) {
  return {
    active_thread_id: "thread-1",
    transcript_revision: 1,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "running",
        text: "Hello",
        turn_id: "turn-1",
        tool: null,
      },
    ],
    ...overrides,
  };
}

function delta(overrides = {}) {
  return {
    thread_id: "thread-1",
    base_revision: 1,
    revision: 2,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
    ...overrides,
  };
}

function patch(overrides = {}) {
  return {
    thread_id: "thread-1",
    revision: 2,
    item_id: "item-1",
    entry_kind: "agent_text",
    status: "completed",
    text: "final",
    turn_id: "turn-1",
    ...overrides,
  };
}

function reduceDelta(surface, currentSession, event, extra = {}) {
  return reduceTranscriptDeltaEvent({
    session: currentSession,
    event,
    currentThreadId: currentSession?.active_thread_id || null,
    ...surface.deltaOptions,
    ...extra,
  });
}

function reducePatch(surface, currentSession, event, extra = {}) {
  return reduceTranscriptEntryPatchEvent({
    session: currentSession,
    event,
    currentThreadId: currentSession?.active_thread_id || null,
    ...surface.patchOptions,
    ...extra,
  });
}

function textFor(outcome, itemId = "item-1") {
  return outcome.nextSession?.transcript.find((entry) => entry.item_id === itemId)?.text;
}

test("delta reducer fixtures run under Local and Remote surface policies", async (t) => {
  for (const surface of SURFACES) {
    await t.test(surface.name, () => {
      const contiguous = reduceDelta(surface, session(), delta());
      assert.equal(contiguous.kind, "append");
      assert.equal(contiguous.appendText, " world");
      assert.equal(textFor(contiguous), "Hello world");
      assert.equal(contiguous.nextSession.transcript_revision, 2);

      const partial = reduceDelta(
        surface,
        session({ transcript: [{ ...session().transcript[0], text: "Hello wor" }] }),
        delta()
      );
      assert.equal(partial.kind, "append");
      assert.equal(partial.appendText, "ld");
      assert.equal(textFor(partial), "Hello world");

      const duplicate = reduceDelta(
        surface,
        session({ transcript: [{ ...session().transcript[0], text: "Hello world" }] }),
        delta()
      );
      assert.equal(duplicate.kind, "duplicate");
      assert.equal(duplicate.nextSession, undefined);
      assert.equal(duplicate.nextRevision, 2);

      const mismatch = reduceDelta(
        surface,
        session({ transcript: [{ ...session().transcript[0], text: "Hello XXXXX" }] }),
        delta()
      );
      assert.equal(mismatch.kind, "needs_repair");
      assert.equal(mismatch.reason, "offset_mismatch");
      assert.deepEqual(mismatch.detail, { item: "item-1", offset: 5, have: 11 });

      const gap = reduceDelta(surface, session(), delta({ delta: "again", text_offset: 11 }));
      assert.equal(gap.kind, "needs_repair");
      assert.equal(gap.reason, "offset_gap");
      assert.deepEqual(gap.detail, { item: "item-1", offset: 11, have: 5 });

      const unknownZero = reduceDelta(
        surface,
        session(),
        delta({ item_id: "item-2", entry_seq: 7, delta: "fresh", text_offset: 0 })
      );
      assert.equal(unknownZero.kind, "append");
      assert.equal(unknownZero.unknownItem, true);
      assert.equal(textFor(unknownZero, "item-2"), "fresh");
      assert.equal(
        unknownZero.nextSession.transcript.find((entry) => entry.item_id === "item-2")?.entry_seq,
        7
      );

      const unknownNonzero = reduceDelta(
        surface,
        session(),
        delta({ item_id: "item-3", delta: "tail", text_offset: 4 })
      );
      assert.equal(unknownNonzero.kind, "needs_repair");
      assert.equal(unknownNonzero.reason, "offset_gap");
      assert.equal(unknownNonzero.unknownItem, true);
      assert.deepEqual(unknownNonzero.detail, { item: "item-3", offset: 4, have: 0 });

      const baseGap = reduceDelta(
        surface,
        session({ transcript_revision: 5 }),
        delta({
          base_revision: 7,
          revision: 8,
          delta: "\nline 2",
          delta_kind: "command_output",
          text_offset: undefined,
        })
      );
      assert.equal(baseGap.kind, surface.baseGapKind);
      if (surface.baseGapKind === "append") {
        assert.equal(textFor(baseGap), "Hello\nline 2");
      } else {
        assert.equal(baseGap.reason, "base_revision_gap");
        assert.deepEqual(baseGap.detail, { item: "item-1", base_revision: 7, current: 5 });
      }

      const emptyOffsetless = reduceDelta(
        surface,
        session({
          transcript: [{ ...session().transcript[0], status: "completed" }],
        }),
        delta({ delta: "", text_offset: undefined })
      );
      assert.equal(emptyOffsetless.kind, surface.emptyOffsetlessDeltaKind);
      if (surface.emptyOffsetlessDeltaKind === "noop") {
        assert.equal(emptyOffsetless.reason, "empty_offsetless_delta");
        assert.equal(emptyOffsetless.nextSession, undefined);
      } else {
        assert.equal(emptyOffsetless.nextSession.transcript[0].text, "Hello");
        assert.equal(emptyOffsetless.nextSession.transcript[0].status, "running");
      }

      const monotonic = reduceDelta(
        surface,
        session({ transcript_revision: 10 }),
        delta({ revision: 9 })
      );
      assert.equal(monotonic.kind, surface.staleDeltaKind);
      assert.equal(monotonic.nextRevision, 10);
      if (surface.staleDeltaKind === "append") {
        assert.equal(monotonic.nextSession.transcript_revision, 10);
        assert.equal(textFor(monotonic), "Hello world");
      } else {
        assert.equal(monotonic.reason, "stale_revision");
      }

      const deltaWithEventKindFallback = reduceDelta(
        surface,
        session({ transcript: [] }),
        delta({
          item_id: "item-event-kind",
          delta: "fallback",
          delta_kind: undefined,
          kind: "transcript_entry_delta",
          text_offset: 0,
        })
      );
      assert.equal(deltaWithEventKindFallback.kind, "append");
      assert.equal(
        deltaWithEventKindFallback.nextSession.transcript.at(-1).kind,
        "agent_text"
      );
    });
  }
});

test("entry patch reducer fixtures run under Local and Remote surface policies", async (t) => {
  for (const surface of SURFACES) {
    await t.test(surface.name, () => {
      const completed = reducePatch(surface, session(), patch());
      assert.equal(completed.kind, "accepted_patch");
      assert.equal(completed.terminal, true);
      assert.equal(textFor(completed), "final");
      assert.equal(completed.nextSession.transcript[0].status, "completed");
      assert.equal(completed.nextSession.transcript_revision, 2);

      const started = reducePatch(
        surface,
        session(),
        patch({
          kind: "transcript_entry_started",
          item_id: "tool-1",
          entry_kind: "tool_call",
          status: undefined,
          text: undefined,
        }),
        { defaultStatus: "running", windowLoaded: true }
      );
      assert.equal(started.kind, "accepted_patch");
      assert.equal(started.terminal, false);
      assert.equal(started.patchIntroducesUntrackedItem, true);
      assert.equal(started.nextSession.transcript.at(-1).item_id, "tool-1");
      assert.equal(started.nextSession.transcript.at(-1).kind, "tool_call");
      assert.equal(started.nextSession.transcript.at(-1).status, "running");

      const patched = reducePatch(
        surface,
        session(),
        patch({ kind: "transcript_entry_patched", status: "running", text: "draft" })
      );
      assert.equal(patched.kind, "accepted_patch");
      assert.equal(patched.terminal, false);
      assert.equal(textFor(patched), "draft");

      const completedWithoutEntryKind = reducePatch(
        surface,
        session({ transcript: [] }),
        patch({
          kind: "transcript_entry_completed",
          item_id: "item-event-kind",
          entry_kind: undefined,
          text: "done",
        })
      );
      assert.equal(completedWithoutEntryKind.kind, "accepted_patch");
      assert.equal(completedWithoutEntryKind.nextSession.transcript.at(-1).kind, "agent_text");

      const wrongThread = reducePatch(
        surface,
        session(),
        patch({ thread_id: "thread-other" })
      );
      assert.equal(wrongThread.kind, "rejected_patch");
      assert.equal(wrongThread.reason, "wrong_thread");

      const stalePatch = reducePatch(
        surface,
        session({ transcript_revision: 10 }),
        patch({ base_revision: 9, revision: 9 })
      );
      assert.equal(stalePatch.kind, surface.stalePatchKind);
      assert.equal(stalePatch.nextRevision, 10);
      if (surface.stalePatchKind === "accepted_patch") {
        assert.equal(stalePatch.nextSession.transcript_revision, 10);
        assert.equal(textFor(stalePatch), "final");
      } else {
        assert.equal(stalePatch.reason, "revision_mismatch");
        assert.deepEqual(stalePatch.repairDetail, {
          base_revision: 9,
          current: 10,
          item: "item-1",
        });
      }
    });
  }
});
