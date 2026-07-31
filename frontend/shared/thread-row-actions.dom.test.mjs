// Guards the per-row "⋯" session-actions button on ThreadGroupItem.
//
// ThreadGroupItem is shared by local AND remote, so the button is gated on an optional
// `onThreadActions`: absent, the row must render exactly as it always did. Local passes
// nothing (it has its own right-click menu), so these tests are what keep this change
// from leaking into local's sidebar.
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
const { ThreadGroupItem } = await import("./thread-list-react.js");

const h = React.createElement;

const THREAD = { id: "t1", name: "Alpha session", provider: "codex", updated_at: 1 };

function renderRow(extra = {}) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      h(ThreadGroupItem, {
        active: false,
        formatThreadMeta: () => "now",
        group: { cwd: "", key: "g", label: "g" },
        includePreview: false,
        thread: THREAD,
        ...extra,
      })
    );
  });
  return {
    host,
    root: host.firstElementChild,
    more: host.querySelector(".conversation-more"),
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test("without an actions handler the row is still a bare button", () => {
  const view = renderRow();
  try {
    assert.equal(view.root.tagName, "BUTTON");
    assert.ok(view.root.classList.contains("conversation-item"));
    assert.equal(view.more, null, "no actions button leaks into local's sidebar");
    assert.equal(view.host.querySelector(".conversation-item-wrap"), null, "no wrapper either");
  } finally {
    view.cleanup();
  }
});

test("with a handler the row gains a sibling actions button inside a wrapper", () => {
  const view = renderRow({ onThreadActions: () => {} });
  try {
    assert.ok(view.root.classList.contains("conversation-item-wrap"));
    assert.ok(view.more, "actions button present");
    // The invariant that makes this legal HTML.
    assert.equal(
      view.more.closest("button"),
      view.more,
      "the actions button must not be nested inside the row button"
    );
    assert.equal(view.root.querySelector(".conversation-item").tagName, "BUTTON");
  } finally {
    view.cleanup();
  }
});

test("the actions button is labelled per session, so it is not an anonymous glyph", () => {
  const view = renderRow({ onThreadActions: () => {} });
  try {
    assert.equal(view.more.getAttribute("aria-label"), "Actions for Alpha session");
    assert.equal(view.more.getAttribute("type"), "button");
  } finally {
    view.cleanup();
  }
});

test("clicking the actions button reports the thread and an anchor", () => {
  const calls = [];
  const view = renderRow({ onThreadActions: (...args) => calls.push(args) });
  try {
    act(() => {
      view.more.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "t1");
    assert.equal(typeof calls[0][1], "number", "anchor x");
    assert.equal(typeof calls[0][2], "number", "anchor y");
  } finally {
    view.cleanup();
  }
});

// The row underneath opens the session on click. Without stopPropagation the tap would
// both open the sheet and navigate away from the list it was opened on.
test("clicking the actions button does not also open the session", () => {
  const resumed = [];
  const view = renderRow({
    onThreadActions: () => {},
    onResumeThread: (id) => resumed.push(id),
  });
  try {
    act(() => {
      view.more.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.deepEqual(resumed, [], "the row's own click handler must not fire");
  } finally {
    view.cleanup();
  }
});
