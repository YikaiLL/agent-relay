import test from "node:test";
import assert from "node:assert/strict";

import { buildSessionTabItems } from "./shared/session-tab-strip.js";
import {
  createLeaf,
  createSplit,
  createTabWorkspace,
  layoutThreadIds,
} from "./shared/tab-layout.js";

const build = (workspace, extra = {}) =>
  buildSessionTabItems({ workspace, layoutThreadIds, ...extra });

test("tab items carry strip order, pinned flag, and the resolved title", () => {
  const workspace = createTabWorkspace({
    tabs: [
      { id: "tab-a", layout: createLeaf("t1") },
      { id: "tab-b", pinned: true, layout: createLeaf("t2") },
    ],
  });

  const items = build(workspace, {
    resolveThread: (id) => ({ title: id === "t1" ? "Alpha" : "Beta", tooltip: `/work/${id}` }),
  });

  // Pinned first — the order comes from the model, not from this builder.
  assert.deepEqual(items.map((item) => item.tabId), ["tab-b", "tab-a"]);
  assert.deepEqual(items.map((item) => item.title), ["Beta", "Alpha"]);
  assert.deepEqual(items.map((item) => item.pinned), [true, false]);
  assert.equal(items[0].tooltip, "/work/t2");
  assert.equal(items[1].threadId, "t1");
});

test("an unresolvable session still renders a labelled tab", () => {
  const workspace = createTabWorkspace({ tabs: [{ id: "tab-a", layout: createLeaf("t1") }] });
  const items = build(workspace, { resolveThread: () => null });
  assert.equal(items[0].title, "Session");
});

test("per-thread signals map onto the tab that owns the session", () => {
  const workspace = createTabWorkspace({
    tabs: [
      { id: "tab-a", layout: createLeaf("t1") },
      { id: "tab-b", layout: createLeaf("t2") },
      { id: "tab-c", layout: createLeaf("t3") },
    ],
  });

  const items = build(workspace, {
    threadActivity: new Map([["t1", { tool: "grep" }]]),
    threadAttention: new Map([["t2", "needs_input"]]),
    threadReviewing: new Set(["t3"]),
  });

  assert.deepEqual(items[0].activity, { tool: "grep" });
  assert.equal(items[0].attentionKind, null);
  assert.equal(items[1].attentionKind, "needs_input");
  assert.equal(items[2].reviewing, true);
});

// Panes aren't in the UI yet, but the builder must not crash or mislabel when a
// stored workspace already contains one.
test("a split tab is labelled from its first session with a pane count", () => {
  const workspace = createTabWorkspace({
    tabs: [
      {
        id: "tab-split",
        layout: createSplit({ children: [createLeaf("t1"), createLeaf("t2")] }),
      },
    ],
  });

  const items = build(workspace, { resolveThread: () => ({ title: "Alpha" }) });
  assert.equal(items[0].title, "Alpha (2)");
  assert.equal(items[0].threadId, "t1");
});

test("an empty workspace produces no items", () => {
  assert.deepEqual(build(createTabWorkspace()), []);
  assert.deepEqual(buildSessionTabItems(), []);
});
