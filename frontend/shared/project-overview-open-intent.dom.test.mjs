// Live interaction tests for the project overview card's OPEN INTENT, mounted
// under jsdom.
//
// THE CONTRACT — a card opens a session the same way a sidebar row does: as a
// PEEK, into the reusable preview tab. Cards and rows are two doors onto the same
// list, and a door that quietly kept every session it opened would put the tab
// accumulation straight back.
//
// There is deliberately NO double-click-to-keep on a card, unlike the sidebar
// row. Opening a session REPLACES the overview with the conversation, so the card
// is gone before a second click could land on it — the keep gesture would be a
// race against an unmount. Keeping happens where the target is stable instead:
// double-click the tab in the strip, pin it, or just send a message.
//
// (The overview itself is currently retired from view behind `showProjectOverview
// = false` in render-session.js. The component, its model and its pin/order prefs
// are all still live — the prefs back the sidebar rows — so this stays honest
// about what the cards do if that flag flips back.)
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
const { ProjectOverview } = await import("./project-overview-react.js");

const h = React.createElement;

const PROJECT = { id: "p1", name: "Alpha" };
const AGENTS = [
  { id: "thread-1", name: "One", provider: "codex", cwd: "/tmp/work", updated_at: 0 },
  { id: "thread-2", name: "Two", provider: "codex", cwd: "/tmp/work", updated_at: 0 },
];

function mount(props) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      h(ProjectOverview, {
        project: PROJECT,
        agents: AGENTS,
        pinnedIds: new Set(),
        formatMeta: () => "now",
        ...props,
      })
    );
  });
  return {
    card: (threadId) => host.querySelector(`.project-card[data-thread-id="${threadId}"]`),
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function click(element) {
  act(() => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

test("clicking a card peeks, exactly like a sidebar row", () => {
  const opens = [];
  const view = mount({ onOpenAgent: (threadId, options) => opens.push([threadId, options]) });

  click(view.card("thread-2"));
  assert.deepEqual(opens, [["thread-2", { preview: true }]]);

  view.cleanup();
});

// The pin and drag affordances own their own hits; the peek must not ride along,
// or pinning a card would also navigate away from the overview you're arranging.
test("the pin and drag controls never open the session", () => {
  const opens = [];
  const pins = [];
  const view = mount({
    onOpenAgent: (threadId) => opens.push(threadId),
    onTogglePin: (threadId) => pins.push(threadId),
  });

  click(view.card("thread-1").querySelector(".project-card-pin"));
  click(view.card("thread-1").querySelector(".project-card-drag"));

  assert.deepEqual(pins, ["thread-1"]);
  assert.deepEqual(opens, [], "neither control opened the session");

  view.cleanup();
});
