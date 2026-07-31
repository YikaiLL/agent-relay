// Live interaction tests for a sidebar session row's OPEN INTENT, mounted under
// jsdom. Targets ThreadGroupItem directly (the list is virtualized and measures
// zero-height rows under jsdom, so nothing would render through ThreadGroupList).
//
// THE CONTRACT — one row, two intents, distinguished only by the gesture:
//
//   * single click -> peek. Open it, but as the reusable preview tab.
//   * double click -> keep. Open it as a tab that survives the next peek.
//
// This is the editor's italic-tab rule, and it exists because browsing and
// working used to be the same gesture: scrolling the sidebar looking for a
// session left a tab behind for every row touched on the way.
//
// A double click necessarily fires its two clicks first, so the peek runs and is
// then upgraded. That ordering is the design, not a wart — the session is on
// screen from the first click, exactly as before, and the second gesture only
// changes whether its tab is disposable.
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

const GROUP = { cwd: "/tmp/work", label: "work" };
const THREAD = { id: "thread-1", name: "Alpha", provider: "codex", updated_at: 0 };

function mount(props) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      h(ThreadGroupItem, {
        active: false,
        formatThreadMeta: () => "now",
        group: GROUP,
        includePreview: false,
        previewFallback: "",
        thread: THREAD,
        ...props,
      })
    );
  });
  return {
    row: host.querySelector(".conversation-item"),
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function fire(element, type) {
  act(() => {
    element.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true }));
  });
}

test("a single click peeks: it opens the session as a preview", () => {
  const opens = [];
  const view = mount({ onResumeThread: (threadId, options) => opens.push([threadId, options]) });

  fire(view.row, "click");
  assert.deepEqual(opens, [["thread-1", { preview: true }]]);

  view.cleanup();
});

test("a double click keeps the session, after the peek its clicks already made", () => {
  const opens = [];
  const view = mount({ onResumeThread: (threadId, options) => opens.push([threadId, options]) });

  // The browser's real sequence: click, click, dblclick.
  fire(view.row, "click");
  fire(view.row, "click");
  fire(view.row, "dblclick");

  assert.deepEqual(opens, [
    ["thread-1", { preview: true }],
    ["thread-1", { preview: true }],
    ["thread-1", { preview: false }],
  ]);
  assert.equal(
    opens.at(-1)[1].preview,
    false,
    "the last word belongs to the keep gesture, whatever the clicks said"
  );

  view.cleanup();
});

// A surface with no tab strip (remote) passes a one-argument handler. It must not
// break, and the row must not start caring whether the caller reads the options.
test("a handler that ignores the intent still receives the session", () => {
  const opens = [];
  const view = mount({ onResumeThread: (threadId) => opens.push(threadId) });

  fire(view.row, "click");
  fire(view.row, "dblclick");
  assert.deepEqual(opens, ["thread-1", "thread-1"]);

  view.cleanup();
});
