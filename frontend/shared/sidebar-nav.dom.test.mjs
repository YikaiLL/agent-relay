// Live interaction test for the shared sidebar nav, mounted under jsdom. The sibling
// sidebar-nav.test.mjs proves the static render rules; this file proves the two things a
// string of markup cannot show:
//
//   1. a click reaches the right destination's callback, and only that one;
//   2. a re-render REUSES the existing button element rather than replacing it.
//
// (2) is the load-bearing one, and it is why this file exists. The nav used to render
// exactly once inside local's single shell render, so nothing could disturb a gesture in
// progress. Prop-driven, it re-renders whenever the view or the waiting count changes —
// and a `click` only fires when mousedown and mouseup resolve to the SAME node. If React
// were to unmount and re-create these buttons (which is what an unstable key does), a
// re-render landing between the two halves of a real tap would produce no click at all:
// the button would hover, depress, and do nothing, with no error anywhere.
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
const { SidebarNav, SidebarNavRail } = await import("./sidebar-nav.js");

const h = React.createElement;

function mount(Component, props) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const view = {
    host,
    render(nextProps) {
      act(() => {
        root.render(h(Component, nextProps));
      });
    },
    button(destination) {
      return host.querySelector(`[data-destination="${destination}"]`);
    },
    click(destination) {
      const button = view.button(destination);
      assert.ok(button, `expected a ${destination} button to click`);
      act(() => {
        button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
    },
  };
  view.render(props);
  return view;
}

function spies() {
  const calls = [];
  return {
    calls,
    onOpenSessions: () => calls.push("sessions"),
    onOpenTasks: () => calls.push("tasks"),
  };
}

for (const Component of [SidebarNav, SidebarNavRail]) {
  test(`${Component.name}: each destination calls its own handler and no other`, () => {
    const handlers = spies();
    const view = mount(Component, { ...handlers, current: "sessions" });

    view.click("tasks");
    assert.deepEqual(handlers.calls, ["tasks"]);

    view.click("sessions");
    assert.deepEqual(handlers.calls, ["tasks", "sessions"]);
  });

  // Re-selecting where you already are still fires. The component does not know what
  // routing is, so it cannot know whether re-navigating is a no-op — on local it resets
  // the Sessions screen to its overview, which is a real thing to want.
  test(`${Component.name}: the current destination is still clickable`, () => {
    const handlers = spies();
    const view = mount(Component, { ...handlers, current: "tasks" });

    view.click("tasks");

    assert.deepEqual(handlers.calls, ["tasks"], "being here does not disable going here");
  });

  // The guard described at the top of the file.
  test(`${Component.name}: a re-render reuses the button, so a gesture survives it`, () => {
    const handlers = spies();
    const view = mount(Component, { ...handlers, current: "sessions", tasksWaitingCount: 0 });

    // Identity is probed with a marker React does not manage, NOT by comparing the two
    // nodes. `assert.equal` on a pair of jsdom elements tries to stringify a whole DOM
    // subtree to build its diff: it takes tens of seconds and buries the actual message.
    // A one-character probe fails as a clean boolean.
    view.button("tasks").dataset.reuseProbe = "button";
    view.button("tasks").querySelector(".inline-icon").dataset.reuseProbe = "glyph";

    // Everything a real view change touches at once: which row is lit, and the badge.
    view.render({ ...handlers, current: "tasks", tasksWaitingCount: 3 });

    assert.equal(
      view.button("tasks")?.dataset.reuseProbe,
      "button",
      "the button element must be REUSED — replacing it mid-gesture swallows the click"
    );
    assert.equal(
      view.button("tasks")?.querySelector(".inline-icon")?.dataset.reuseProbe,
      "glyph",
      "the glyph wrapper is reused too, so `dangerouslySetInnerHTML` is not re-run"
    );
    assert.equal(view.button("tasks").getAttribute("aria-current"), "page", "and it did update");

    // Still live after the re-render — a reused node with a stale handler would be worse
    // than a replaced one, because it would look fine and call the wrong thing.
    view.click("tasks");
    assert.deepEqual(handlers.calls, ["tasks"]);
  });

  // Appearing and disappearing is a different path from re-rendering in place: this is
  // what step 5 does on remote the moment the Tasks transport lands.
  test(`${Component.name}: gaining a destination adds it without disturbing the other`, () => {
    const handlers = spies();
    const view = mount(Component, { onOpenSessions: handlers.onOpenSessions, current: "sessions" });
    assert.equal(view.button("tasks"), null, "no Tasks handler, no Tasks button, no nav at all");
    assert.equal(view.button("sessions"), null, "a one-destination nav renders nothing");

    view.render({ ...handlers, current: "sessions" });

    assert.ok(view.button("sessions"), "Sessions appears once there is a choice to offer");
    assert.ok(view.button("tasks"));
    view.click("tasks");
    assert.deepEqual(handlers.calls, ["tasks"]);
  });
}
