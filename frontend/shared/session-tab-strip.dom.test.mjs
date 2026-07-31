// Live interaction test for the session tab strip, mounted under jsdom. The
// sibling session-tab-strip.test.mjs proves the pure view-model builder,
// tab-strip-gesture.test.mjs proves the pan/reorder rules; this file proves the
// real React path: clicks reach the right callback, the close and pin controls do
// NOT also focus the tab, and a held drag maps onto the (tabId, toIndex) pair the
// tab-layout model expects.
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

// Count the window listeners a gesture installs, so "cleaned up after itself" can
// be asserted rather than assumed. jsdom's window is the one the component finds
// through the strip's ownerDocument.
const GESTURE_EVENTS = new Set(["pointermove", "pointerup", "pointercancel"]);
const liveWindowListeners = new Map();
{
  const { addEventListener, removeEventListener } = dom.window;
  dom.window.addEventListener = function trackedAdd(type, listener, options) {
    if (GESTURE_EVENTS.has(type)) {
      liveWindowListeners.set(type, (liveWindowListeners.get(type) || 0) + 1);
    }
    return addEventListener.call(this, type, listener, options);
  };
  dom.window.removeEventListener = function trackedRemove(type, listener, options) {
    if (GESTURE_EVENTS.has(type)) {
      liveWindowListeners.set(type, (liveWindowListeners.get(type) || 0) - 1);
    }
    return removeEventListener.call(this, type, listener, options);
  };
}
const windowListenerCount = () =>
  [...GESTURE_EVENTS].reduce((total, type) => total + (liveWindowListeners.get(type) || 0), 0);

// jsdom ships no ResizeObserver; this stub hands the callback back so the
// "the strip got narrower" path can be exercised instead of assumed.
const resizeObservers = [];
dom.window.ResizeObserver = class ResizeObserverStub {
  constructor(callback) {
    this.callback = callback;
    resizeObservers.push(this);
  }

  observe() {}

  disconnect() {
    this.disconnected = true;
  }
};

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

// The hold that arms a reorder is a real timer; keep it short enough that a test
// can wait it out for real rather than mocking the clock the component owns.
const HOLD_MS = 4;

// jsdom has no layout, so the strip's pointer maths would see every tab at x=0.
// These are the positions the tests reason about: three 100px tabs starting at
// 200, inside a 1000px strip (well clear of the edge auto-scroll zones).
const TAB_X = { "tab-a": 200, "tab-b": 304, "tab-c": 408 };

// Re-stamp the fake layout, optionally in a new strip order — which is what
// pinning does: same tabs, same ids, different slots.
//
// Tab rects are computed against the CURRENT scrollLeft, like a real browser's:
// the component converts a tab's viewport position back into a content offset, so
// a layout frozen at scrollLeft 0 would make that maths look wrong.
function layout(view, order = null) {
  const strip = view.strip;
  if (!strip) {
    return;
  }
  strip.getBoundingClientRect = () => ({ left: 0, right: 1000, width: 1000 });
  for (const node of view.host.querySelectorAll("[data-tab-id]")) {
    const tabId = node.getAttribute("data-tab-id");
    const slot = order ? order.indexOf(tabId) : -1;
    const content = slot >= 0 ? 200 + slot * 104 : TAB_X[tabId] ?? 0;
    node.getBoundingClientRect = () => {
      const left = content - strip.scrollLeft;
      return { left, right: left + 100, width: 100 };
    };
  }
}

function mount(props) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(h(SessionTabStrip, { reorderHoldMs: HOLD_MS, ...props }));
  });
  const strip = host.querySelector(".session-tab-strip");
  if (strip) {
    layout({ host, strip });
  }
  return {
    host,
    strip,
    rerender(next) {
      root.render(h(SessionTabStrip, { reorderHoldMs: HOLD_MS, ...next }));
    },
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

// React dispatches its pointer handlers off the native event's type and reads
// clientX/button straight from it, so a bubbling MouseEvent exercises the real
// handler path — jsdom ships no PointerEvent constructor.
function pointer(
  element,
  type,
  clientX,
  { buttons = type === "pointerup" ? 0 : 1, pointerId = 1 } = {}
) {
  act(() => {
    const event = new dom.window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      buttons,
    });
    // MouseEventInit carries no pointerId; the component reads it off the event.
    Object.defineProperty(event, "pointerId", { value: pointerId });
    element.dispatchEvent(event);
  });
}

