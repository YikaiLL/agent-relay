// Live interaction test for the session tab strip, mounted under jsdom. The
// sibling session-tab-strip.test.mjs proves the pure view-model builder; this
// file proves the real React path: clicks reach the right callback, the close and
// pin controls do NOT also focus the tab, and a drag/drop maps onto the
// (tabId, toIndex) pair the tab-layout model expects.
//
// The drop mapping is the reason this file exists — "drop on target" has to mean
// "the dragged tab takes the target's current index", which is what reads
// correctly when dragging in either direction. Getting it off by one is invisible
// in a static render test.
//
// Kept in its own file so the DOM globals below don't leak into the static suite.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SessionTabStrip } = await import("./session-tab-strip.js");

const h = React.createElement;

const ITEMS = [
  { tabId: "tab-a", threadId: "t1", title: "Alpha", pinned: false },
  { tabId: "tab-b", threadId: "t2", title: "Beta", pinned: false },
  { tabId: "tab-c", threadId: "t3", title: "Gamma", pinned: false },
];

function mount(props) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(h(SessionTabStrip, props));
  });
  return {
    host,
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function tabEl(host, tabId) {
  return host.querySelector(`[data-tab-id="${tabId}"]`);
}

function click(element) {
  act(() => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

// jsdom has no DragEvent with a working dataTransfer; the component already
// guards on `event.dataTransfer` and keeps the dragged id in React state, so a
// plain bubbling Event exercises the real handler path.
function fireDrag(element, type) {
  act(() => {
    element.dispatchEvent(new dom.window.Event(type, { bubbles: true, cancelable: true }));
  });
}

test("the focused tab is the only one marked selected", () => {
  const view = mount({ items: ITEMS, focusedTabId: "tab-b" });
  try {
    const selected = [...view.host.querySelectorAll('[role="tab"]')].map((node) =>
      node.getAttribute("aria-selected")
    );
    assert.deepEqual(selected, ["false", "true", "false"]);
    assert.ok(tabEl(view.host, "tab-b").className.includes("is-focused"));
    assert.ok(!tabEl(view.host, "tab-a").className.includes("is-focused"));
  } finally {
    view.cleanup();
  }
});

test("clicking a tab focuses it", () => {
  const focused = [];
  const view = mount({ items: ITEMS, focusedTabId: "tab-a", onFocus: (id) => focused.push(id) });
  try {
    click(tabEl(view.host, "tab-c").querySelector(".session-tab-main"));
    assert.deepEqual(focused, ["tab-c"]);
  } finally {
    view.cleanup();
  }
});

// A close that also focused the tab would flash the session in before removing
// it, and on a phone the two controls sit millimetres apart.
test("close reports only the close, never a focus", () => {
  const closed = [];
  const focused = [];
  const view = mount({
    items: ITEMS,
    focusedTabId: "tab-a",
    onClose: (id) => closed.push(id),
    onFocus: (id) => focused.push(id),
  });
  try {
    click(tabEl(view.host, "tab-b").querySelector(".session-tab-close"));
    assert.deepEqual(closed, ["tab-b"]);
    assert.deepEqual(focused, [], "closing must not also focus the tab");
  } finally {
    view.cleanup();
  }
});

test("pin toggles against the tab's current state and does not focus", () => {
  const pinCalls = [];
  const focused = [];
  const items = [
    { tabId: "tab-a", threadId: "t1", title: "Alpha", pinned: true },
    { tabId: "tab-b", threadId: "t2", title: "Beta", pinned: false },
  ];
  const view = mount({
    items,
    focusedTabId: "tab-a",
    onTogglePin: (id, pinned) => pinCalls.push([id, pinned]),
    onFocus: (id) => focused.push(id),
  });
  try {
    click(tabEl(view.host, "tab-a").querySelector(".session-tab-pin"));
    click(tabEl(view.host, "tab-b").querySelector(".session-tab-pin"));
    assert.deepEqual(pinCalls, [["tab-a", false], ["tab-b", true]]);
    assert.deepEqual(focused, []);
  } finally {
    view.cleanup();
  }
});

test("dragging right reports the target's index as the destination", () => {
  const moves = [];
  const view = mount({ items: ITEMS, focusedTabId: "tab-a", onMove: (id, to) => moves.push([id, to]) });
  try {
    fireDrag(tabEl(view.host, "tab-a"), "dragstart");
    fireDrag(tabEl(view.host, "tab-c"), "dragover");
    fireDrag(tabEl(view.host, "tab-c"), "drop");
    // Alpha dropped on Gamma (index 2) → Alpha ends at index 2 → [Beta, Gamma, Alpha].
    assert.deepEqual(moves, [["tab-a", 2]]);
  } finally {
    view.cleanup();
  }
});

test("dragging left reports the target's index as the destination", () => {
  const moves = [];
  const view = mount({ items: ITEMS, focusedTabId: "tab-a", onMove: (id, to) => moves.push([id, to]) });
  try {
    fireDrag(tabEl(view.host, "tab-c"), "dragstart");
    fireDrag(tabEl(view.host, "tab-a"), "dragover");
    fireDrag(tabEl(view.host, "tab-a"), "drop");
    assert.deepEqual(moves, [["tab-c", 0]]);
  } finally {
    view.cleanup();
  }
});

test("dropping a tab on itself reports no move", () => {
  const moves = [];
  const view = mount({ items: ITEMS, focusedTabId: "tab-a", onMove: (id, to) => moves.push([id, to]) });
  try {
    fireDrag(tabEl(view.host, "tab-b"), "dragstart");
    fireDrag(tabEl(view.host, "tab-b"), "drop");
    assert.deepEqual(moves, []);
  } finally {
    view.cleanup();
  }
});

test("the drag source and hovered target are marked for styling", () => {
  const view = mount({ items: ITEMS, focusedTabId: "tab-a", onMove: () => {} });
  try {
    fireDrag(tabEl(view.host, "tab-a"), "dragstart");
    fireDrag(tabEl(view.host, "tab-c"), "dragover");
    assert.ok(tabEl(view.host, "tab-a").className.includes("is-dragging"));
    assert.ok(tabEl(view.host, "tab-c").className.includes("is-drop-target"));
    // The dragged tab is never its own drop target.
    assert.ok(!tabEl(view.host, "tab-a").className.includes("is-drop-target"));

    fireDrag(tabEl(view.host, "tab-a"), "dragend");
    assert.ok(!tabEl(view.host, "tab-a").className.includes("is-dragging"));
    assert.ok(!tabEl(view.host, "tab-c").className.includes("is-drop-target"));
  } finally {
    view.cleanup();
  }
});

// needs_input has to win over working: a thread paused on an approval still has a
// live turn, so without the override the tab would pulse "working" and hide that
// the user must act. Same priority the sidebar uses.
test("a tab needing input shows the attention dot over the working pulse", () => {
  const view = mount({
    items: [
      {
        tabId: "tab-a",
        threadId: "t1",
        title: "Alpha",
        pinned: false,
        activity: { tool: "bash" },
        attentionKind: "needs_input",
      },
    ],
    focusedTabId: "tab-a",
  });
  try {
    const dot = tabEl(view.host, "tab-a").querySelector(".conversation-activity-dot");
    assert.ok(dot, "a dot is rendered");
    assert.ok(dot.className.includes("is-attention-input"));
  } finally {
    view.cleanup();
  }
});

test("an empty strip shows the empty message and still offers the new-tab control", () => {
  const opened = [];
  const view = mount({ items: [], emptyMessage: "Nothing open.", onNewTab: () => opened.push(1) });
  try {
    assert.match(view.host.textContent, /Nothing open\./);
    click(view.host.querySelector(".session-tab-new"));
    assert.deepEqual(opened, [1]);
  } finally {
    view.cleanup();
  }
});
