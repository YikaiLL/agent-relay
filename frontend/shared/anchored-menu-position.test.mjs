import assert from "node:assert/strict";
import test from "node:test";

import { ANCHORED_MENU_GAP_PX, placeAnchoredMenu } from "./context-menu-position.js";

// Regression: the picker menus in the New session / Fork session dialogs were
// placed purely in CSS with `top: calc(100% + 6px)` off a `position: relative`
// trigger. At ≤600px the phone stylesheet made the trigger `position: static`
// so it could re-anchor the menu horizontally to the dialog body — which
// silently redefined that `100%` as the height of the whole scrolling body.
// Every menu landed a dialog-height below its pill, outside the clip, and read
// as "the dropdown doesn't open".
//
// Placement is now measured, viewport-relative, and flip-aware — the same
// treatment the sidebar context menus already had. These cases pin the parts a
// CSS-only version cannot express: flipping up, capping the height to the space
// actually available, and never detaching from the trigger.

const VIEWPORT = { viewportHeight: 800, viewportWidth: 1200 };
const GAP = ANCHORED_MENU_GAP_PX;

// A pill sitting near the top of the screen.
const TOP_TRIGGER = { triggerBottom: 140, triggerLeft: 300, triggerRight: 440, triggerTop: 110 };
// The same pill near the bottom — the case the old CSS could not handle.
const BOTTOM_TRIGGER = { triggerBottom: 760, triggerLeft: 300, triggerRight: 440, triggerTop: 730 };

test("opens below the trigger when there is room", () => {
  const placement = placeAnchoredMenu({
    menuHeight: 300,
    menuWidth: 240,
    ...TOP_TRIGGER,
    ...VIEWPORT,
  });
  assert.equal(placement.placement, "below");
  assert.equal(placement.top, TOP_TRIGGER.triggerBottom + GAP);
  assert.equal(placement.left, TOP_TRIGGER.triggerLeft);
});

test("flips above the trigger when the menu would run off the bottom", () => {
  const placement = placeAnchoredMenu({
    menuHeight: 300,
    menuWidth: 240,
    ...BOTTOM_TRIGGER,
    ...VIEWPORT,
  });
  assert.equal(placement.placement, "above");
  // Its bottom edge sits just above the trigger's top edge.
  assert.equal(placement.top + 300, BOTTOM_TRIGGER.triggerTop - GAP);
});

test("stays attached to the trigger, never merely clamped into the viewport", () => {
  // The failure this rules out: a fix that only clamps would satisfy "on screen"
  // while leaving the menu floating away from the control it belongs to.
  for (const trigger of [TOP_TRIGGER, BOTTOM_TRIGGER]) {
    const menuHeight = 300;
    const placement = placeAnchoredMenu({
      menuHeight,
      menuWidth: 240,
      ...trigger,
      ...VIEWPORT,
    });
    // What the menu actually renders at — `maxHeight` is the room available, not
    // the height taken, and they differ whenever the content is the shorter one.
    const rendered = Math.min(menuHeight, placement.maxHeight);
    const attachedBelow = Math.abs(placement.top - trigger.triggerBottom);
    const attachedAbove = Math.abs(trigger.triggerTop - (placement.top + rendered));
    assert.ok(
      attachedBelow <= GAP || attachedAbove <= GAP,
      `menu detached from trigger: ${JSON.stringify({ placement, trigger })}`
    );
  }
});

test("caps the height to the space available, so a long list scrolls in place", () => {
  // The Model list is taller than either side of a phone screen. It must be told
  // how much room it actually has rather than overflowing off the edge.
  const placement = placeAnchoredMenu({
    menuHeight: 2000,
    menuWidth: 240,
    ...TOP_TRIGGER,
    ...VIEWPORT,
  });
  assert.equal(placement.placement, "below");
  assert.equal(placement.maxHeight, 800 - 12 - (140 + GAP));
  assert.ok(placement.top + placement.maxHeight <= VIEWPORT.viewportHeight - 12);
});

test("a menu taller than either side takes the roomier one", () => {
  // Trigger just above centre: more room below than above.
  const placement = placeAnchoredMenu({
    menuHeight: 2000,
    menuWidth: 240,
    triggerBottom: 380,
    triggerLeft: 300,
    triggerRight: 440,
    triggerTop: 350,
    ...VIEWPORT,
  });
  assert.equal(placement.placement, "below");

  // And just below centre: more room above.
  const flipped = placeAnchoredMenu({
    menuHeight: 2000,
    menuWidth: 240,
    triggerBottom: 460,
    triggerLeft: 300,
    triggerRight: 440,
    triggerTop: 430,
    ...VIEWPORT,
  });
  assert.equal(flipped.placement, "above");
});

test("right-aligns to the trigger when the menu would overflow the right edge", () => {
  const placement = placeAnchoredMenu({
    menuHeight: 200,
    menuWidth: 360,
    triggerBottom: 140,
    triggerLeft: 1000,
    triggerRight: 1140,
    triggerTop: 110,
    ...VIEWPORT,
  });
  assert.equal(placement.alignment, "right");
  assert.equal(placement.left, 1140 - 360);
});

test("a menu wider than the viewport pins to the left margin instead of going negative", () => {
  // The phone case: a 360px menu on a 390px screen, triggered by a pill on the
  // right-hand side of the row.
  const placement = placeAnchoredMenu({
    menuHeight: 200,
    menuWidth: 420,
    triggerBottom: 140,
    triggerLeft: 240,
    triggerRight: 370,
    triggerTop: 110,
    viewportHeight: 844,
    viewportWidth: 390,
  });
  assert.ok(placement.left >= 12, `left ${placement.left} must respect the margin`);
});

test("never returns a negative height for a trigger flush against an edge", () => {
  const placement = placeAnchoredMenu({
    menuHeight: 300,
    menuWidth: 240,
    triggerBottom: 844,
    triggerLeft: 20,
    triggerRight: 160,
    triggerTop: 820,
    viewportHeight: 844,
    viewportWidth: 390,
  });
  assert.ok(placement.maxHeight >= 0, `maxHeight ${placement.maxHeight} must not be negative`);
  assert.ok(placement.top >= 0, `top ${placement.top} must not be negative`);
});
