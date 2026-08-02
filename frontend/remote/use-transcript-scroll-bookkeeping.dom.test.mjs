// A remote reader who left a thread mid-history must land back on that offset
// after switching away and back — NOT at the bottom.
//
// The trap this guards is a React commit-ordering detail: child DOM mutations
// are committed BEFORE a parent's layout-effect cleanup runs, so by the time
// the transcript pane's cleanup fires, the scroller already shows the NEXT
// thread. Recording geometry there files the next thread's numbers (typically
// "empty, therefore at the bottom") under the LEAVING thread's key, which turns
// a history-reading offset into a false bottom-follow marker and snaps the
// reader to the tail on the way back.
//
// The scroller below models a real browser closely enough to expose exactly
// that: height derives from the rendered rows, and scrollTop is clamped (and
// stays clamped) when the content shrinks.
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
global.CustomEvent = dom.window.CustomEvent;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useRemoteTranscriptScrollBookkeeping } = await import(
  "./use-transcript-scroll-bookkeeping.js"
);

const h = React.createElement;

const CLIENT_HEIGHT = 266;
const ROW_HEIGHT = 46;
const laidOut = new WeakSet();

// Minimal layout model: scrollHeight follows the rendered rows and scrollTop
// behaves like a browser's — clamped to the scrollable range, and it does NOT
// spring back when the content grows again.
function installFakeLayout(element) {
  if (laidOut.has(element)) {
    return;
  }
  laidOut.add(element);
  let top = 0;
  const maxScrollTop = () =>
    Math.max(0, element.scrollHeight - element.clientHeight);
  Object.defineProperty(element, "clientHeight", { get: () => CLIENT_HEIGHT });
  Object.defineProperty(element, "scrollHeight", {
    get: () =>
      Math.max(
        CLIENT_HEIGHT,
        element.querySelectorAll("[data-transcript-row]").length * ROW_HEIGHT
      ),
  });
  Object.defineProperty(element, "scrollTop", {
    get: () => {
      top = Math.min(top, maxScrollTop());
      return top;
    },
    set: (value) => {
      top = Math.max(0, Math.min(Number(value) || 0, maxScrollTop()));
    },
  });
}

function entriesFor(threadId, count) {
  return Array.from({ length: count }, (_, index) => ({
    item_id: `${threadId}-item-${index}`,
    kind: index === 0 ? "user_text" : "assistant_text",
    text: `${threadId} line ${index}`,
  }));
}

function Harness({ currentState, entries, threadId }) {
  const transcriptRef = React.useRef(null);
  const attach = React.useCallback((element) => {
    transcriptRef.current = element;
    if (element) {
      installFakeLayout(element);
    }
  }, []);

  useRemoteTranscriptScrollBookkeeping({
    currentState,
    entries,
    threadId,
    transcriptRef,
  });

  return h(
    "div",
    { className: "chat-thread", id: "remote-transcript", ref: attach },
    entries.map((entry) =>
      h("div", { key: entry.item_id, "data-transcript-row": "1" }, entry.text)
    )
  );
}

function mount() {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  const currentState = { activeRelayId: "relay-1", promotedThreadAlias: null };
  return {
    scroller: () => host.querySelector(".chat-thread"),
    show(threadId, entries) {
      act(() => root.render(h(Harness, { currentState, entries, threadId })));
    },
    // A reader scroll: the browser moves scrollTop, then fires `scroll`.
    scrollTo(scrollTop) {
      const element = host.querySelector(".chat-thread");
      element.scrollTop = scrollTop;
      act(() => {
        element.dispatchEvent(new dom.window.Event("scroll"));
      });
    },
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test("a mid-history offset survives switching to another thread and back", () => {
  const view = mount();
  try {
    const first = entriesFor("thread-a", 8);
    view.show("thread-a", first);
    const bottom = view.scroller().scrollTop;
    assert.equal(bottom, 8 * ROW_HEIGHT - CLIENT_HEIGHT, "first view lands at the bottom");

    // The reader escapes the tail to read history.
    view.scrollTo(bottom - 40);
    assert.equal(view.scroller().scrollTop, bottom - 40);

    // Switch away to a thread whose projection is still empty (the shorter
    // content clamps the shared scroller to the top), then come back.
    view.show("thread-b", []);
    view.show("thread-a", first);

    assert.equal(
      view.scroller().scrollTop,
      bottom - 40,
      "switch-back restores the history offset instead of snapping to the bottom"
    );
    const element = view.scroller();
    const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
    assert.equal(distance, 40, "the reader is still off the bottom after switch-back");
  } finally {
    view.cleanup();
  }
});

test("a reader left at the tail keeps following it after switching back", () => {
  const view = mount();
  try {
    const first = entriesFor("thread-a", 8);
    view.show("thread-a", first);
    const bottom = view.scroller().scrollTop;
    view.scrollTo(bottom);

    view.show("thread-b", []);
    // The thread grew while it was hidden: bottom-follow is an intent, not a
    // pixel offset, so we land at the NEW bottom.
    const grown = entriesFor("thread-a", 12);
    view.show("thread-a", grown);

    assert.equal(
      view.scroller().scrollTop,
      12 * ROW_HEIGHT - CLIENT_HEIGHT,
      "switch-back lands at the new bottom"
    );
  } finally {
    view.cleanup();
  }
});