// x of a tab's centre, in the fake layout above.
const centreOf = (tabId) => TAB_X[tabId] + 50;

async function waitForHold() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS + 6));
  });
}

// Press, hold until the tab lifts, drag onto `toTabId`, release.
async function holdAndDrag(view, fromTabId, toTabId) {
  pointer(tabEl(view.host, fromTabId), "pointerdown", centreOf(fromTabId));
  await waitForHold();
  pointer(view.strip, "pointermove", centreOf(toTabId));
  pointer(view.strip, "pointerup", centreOf(toTabId));
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

test("holding then dragging right reports the target's index as the destination", async () => {
  const moves = [];
  const view = mount({ items: ITEMS, focusedTabId: "tab-a", onMove: (id, to) => moves.push([id, to]) });
  try {
    await holdAndDrag(view, "tab-a", "tab-c");
    // Alpha dropped on Gamma (index 2) → Alpha ends at index 2 → [Beta, Gamma, Alpha].
    assert.deepEqual(moves, [["tab-a", 2]]);
  } finally {
    view.cleanup();
  }
});

test("holding then dragging left reports the target's index as the destination", async () => {
  const moves = [];
  const view = mount({ items: ITEMS, focusedTabId: "tab-a", onMove: (id, to) => moves.push([id, to]) });
  try {
    await holdAndDrag(view, "tab-c", "tab-a");
    assert.deepEqual(moves, [["tab-c", 0]]);
  } finally {
    view.cleanup();
  }
});

test("releasing a held tab where it started reports no move", async () => {
  const moves = [];
  const view = mount({ items: ITEMS, focusedTabId: "tab-a", onMove: (id, to) => moves.push([id, to]) });
  try {
    await holdAndDrag(view, "tab-b", "tab-b");
    assert.deepEqual(moves, []);
  } finally {
    view.cleanup();
  }
});

// The whole point of the hold: a plain drag is how the strip is panned, so it
// must never move a tab. Getting this wrong shuffles a user's tabs every time
// they reach for one that's off-screen.
test("dragging without holding pans instead of reordering", () => {
  const moves = [];
  const focused = [];
  const view = mount({
    items: ITEMS,
    focusedTabId: "tab-a",
    onMove: (id, to) => moves.push([id, to]),
    onFocus: (id) => focused.push(id),
  });
  try {
    pointer(tabEl(view.host, "tab-a"), "pointerdown", centreOf("tab-a"));
    pointer(view.strip, "pointermove", centreOf("tab-a") - 90);
    assert.ok(view.strip.className.includes("is-panning"), "the strip reports the pan");
    assert.ok(!tabEl(view.host, "tab-a").className.includes("is-dragging"));

    pointer(view.strip, "pointerup", centreOf("tab-a") - 90);
    assert.deepEqual(moves, [], "a pan must not reorder");
    assert.ok(!view.strip.className.includes("is-panning"));

    // The click the browser fires after the drag belongs to the pan, not to the
    // tab it happened to end on.
    click(tabEl(view.host, "tab-a").querySelector(".session-tab-main"));
    assert.deepEqual(focused, [], "a pan must not switch sessions");
  } finally {
    view.cleanup();
  }
});

// A press that never moves is still just a click — panning must not swallow it.
test("a press that does not move still focuses the tab", () => {
  const focused = [];
  const view = mount({ items: ITEMS, focusedTabId: "tab-a", onFocus: (id) => focused.push(id) });
  try {
    const main = tabEl(view.host, "tab-b").querySelector(".session-tab-main");
    pointer(main, "pointerdown", centreOf("tab-b"));
    pointer(view.strip, "pointermove", centreOf("tab-b") + 2);
    pointer(view.strip, "pointerup", centreOf("tab-b") + 2);
    click(main);
    assert.deepEqual(focused, ["tab-b"]);
  } finally {
    view.cleanup();
  }
});

test("the lifted tab and its hovered target are marked for styling", async () => {
  const view = mount({ items: ITEMS, focusedTabId: "tab-a", onMove: () => {} });
  try {
    pointer(tabEl(view.host, "tab-a"), "pointerdown", centreOf("tab-a"));
    await waitForHold();
    assert.ok(tabEl(view.host, "tab-a").className.includes("is-dragging"), "the held tab lifts");

    pointer(view.strip, "pointermove", centreOf("tab-c"));
    assert.ok(tabEl(view.host, "tab-c").className.includes("is-drop-target"));
    // The dragged tab is never its own drop target.
    assert.ok(!tabEl(view.host, "tab-a").className.includes("is-drop-target"));

    pointer(view.strip, "pointercancel", centreOf("tab-c"));
    assert.ok(!tabEl(view.host, "tab-a").className.includes("is-dragging"));
    assert.ok(!tabEl(view.host, "tab-c").className.includes("is-drop-target"));
  } finally {
    view.cleanup();
  }
});

// A strip with no reorder handler (or a press on the strip's own padding) must
// never lift a tab — otherwise the hold would arm a drag that goes nowhere.
test("without onMove a hold never lifts a tab", async () => {
  const view = mount({ items: ITEMS, focusedTabId: "tab-a" });
  try {
    pointer(tabEl(view.host, "tab-a"), "pointerdown", centreOf("tab-a"));
    await waitForHold();
    assert.ok(!tabEl(view.host, "tab-a").className.includes("is-dragging"));
  } finally {
    view.cleanup();
  }
});

// Pressing a control is not the start of a gesture: the pin/close buttons sit
// inside the tab, and a lift would hijack the press.
test("pressing close or pin never starts a gesture", async () => {
  const closed = [];
  const view = mount({ items: ITEMS, focusedTabId: "tab-a", onClose: (id) => closed.push(id), onMove: () => {} });
  try {
    const closeButton = tabEl(view.host, "tab-b").querySelector(".session-tab-close");
    pointer(closeButton, "pointerdown", centreOf("tab-b"));
    await waitForHold();
    assert.ok(!tabEl(view.host, "tab-b").className.includes("is-dragging"));
    pointer(view.strip, "pointerup", centreOf("tab-b"));
    click(closeButton);
    assert.deepEqual(closed, ["tab-b"]);
  } finally {
    view.cleanup();
  }
});

// needs_input has to win over working: a thread paused on an approval still has a
// live turn, so without the override the tab would pulse "working" and hide that
// the user must act. Same priority the sidebar uses.
// Give the strip the scroll metrics jsdom can't compute, so the scrolling paths
// are exercised for real.
function stubScrollMetrics(strip, { scrollWidth = 900, clientWidth = 300 } = {}) {
  let scrollLeft = 0;
  Object.defineProperty(strip, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(strip, "clientWidth", { value: clientWidth, configurable: true });
  Object.defineProperty(strip, "scrollLeft", {
    configurable: true,
    get: () => scrollLeft,
    set: (value) => {
      scrollLeft = value;
    },
  });
  return () => scrollLeft;
}

// The strip keeps the focused tab in view, which must never fight the user: a pan
// that snapped back to the focused tab the moment the pointer lifted would make
// the overflow unreachable.
test("a pan survives the pointer coming up", () => {
  const view = mount({ items: ITEMS, focusedTabId: "tab-a" });
  try {
    const scrollLeft = stubScrollMetrics(view.strip);
    pointer(tabEl(view.host, "tab-b"), "pointerdown", centreOf("tab-b"));
    pointer(view.strip, "pointermove", centreOf("tab-b") - 120);
    assert.equal(scrollLeft(), 120, "the strip pans with the pointer");
    pointer(view.strip, "pointerup", centreOf("tab-b") - 120);
    assert.equal(scrollLeft(), 120, "and stays where it was left");
  } finally {
    view.cleanup();
  }
});

// The pointer is free to leave a 34px-tall strip mid-press, and the release then
// happens somewhere else entirely. Missing it left the hold timer to lift a tab
// nobody is dragging any more — a phantom that only a later click cleared.
test("a release outside the strip ends the gesture", async () => {
  const view = mount({ items: ITEMS, focusedTabId: "tab-a", onMove: () => {} });
  try {
    pointer(tabEl(view.host, "tab-a"), "pointerdown", centreOf("tab-a"));
    // Up somewhere else on the page, before the hold could arm anything.
    pointer(dom.window.document.body, "pointerup", 900);
    await waitForHold();
    assert.ok(
      !tabEl(view.host, "tab-a").className.includes("is-dragging"),
      "no tab may lift after the press was already released"
    );
  } finally {
    view.cleanup();
  }
});

// A release outside the browser window is delivered to nobody. Without this the
// strip would keep following the pointer with no button held — a drag that can
// only be ended by pressing again.
test("a move with no button held ends the gesture", async () => {
  const view = mount({ items: ITEMS, focusedTabId: "tab-a", onMove: () => {} });
  try {
    const scrollLeft = stubScrollMetrics(view.strip);
    pointer(tabEl(view.host, "tab-a"), "pointerdown", centreOf("tab-a"));
    await waitForHold();
    assert.ok(tabEl(view.host, "tab-a").className.includes("is-dragging"));

    pointer(view.strip, "pointermove", centreOf("tab-a") - 100, { buttons: 0 });
    assert.ok(
      !tabEl(view.host, "tab-a").className.includes("is-dragging"),
      "the lost pointer ends the reorder"
    );
    // And the strip no longer follows the pointer around.
    pointer(view.strip, "pointermove", centreOf("tab-a") - 300, { buttons: 0 });
    assert.equal(scrollLeft(), 0);
  } finally {
    view.cleanup();
  }
});

// A press outlives a render, and the strip is unmounted whenever the surface
// switches away. Cleanup must not go looking for the DOM node it just lost:
// listeners left on the window keep the whole component (and its callbacks) alive.
test("unmounting mid-press takes the window listeners with it", async () => {
  const moves = [];
  const before = windowListenerCount();
  const view = mount({ items: ITEMS, focusedTabId: "tab-a", onMove: (id, to) => moves.push([id, to]) });
  try {
    pointer(tabEl(view.host, "tab-a"), "pointerdown", centreOf("tab-a"));
    await waitForHold();
    assert.ok(windowListenerCount() > before, "the gesture is listening");
  } finally {
    view.cleanup();
  }

  assert.equal(windowListenerCount(), before, "every gesture listener came off");
  // And nothing left behind can still drive the unmounted strip.
  act(() => {
    dom.window.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
  });
  assert.deepEqual(moves, []);
});

// Widths differ by pinned state, so unpinning a tab shifts every tab after it
// without changing the strip's own size or the order of ids — the focused tab can
// slide out of view with nothing the strip observes having changed.
test("a pinned-state change re-reveals the focused tab", () => {
  const pinnedFirst = [{ ...ITEMS[0], pinned: true }, ITEMS[1], ITEMS[2]];
  const view = mount({ items: pinnedFirst, focusedTabId: "tab-a" });
  try {
    const scrollLeft = stubScrollMetrics(view.strip);
    act(() => {
      view.rerender({ items: pinnedFirst, focusedTabId: "tab-c" });
    });
    assert.equal(scrollLeft(), 220, "the focused tab starts revealed");

    // Unpin tab-a: same ids, same order, every later tab pushed right.
    const unpinned = [ITEMS[0], ITEMS[1], ITEMS[2]];
    for (const node of view.host.querySelectorAll("[data-tab-id]")) {
      const content = (TAB_X[node.getAttribute("data-tab-id")] ?? 0) + 52;
      node.getBoundingClientRect = () => {
        const left = content - view.strip.scrollLeft;
        return { left, right: left + 100, width: 100 };
      };
    }
    act(() => {
      view.rerender({ items: unpinned, focusedTabId: "tab-c" });
    });
    // tab-c now ends at 560; a 300px window at 220 stops at 520.
    assert.equal(scrollLeft(), 272, "the strip follows the tab that got pushed out");
  } finally {
    view.cleanup();
  }
});

test("a narrower strip pulls the focused tab back into view", () => {
  const view = mount({ items: ITEMS, focusedTabId: "tab-c" });
  try {
    const scrollLeft = stubScrollMetrics(view.strip, { clientWidth: 600 });
    const observer = resizeObservers.at(-1);
    assert.ok(observer, "the strip is observed for size changes");
    // Wide enough that nothing needed scrolling; now it is not.
    Object.defineProperty(view.strip, "clientWidth", { value: 200, configurable: true });
    act(() => {
      observer.callback();
    });
    assert.equal(scrollLeft(), 320, "the resize revealed the focused tab again");
  } finally {
    view.cleanup();
  }
});

// One gesture, one pointer. On a hybrid device a stray touch must not steer or
// commit a reorder the mouse is still holding.
test("a second pointer cannot drive or end the gesture", async () => {
  const moves = [];
  const view = mount({ items: ITEMS, focusedTabId: "tab-a", onMove: (id, to) => moves.push([id, to]) });
  try {
    pointer(tabEl(view.host, "tab-a"), "pointerdown", centreOf("tab-a"), { pointerId: 1 });
    await waitForHold();
    assert.ok(tabEl(view.host, "tab-a").className.includes("is-dragging"));

    // A different contact, moving and releasing over another tab.
    pointer(view.strip, "pointermove", centreOf("tab-c"), { pointerId: 2 });
    assert.ok(
      !tabEl(view.host, "tab-c").className.includes("is-drop-target"),
      "the stray pointer must not steer the drag"
    );
    pointer(view.strip, "pointerup", centreOf("tab-c"), { pointerId: 2 });
    assert.deepEqual(moves, [], "and must not commit it either");

    // A touch landing on the strip must not wipe the live gesture either.
    pointer(tabEl(view.host, "tab-b"), "pointerdown", centreOf("tab-b"), { pointerId: 3 });
    assert.ok(
      tabEl(view.host, "tab-a").className.includes("is-dragging"),
      "the held tab is still held"
    );

    // The original pointer still finishes the job.
    pointer(view.strip, "pointermove", centreOf("tab-c"), { pointerId: 1 });
    pointer(view.strip, "pointerup", centreOf("tab-c"), { pointerId: 1 });
    assert.deepEqual(moves, [["tab-a", 2]]);
  } finally {
    view.cleanup();
  }
});

// Pinning moves the focused tab to the front of the strip without changing its
// id. A strip scrolled to the end would keep showing the end, and the session
// actually on screen would have no visible tab.
test("reordering the strip re-reveals the focused tab", () => {
  const items = [...ITEMS];
  const view = mount({ items, focusedTabId: "tab-a" });
  try {
    const scrollLeft = stubScrollMetrics(view.strip);
    act(() => {
      view.rerender({ items, focusedTabId: "tab-c" });
    });
    assert.equal(scrollLeft(), 220, "the focused tab starts revealed");

    // Pin tab-c: same tabs, same focus, new order.
    const pinned = [items[2], items[0], items[1]];
    layout(view, ["tab-c", "tab-a", "tab-b"]);
    act(() => {
      view.rerender({ items: pinned, focusedTabId: "tab-c" });
    });
    // tab-c now sits at 200..300, left of a window that starts at 220.
    assert.equal(scrollLeft(), 188, "the strip follows the focused tab to its new slot");
  } finally {
    view.cleanup();
  }
});

// A press with no movement is a click, however long it is held — the lift is a
// cue that a drag is available, not a mode the release falls into.
test("a long stationary press still focuses the tab", async () => {
  const focused = [];
  const view = mount({
    items: ITEMS,
    focusedTabId: "tab-a",
    onMove: () => {},
    onFocus: (id) => focused.push(id),
  });
  try {
    const main = tabEl(view.host, "tab-b").querySelector(".session-tab-main");
    pointer(main, "pointerdown", centreOf("tab-b"));
    await waitForHold();
    pointer(view.strip, "pointerup", centreOf("tab-b"));
    click(main);
    assert.deepEqual(focused, ["tab-b"]);
  } finally {
    view.cleanup();
  }
});

test("focusing a tab that is out of view scrolls it back into the strip", () => {
  const view = mount({ items: ITEMS, focusedTabId: "tab-a" });
  try {
    const scrollLeft = stubScrollMetrics(view.strip);
    assert.equal(scrollLeft(), 0);
    act(() => {
      view.rerender({ items: ITEMS, focusedTabId: "tab-c" });
    });
    // tab-c spans 408..508 in a 300px window: the strip scrolls just far enough.
    assert.equal(scrollLeft(), 220);
  } finally {
    view.cleanup();
  }
});

// The wheel listener has to be bound by hand with {passive: false}: React
// registers wheel passively, so a preventDefault() from an onWheel prop would be
// ignored and the page would scroll along with the strip.
test("a vertical wheel pans the strip and keeps the gesture off the page", () => {
  const view = mount({ items: ITEMS, focusedTabId: "tab-a" });
  try {
    let scrollLeft = 0;
    Object.defineProperty(view.strip, "scrollWidth", { value: 900, configurable: true });
    Object.defineProperty(view.strip, "clientWidth", { value: 300, configurable: true });
    Object.defineProperty(view.strip, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (value) => {
        scrollLeft = value;
      },
    });

    const wheel = (deltaY) => {
      const event = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY });
      act(() => {
        view.strip.dispatchEvent(event);
      });
      return event;
    };

    assert.equal(wheel(120).defaultPrevented, true);
    assert.equal(scrollLeft, 120);
    // Never past the end, and once parked there the page gets the wheel back.
    assert.equal(wheel(9000).defaultPrevented, true);
    assert.equal(scrollLeft, 600);
    assert.equal(wheel(120).defaultPrevented, false, "at the end the page may scroll");
  } finally {
    view.cleanup();
  }
});

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

