import test from "node:test";
import assert from "node:assert/strict";

import { buildThreadActivityMap, threadActivityFor } from "./shared/thread-activity.js";

test("buildThreadActivityMap keys working threads by id", () => {
  const map = buildThreadActivityMap({
    thread_activity: [
      { thread_id: "a", phase: "tool", tool: "Bash" },
      { thread_id: "b", phase: null, tool: null },
    ],
  });

  assert.equal(map.size, 2);
  assert.deepEqual(map.get("a"), { phase: "tool", tool: "Bash" });
  assert.deepEqual(map.get("b"), { phase: null, tool: null });
});

test("buildThreadActivityMap tolerates missing or malformed activity", () => {
  assert.equal(buildThreadActivityMap(undefined).size, 0);
  assert.equal(buildThreadActivityMap(null).size, 0);
  assert.equal(buildThreadActivityMap({}).size, 0);
  assert.equal(buildThreadActivityMap({ thread_activity: "nope" }).size, 0);
});

test("buildThreadActivityMap skips entries without an id and defaults nullish fields", () => {
  const map = buildThreadActivityMap({
    thread_activity: [
      { phase: "tool" }, // no thread_id -> skipped
      { thread_id: "c" }, // missing phase/tool -> null
    ],
  });

  assert.equal(map.size, 1);
  assert.deepEqual(map.get("c"), { phase: null, tool: null });
});

// The Tasks screen needs a phase/tool for ONE named thread, and which field
// holds it depends on whether that thread happens to be the active one. The
// snapshot's top-level `current_phase`/`current_tool` describe only the active
// thread; every other thread's liveness is in `thread_activity`. A caller that
// picks the wrong source either shows a permanently idle pane or paints
// another thread's tool name onto this one.
test("threadActivityFor reads the top-level fields for the active thread", () => {
  const activity = threadActivityFor(
    { active_thread_id: "orch-1", current_phase: "tool", current_tool: "Bash", thread_activity: [] },
    "orch-1"
  );

  assert.deepEqual(activity, { phase: "tool", tool: "Bash" });
});

test("threadActivityFor reads thread_activity for a thread that is not active", () => {
  const activity = threadActivityFor(
    {
      active_thread_id: "other",
      current_phase: "streaming",
      current_tool: null,
      thread_activity: [{ thread_id: "orch-1", phase: "tool", tool: "Grep" }],
    },
    "orch-1"
  );

  assert.deepEqual(activity, { phase: "tool", tool: "Grep" }, "not the active thread's phase");
});

test("threadActivityFor reports nothing for an idle or unknown thread", () => {
  const session = { active_thread_id: "other", thread_activity: [] };

  assert.deepEqual(threadActivityFor(session, "orch-1"), { phase: null, tool: null });
  assert.deepEqual(threadActivityFor(session, null), { phase: null, tool: null });
  assert.deepEqual(threadActivityFor(null, "orch-1"), { phase: null, tool: null });
});
