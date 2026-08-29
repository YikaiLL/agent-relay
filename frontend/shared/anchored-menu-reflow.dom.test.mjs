// Placement is derived from the menu's measured size, so content that changes
// while the menu is OPEN invalidates it.
//
// The dangerous direction is upward placement. A menu opening DOWNWARD is
// anchored by its top edge, so resizing it moves only its bottom and nothing
// looks wrong. A menu opening UPWARD is anchored by its BOTTOM edge — its `top`
// is `triggerTop - gap - height` — so every size change must move `top` too. Miss
// that and a menu which shrinks floats away from its trigger, and one that grows
// back expands downward across the control that opened it.
//
// This is a jsdom test on purpose: jsdom has no layout, which means the rects are
// whatever the test says they are. That is what makes an upward-placed,
// content-resizing menu constructible at all — the browser suite's real dialogs
// place these menus downward, so a stale-placement regression is invisible there.
import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;

// Captured so the test can drive a resize the way the browser would.
const observers = [];
dom.window.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    this.targets = [];
    observers.push(this);
  }

  observe(target) {
    this.targets.push(target);
  }

  disconnect() {
    this.targets = [];
  }
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SettingPill } = await import("./setting-pill.js");

const h = React.createElement;

const VIEWPORT = { height: 800, width: 400 };
// Low on screen: 52px below it, 682px above it. Anything tall must open upward.
const TRIGGER = { bottom: 730, height: 30, left: 20, right: 200, top: 700, width: 180 };
const GAP = 6;

function rect(box) {
  return () => ({ ...box, toJSON: () => box });
}

test("an upward menu is re-placed when its content changes size", () => {
  dom.window.innerWidth = VIEWPORT.width;
  dom.window.innerHeight = VIEWPORT.height;
  observers.length = 0;

  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);

  try {
    act(() =>
      root.render(
        h(SettingPill, {
          label: "Model",
          options: [{ label: "GPT-5.6-Sol", value: "sol" }],
          value: "GPT-5.6-Sol",
        })
      )
    );

    const trigger = host.querySelector(".setting-pill-trigger");
    trigger.getBoundingClientRect = rect(TRIGGER);

    // The menu does not exist until it opens, so its rect is stubbed through the
    // prototype and then narrowed to the node once React has created it.
    let menuHeight = 400;
    const menuRectFor = () => ({
      bottom: menuHeight,
      height: menuHeight,
      left: 0,
      right: 260,
      top: 0,
      width: 260,
    });
    dom.window.HTMLDivElement.prototype.getBoundingClientRect = function stub() {
      return this.classList?.contains("setting-pill-menu")
        ? { ...menuRectFor(), toJSON: () => menuRectFor() }
        : { bottom: 0, height: 0, left: 0, right: 0, toJSON: () => ({}), top: 0, width: 0 };
    };

    act(() => {
      trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });

    const menu = host.querySelector(".setting-pill-menu");
    assert.ok(menu, "menu did not open");
    assert.equal(menu.dataset.placement, "above", "a 400px menu must open upward here");
    // bottom edge parked just above the trigger: 700 - 6 - 400
    assert.equal(menu.style.top, `${TRIGGER.top - GAP - 400}px`);

    const observer = observers.find((o) => o.targets.includes(menu));
    assert.ok(observer, "the menu's size is not observed, so content changes cannot re-place it");

    // Filter the list down, the way typing in the workspace combobox does.
    menuHeight = 100;
    act(() => observer.callback([{ target: menu }], observer));

    assert.equal(
      menu.style.top,
      `${TRIGGER.top - GAP - 100}px`,
      "a shrunken upward menu kept the `top` computed for its old height, so it is now "
        + "floating away from its trigger"
    );

    // …and back up, the direction that grows a menu over its own trigger.
    menuHeight = 400;
    act(() => observer.callback([{ target: menu }], observer));
    assert.equal(menu.style.top, `${TRIGGER.top - GAP - 400}px`);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

// The visual viewport is both SMALLER than the layout viewport and OFFSET within
// it while a software keyboard is up or a pinch zoom is active. `getBoundingClientRect`
// reports layout coordinates, so using the visual viewport's size while ignoring
// its offset mixes two coordinate systems — and lands the menu outside the part
// of the page that is actually on screen.
test("placement accounts for the visual viewport's offset, not just its size", () => {
  dom.window.innerWidth = 800;
  dom.window.innerHeight = 800;
  // Panned right: only layout-x 100..400 is visible.
  dom.window.visualViewport = {
    addEventListener() {},
    height: 800,
    offsetLeft: 100,
    offsetTop: 0,
    removeEventListener() {},
    width: 300,
  };
  observers.length = 0;

  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);

  try {
    act(() =>
      root.render(
        h(SettingPill, {
          label: "Model",
          options: [{ label: "GPT-5.6-Sol", value: "sol" }],
          value: "GPT-5.6-Sol",
        })
      )
    );

    // Near the right edge of the VISIBLE region, so the menu must right-align.
    const trigger = host.querySelector(".setting-pill-trigger");
    trigger.getBoundingClientRect = rect({
      bottom: 130,
      height: 30,
      left: 350,
      right: 380,
      top: 100,
      width: 30,
    });

    const menuRect = { bottom: 200, height: 200, left: 0, right: 260, top: 0, width: 260 };
    dom.window.HTMLDivElement.prototype.getBoundingClientRect = function stub() {
      return this.classList?.contains("setting-pill-menu")
        ? { ...menuRect, toJSON: () => menuRect }
        : { bottom: 0, height: 0, left: 0, right: 0, toJSON: () => ({}), top: 0, width: 0 };
    };

    act(() => {
      trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });

    const menu = host.querySelector(".setting-pill-menu");
    assert.equal(menu.dataset.alignment, "right");
    // Right-aligned to the trigger at layout-x 380: 380 - 260 = 120, which is
    // inside the visible band. Ignoring `offsetLeft` clamps against a band that
    // starts at 0 instead of 100 and yields 28 — 72px off, and off screen.
    assert.equal(
      menu.style.left,
      "120px",
      "placement clamped against the layout viewport instead of the visible one"
    );
  } finally {
    act(() => root.unmount());
    host.remove();
    delete dom.window.visualViewport;
  }
});
