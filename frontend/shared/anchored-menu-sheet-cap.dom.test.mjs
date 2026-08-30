// An anchored menu measures itself UNCONSTRAINED to learn its natural size, which
// means clearing `max-height` — and `max-height: none` deliberately clears the
// stylesheet's cap too, not just a stale inline value. The bug is that the cap is
// never put back: placement is computed from the natural height, and the inline
// `max-height` written afterwards is the available SPACE, so a menu whose own CSS
// says "never taller than 420px" is allowed to fill the viewport.
//
// The workspace picker is where this bites. Its panel caps at 420px on purpose and
// scrolls a nested row list; with enough rows the panel instead grew to 662px, and
// being that tall it no longer fit under its trigger, so placement moved it away —
// leaving a menu detached from the control that opened it.
//
// jsdom on purpose: no layout, so the natural size and the trigger box are exactly
// what this test says they are. That is what makes "content taller than the cap"
// constructible without a real browser.
import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

const SHEET_CAP_PX = 420;
const VIEWPORT = { height: 900, width: 1280 };
// Low enough that a 420px menu fits underneath, tall enough that an uncapped one
// does not — which is what used to push it off the trigger.
const TRIGGER = { bottom: 62, height: 26, left: 100, right: 400, top: 36, width: 300 };
const NATURAL_MENU_HEIGHT = 1054;
const ATTACH_TOLERANCE_PX = 28;

const dom = new JSDOM(
  `<!doctype html><html><head><style>.capped-menu { max-height: ${SHEET_CAP_PX}px; }</style></head><body></body></html>`,
  { url: "http://localhost/", pretendToBeVisual: true }
);
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
global.ResizeObserver = dom.window.ResizeObserver;

function rect(box) {
  return { ...box, toJSON: () => box };
}

// The menu reports its natural (uncapped) height, which is the measurement the
// placement code takes while `max-height` is cleared.
dom.window.HTMLElement.prototype.getBoundingClientRect = function stub() {
  if (this.classList?.contains("capped-menu")) {
    return rect({
      bottom: NATURAL_MENU_HEIGHT,
      height: NATURAL_MENU_HEIGHT,
      left: 0,
      right: 420,
      top: 0,
      width: 420,
    });
  }
  if (this.classList?.contains("trigger")) return rect(TRIGGER);
  return rect({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 });
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAnchoredMenu } = await import("./use-anchored-menu.js");

const h = React.createElement;

function Harness() {
  const triggerRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const assignMenuRef = useAnchoredMenu({ menuRef, open: true, triggerRef });
  return h(
    "div",
    null,
    h("button", { className: "trigger", ref: triggerRef }, "open"),
    h("div", { className: "capped-menu", ref: assignMenuRef }, "rows")
  );
}

function place() {
  dom.window.innerWidth = VIEWPORT.width;
  dom.window.innerHeight = VIEWPORT.height;
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(h(Harness)));
  const menu = host.querySelector(".capped-menu");
  const placed = {
    maxHeight: Number.parseFloat(menu.style.maxHeight),
    top: Number.parseFloat(menu.style.top),
  };
  act(() => root.unmount());
  host.remove();
  return placed;
}

test("placement never lets a menu exceed the max-height its own stylesheet sets", () => {
  const { maxHeight, top } = place();

  assert.ok(
    maxHeight <= SHEET_CAP_PX,
    `the panel caps itself at ${SHEET_CAP_PX}px and scrolls its contents, but placement `
      + `wrote max-height: ${maxHeight}px — the available space, with the stylesheet's own `
      + "cap cleared during measurement and never restored"
  );

  // Not a second bug, and green before the fix too: honouring the cap changes the
  // height placement reasons about, so this pins that the menu does not get moved
  // off its trigger on the way. Reproducing the real detachment needs a clipping
  // ancestor (the panel sits inside a modal dialog), which jsdom has no layout for.
  assert.ok(
    Math.abs(top - TRIGGER.bottom) <= ATTACH_TOLERANCE_PX,
    `a ${SHEET_CAP_PX}px menu fits below a trigger whose bottom is ${TRIGGER.bottom}px in a `
      + `${VIEWPORT.height}px viewport, so it must open there; placement put it at ${top}px`
  );
});
