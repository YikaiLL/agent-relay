// A modal dialog centres over the viewport while its DOM parent may sit
// anywhere, so the ancestor chain can describe bounds the dialog never occupies.
import assert from "node:assert/strict";
import test from "node:test";

import { placementBounds } from "./use-anchored-menu.js";

const VIEWPORT = { width: 1440, height: 759 };

function box({ left, top, width, height }) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/** A stand-in element; only the bits `placementBounds` actually touches. */
function el({ tag = "DIV", rect, overflow = "visible", modal = false, parent = null }) {
  return {
    tagName: tag,
    open: modal,
    matches: (sel) => sel === ":modal" && modal,
    parentElement: parent,
    getBoundingClientRect: () => rect,
    _overflow: overflow,
  };
}

function view() {
  return {
    innerWidth: VIEWPORT.width,
    innerHeight: VIEWPORT.height,
    visualViewport: { offsetLeft: 0, offsetTop: 0, width: VIEWPORT.width, height: VIEWPORT.height },
    getComputedStyle: (node) => ({
      overflow: node._overflow,
      overflowX: node._overflow,
      overflowY: node._overflow,
    }),
  };
}

// A modal dialog centred at 470..970 whose DOM parent is a rail at 1071..1440,
// disjoint on the x axis.
function reviewDialogInsideRail() {
  const body = el({ tag: "BODY", rect: box({ left: 0, top: 0, width: 1440, height: 759 }) });
  const rail = el({
    rect: box({ left: 1071, top: 0, width: 369, height: 759 }),
    overflow: "hidden",
    parent: body,
  });
  const dialog = el({
    tag: "DIALOG",
    rect: box({ left: 470, top: 17, width: 500, height: 725 }),
    // A modal dialog's UA stylesheet is `overflow: auto` — it really does clip
    // its own children, so it must still be intersected.
    overflow: "auto",
    modal: true,
    parent: rail,
  });
  return { dialog, menu: el({ rect: box({ left: 0, top: 0, width: 420, height: 340 }), parent: dialog }) };
}

test("a modal dialog's DOM ancestors do not clip the menu inside it", () => {
  const { menu } = reviewDialogInsideRail();
  const bounds = placementBounds(view(), menu);

  // The dialog is in the top layer; the rail it happens to be parented under is
  // irrelevant to where the menu may go.
  assert.equal(bounds.left, 470, "bounds must start at the dialog, not at the rail's left edge");
  assert.equal(bounds.width, 500, "the dialog's own width is the room available");
  assert.equal(bounds.top, 17);
  assert.equal(bounds.height, 725);
});

test("bounds are never empty, so the width cap can never go negative", () => {
  const { menu } = reviewDialogInsideRail();
  const bounds = placementBounds(view(), menu);

  assert.ok(bounds.width > 0, "an empty rect gives the menu no room to be placed in");
  assert.ok(bounds.height > 0);
  // The hook writes `maxWidth = bounds.width - 2 * CONTEXT_MENU_MARGIN_PX`.
  assert.ok(
    bounds.width - 24 > 0,
    "the width cap must stay positive, since CSS drops a negative max-width"
  );
});

test("bounds stay inside the viewport even when an ancestor does not", () => {
  const { menu } = reviewDialogInsideRail();
  const bounds = placementBounds(view(), menu);

  assert.ok(bounds.left >= 0, "a menu may never be placed off the left edge");
  assert.ok(
    bounds.left + bounds.width <= VIEWPORT.width,
    "and never past the right edge"
  );
});

test("a real clipping ancestor still constrains a menu that is NOT in a dialog", () => {
  // The rail's own picker: no dialog anywhere, so the rail must keep clipping it.
  // This is the case the top-layer rule must not regress.
  const body = el({ tag: "BODY", rect: box({ left: 0, top: 0, width: 1440, height: 759 }) });
  const rail = el({
    rect: box({ left: 1071, top: 0, width: 369, height: 759 }),
    overflow: "hidden",
    parent: body,
  });
  const menu = el({ rect: box({ left: 0, top: 0, width: 420, height: 340 }), parent: rail });

  const bounds = placementBounds(view(), menu);
  assert.equal(bounds.left, 1071, "the rail still bounds its own picker");
  assert.equal(bounds.width, 369);
});

test("a non-modal dialog is still clipped by its ancestors", () => {
  // Only `showModal()` promotes to the top layer. A plain `<dialog open>` lives
  // in normal flow and its ancestors clip it as usual.
  const body = el({ tag: "BODY", rect: box({ left: 0, top: 0, width: 1440, height: 759 }) });
  const scroller = el({
    rect: box({ left: 100, top: 0, width: 300, height: 400 }),
    overflow: "auto",
    parent: body,
  });
  const dialog = el({
    tag: "DIALOG",
    rect: box({ left: 100, top: 0, width: 500, height: 500 }),
    overflow: "auto",
    modal: false,
    parent: scroller,
  });
  const menu = el({ rect: box({ left: 0, top: 0, width: 200, height: 100 }), parent: dialog });

  const bounds = placementBounds(view(), menu);
  assert.equal(bounds.width, 300, "the scrolling ancestor must still win over a non-modal dialog");
  assert.equal(bounds.height, 400);
});