// ── Preview tabs ────────────────────────────────────────────────────────────
// The strip renders one tab that is quietly replaceable, so it must both LOOK
// different and offer the same keep gesture the sidebar row does.

const PREVIEW_ITEMS = [
  { tabId: "tab-a", threadId: "t1", title: "Alpha", pinned: false },
  { tabId: "tab-b", threadId: "t2", title: "Beta", pinned: false, preview: true },
];

test("a preview tab is marked, and only that tab", () => {
  const view = mount({ items: PREVIEW_ITEMS, focusedTabId: "tab-b" });

  assert.equal(tabEl(view.host, "tab-b").classList.contains("is-preview"), true);
  assert.equal(tabEl(view.host, "tab-a").classList.contains("is-preview"), false);

  view.cleanup();
});

// The browser's REAL sequence is click, click, dblclick — a double click always
// delivers its two clicks first. Emitting a single click here would be a friendly
// fiction that hides what the strip's own callbacks actually see (two focuses),
// and it is exactly the fiction that let the transition bug through: whether
// those clicks arrive at all is decided outside jsdom, by whether focusing a tab
// starts a view transition. The browser half of this contract lives in
// scripts/browser-local-session-tabs-e2e.mjs; this half proves the wiring.
test("double-clicking a tab keeps it, after the focuses its clicks already made", () => {
  const focused = [];
  const promoted = [];
  const view = mount({
    items: PREVIEW_ITEMS,
    focusedTabId: "tab-b",
    onFocus: (tabId) => focused.push(tabId),
    onPromote: (tabId) => promoted.push(tabId),
  });

  const main = tabEl(view.host, "tab-b").querySelector(".session-tab-main");
  click(main);
  click(main);
  act(() => {
    main.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });

  assert.deepEqual(promoted, ["tab-b"]);
  assert.deepEqual(
    focused,
    ["tab-b", "tab-b"],
    "both clicks focus; focusing the same tab twice is idempotent, so this is harmless"
  );

  view.cleanup();
});

// The close and pin controls own their own clicks (see the tests above); a double
// click on them must not leak a promotion for a tab that is being closed.
test("double-clicking the close control never promotes", () => {
  const promoted = [];
  const closed = [];
  const view = mount({
    items: PREVIEW_ITEMS,
    focusedTabId: "tab-b",
    onClose: (tabId) => closed.push(tabId),
    onPromote: (tabId) => promoted.push(tabId),
  });

  const closeButton = tabEl(view.host, "tab-b").querySelector(".session-tab-close");
  act(() => {
    closeButton.dispatchEvent(
      new dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true })
    );
  });

  assert.deepEqual(promoted, []);

  view.cleanup();
});
