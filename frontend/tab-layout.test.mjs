import test from "node:test";
import assert from "node:assert/strict";

import {
  closeTab,
  createLeaf,
  createSplit,
  createTabWorkspace,
  findTabByThread,
  focusTab,
  focusedTab,
  layoutThreadIds,
  moveTab,
  openThreadIds,
  openThreadTab,
  setTabPinned,
  tabIdForThread,
} from "./shared/tab-layout.js";

const ids = (workspace) => workspace.tabs.map((tab) => tab.id);

function workspaceWith(threadIds) {
  return threadIds.reduce((workspace, threadId) => openThreadTab(workspace, threadId), createTabWorkspace());
}

test("opening sessions appends tabs and focuses the newest", () => {
  const workspace = workspaceWith(["t1", "t2"]);
  assert.deepEqual(ids(workspace), [tabIdForThread("t1"), tabIdForThread("t2")]);
  assert.equal(workspace.focusedTabId, tabIdForThread("t2"));
});

// A browser switches to an already-open tab rather than opening a second copy;
// duplicating would also give two panes competing over the same session.
test("opening an already-open session focuses its tab instead of duplicating", () => {
  const workspace = openThreadTab(workspaceWith(["t1", "t2"]), "t1");
  assert.deepEqual(ids(workspace), [tabIdForThread("t1"), tabIdForThread("t2")]);
  assert.equal(workspace.focusedTabId, tabIdForThread("t1"));
});

test("closing a tab drops it without touching the others", () => {
  const workspace = closeTab(workspaceWith(["t1", "t2", "t3"]), tabIdForThread("t2"));
  assert.deepEqual(ids(workspace), [tabIdForThread("t1"), tabIdForThread("t3")]);
});

// Closing a run of tabs should keep walking rightward instead of snapping focus
// back to the first tab each time.
test("closing the focused tab focuses the right neighbour, else the left", () => {
  const three = workspaceWith(["t1", "t2", "t3"]);

  const middleClosed = closeTab(focusTab(three, tabIdForThread("t2")), tabIdForThread("t2"));
  assert.equal(middleClosed.focusedTabId, tabIdForThread("t3"), "focus moves right");

  const lastClosed = closeTab(focusTab(three, tabIdForThread("t3")), tabIdForThread("t3"));
  assert.equal(lastClosed.focusedTabId, tabIdForThread("t2"), "last tab falls back left");
});

test("closing an unfocused tab leaves the focus alone", () => {
  const workspace = focusTab(workspaceWith(["t1", "t2", "t3"]), tabIdForThread("t1"));
  const next = closeTab(workspace, tabIdForThread("t3"));
  assert.equal(next.focusedTabId, tabIdForThread("t1"));
});

test("closing the last tab clears the focus", () => {
  const workspace = closeTab(workspaceWith(["t1"]), tabIdForThread("t1"));
  assert.deepEqual(workspace.tabs, []);
  assert.equal(workspace.focusedTabId, null);
});

test("pinned tabs sort ahead of unpinned ones", () => {
  const workspace = setTabPinned(workspaceWith(["t1", "t2", "t3"]), tabIdForThread("t3"), true);
  assert.deepEqual(ids(workspace), [
    tabIdForThread("t3"),
    tabIdForThread("t1"),
    tabIdForThread("t2"),
  ]);
});

test("unpinning returns a tab to the unpinned zone", () => {
  const pinned = setTabPinned(workspaceWith(["t1", "t2"]), tabIdForThread("t1"), true);
  const unpinned = setTabPinned(pinned, tabIdForThread("t1"), false);
  assert.deepEqual(ids(unpinned), [tabIdForThread("t1"), tabIdForThread("t2")]);
});

test("a newly opened session lands after the pinned zone, not inside it", () => {
  const pinned = setTabPinned(workspaceWith(["t1"]), tabIdForThread("t1"), true);
  const workspace = openThreadTab(pinned, "t2");
  assert.deepEqual(ids(workspace), [tabIdForThread("t1"), tabIdForThread("t2")]);
  assert.equal(workspace.tabs[0].pinned, true);
  assert.equal(workspace.tabs[1].pinned, false);
});

