// MenuPortal can defer its first render until a layout effect resolves the portal
// target. The passive placement effect must subscribe once the menu node actually
// exists — initial placement alone is not enough.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;

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
const { act, useLayoutEffect, useRef, useState } = React;
const { createRoot } = await import("react-dom/client");
const { useAnchoredMenu } = await import("./use-anchored-menu.js");

const h = React.createElement;

function rect(box) {
  return () => ({ ...box, toJSON: () => box });
}

function DeferredMenuHarness({ deferMenu = true }) {
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const assignMenuRef = useAnchoredMenu({ menuRef, open: true, triggerRef });
  const [showMenu, setShowMenu] = useState(!deferMenu);

  useLayoutEffect(() => {
    if (deferMenu) {
      setShowMenu(true);
    }
  }, [deferMenu]);

  return h(
    "div",
    null,
    h("button", { id: "trigger", ref: triggerRef, type: "button" }),
    showMenu
      ? h("div", { className: "setting-pill-menu", ref: assignMenuRef, role: "menu" }, "Option")
      : null
  );
}

test("a deferred menu mount still installs resize observers and re-places", () => {
  observers.length = 0;
  dom.window.innerWidth = 400;
  dom.window.innerHeight = 800;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  try {
    act(() => {
      root.render(h(DeferredMenuHarness, { deferMenu: true }));
    });

    const trigger = host.querySelector("#trigger");
    const menu = host.querySelector(".setting-pill-menu");
    assert.ok(menu, "menu should mount after the deferred frame");
    assert.equal(menu.dataset.placed, "true", "menu should be placed once mounted");

    const observer = observers.find((entry) => entry.targets.includes(menu));
    assert.ok(observer, "ResizeObserver must subscribe after the deferred mount");

    trigger.getBoundingClientRect = rect({
      bottom: 760,
      height: 30,
      left: 20,
      right: 200,
      top: 730,
      width: 180,
    });

    let menuHeight = 400;
    dom.window.HTMLDivElement.prototype.getBoundingClientRect = function stub() {
      return this.classList?.contains("setting-pill-menu")
        ? { bottom: menuHeight, height: menuHeight, left: 0, right: 260, top: 0, width: 260, toJSON: () => ({}) }
        : { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, toJSON: () => ({}) };
    };

    const topBeforeResize = menu.style.top;

    menuHeight = 100;
    act(() => {
      observer.callback([{ target: menu }], observer);
    });

    assert.notEqual(
      menu.style.top,
      topBeforeResize,
      "content-driven resize must re-place the menu after a deferred mount"
    );

    act(() => {
      dom.window.dispatchEvent(new dom.window.Event("resize"));
    });
    assert.equal(menu.dataset.placed, "true", "window resize must keep the menu placed");
  } finally {
    act(() => root.unmount());
    host.remove();
    observers.length = 0;
  }
});