test("drag-reorder moves a tab within its own partition", () => {
  const workspace = moveTab(workspaceWith(["t1", "t2", "t3"]), tabIdForThread("t3"), 0);
  assert.deepEqual(ids(workspace), [
    tabIdForThread("t3"),
    tabIdForThread("t1"),
    tabIdForThread("t2"),
  ]);
});

// Dragging across the pinned boundary must not silently pin/unpin — the target is
// clamped into the dragged tab's own zone, keeping the partition invariant.
test("drag-reorder cannot interleave pinned and unpinned tabs", () => {
  const pinned = setTabPinned(workspaceWith(["t1", "t2", "t3"]), tabIdForThread("t1"), true);

  const draggedLeft = moveTab(pinned, tabIdForThread("t3"), 0);
  assert.equal(draggedLeft.tabs[0].id, tabIdForThread("t1"), "pinned tab keeps the first slot");
  assert.equal(draggedLeft.tabs[0].pinned, true);
  assert.equal(draggedLeft.tabs[1].id, tabIdForThread("t3"), "clamped to the top of its own zone");
  assert.equal(draggedLeft.tabs[1].pinned, false, "dragging did not pin it");

  const draggedRight = moveTab(pinned, tabIdForThread("t1"), 2);
  assert.equal(draggedRight.tabs[0].id, tabIdForThread("t1"), "lone pinned tab cannot leave its zone");
  assert.equal(draggedRight.tabs[0].pinned, true);
});

test("focus and reorder ignore unknown tab ids", () => {
  const workspace = workspaceWith(["t1"]);
  assert.deepEqual(focusTab(workspace, "nope"), workspace);
  assert.deepEqual(moveTab(workspace, "nope", 0), workspace);
  assert.deepEqual(closeTab(workspace, "nope"), workspace);
});

// Rehydrating from persisted state must not be able to produce a dangling focus,
// otherwise the UI would render an empty pane with tabs present.
test("rehydrating repairs a focus that names no existing tab", () => {
  const workspace = createTabWorkspace({
    tabs: [{ id: "tab-a", layout: createLeaf("t1") }],
    focusedTabId: "tab-gone",
  });
  assert.equal(workspace.focusedTabId, "tab-a");
});

test("rehydrating restores the pinned-first order and drops idless tabs", () => {
  const workspace = createTabWorkspace({
    tabs: [
      { id: "tab-a", layout: createLeaf("t1") },
      { id: "", layout: createLeaf("junk") },
      { id: "tab-b", pinned: true, layout: createLeaf("t2") },
    ],
    focusedTabId: "tab-a",
  });
  assert.deepEqual(ids(workspace), ["tab-b", "tab-a"]);
  assert.equal(workspace.focusedTabId, "tab-a", "an explicit valid focus survives reordering");
});

test("focusedTab resolves the focused entry", () => {
  const workspace = workspaceWith(["t1", "t2"]);
  assert.equal(focusedTab(workspace).id, tabIdForThread("t2"));
  assert.equal(focusedTab(createTabWorkspace()), null);
});

// The split shape is unused by the current UI but must already round-trip, so
// adding side-by-side panes later needs no migration of stored workspaces.
test("layout trees expose every session in visual order", () => {
  const split = createSplit({
    dir: "v",
    children: [createLeaf("t1"), createSplit({ children: [createLeaf("t2"), createLeaf("t3")] })],
  });
  assert.deepEqual(layoutThreadIds(split), ["t1", "t2", "t3"]);
});

test("a session inside a split counts as open", () => {
  const workspace = createTabWorkspace({
    tabs: [
      {
        id: "tab-split",
        layout: createSplit({ children: [createLeaf("t1"), createLeaf("t2")] }),
      },
    ],
  });

  assert.equal(findTabByThread(workspace, "t2").id, "tab-split");
  // The duplicate guard has to see through the tree, or splitting a tab and then
  // reopening one of its sessions would spawn a competing tab.
  const reopened = openThreadTab(workspace, "t2");
  assert.deepEqual(ids(reopened), ["tab-split"]);
  assert.equal(reopened.focusedTabId, "tab-split");
  assert.deepEqual(openThreadIds(workspace), ["t1", "t2"]);
});
