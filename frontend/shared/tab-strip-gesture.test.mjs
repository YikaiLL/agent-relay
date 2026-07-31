// The arbitration rules for the tab strip's two horizontal drags. The component
// test (session-tab-strip.dom.test.mjs) proves they're wired to the DOM; these
// prove the rules themselves, which is where the off-by-one and "which gesture
// wins" mistakes live.
import test from "node:test";
import assert from "node:assert/strict";

import {
  PAN_SLOP_PX,
  createStripGesture,
  edgeScrollStep,
  resolveDropTabId,
  scrollLeftToReveal,
  wheelScrollDelta,
} from "./tab-strip-gesture.js";

test("a press that moves pans the strip, content following the pointer", () => {
  const gesture = createStripGesture();
  assert.equal(gesture.down({ tabId: "tab-a", x: 100, scrollLeft: 40 }), true);
  // Under the slop the press is still a click in waiting.
  assert.equal(gesture.move({ x: 100 + PAN_SLOP_PX - 1 }), null);
  assert.equal(gesture.mode, "pending");

  const step = gesture.move({ x: 60 });
  assert.equal(step.mode, "panning");
  // Dragged 40px left → 40px further into the strip.
  assert.equal(step.scrollLeft, 80);
  assert.deepEqual(gesture.up(), { mode: "panning", tabId: "tab-a", moved: true });
});

test("holding first arms a reorder, and moving then no longer pans", () => {
  const gesture = createStripGesture();
  gesture.down({ tabId: "tab-a", x: 100, scrollLeft: 40 });
  assert.equal(gesture.hold(), true);
  assert.equal(gesture.mode, "reorder");

  const step = gesture.move({ x: 220 });
  assert.equal(step.mode, "reorder");
  assert.equal(step.tabId, "tab-a");
  assert.equal(step.scrollLeft, undefined, "a reorder must not also pan the strip");
  assert.deepEqual(gesture.up(), { mode: "reorder", tabId: "tab-a", moved: true });
});

// The timer and the pointer race on every drag: if the hold fires after the pan
// has already started, honouring it would yank a tab out of the strip mid-swipe.
test("a hold that lands after the pan started is ignored", () => {
  const gesture = createStripGesture();
  gesture.down({ tabId: "tab-a", x: 100, scrollLeft: 0 });
  gesture.move({ x: 40 });
  assert.equal(gesture.mode, "panning");
  assert.equal(gesture.hold(), false);
  assert.equal(gesture.mode, "panning");
});

test("a hold on empty strip background cannot arm a reorder", () => {
  const gesture = createStripGesture();
  gesture.down({ tabId: null, x: 100, scrollLeft: 0 });
  assert.equal(gesture.hold(), false);
  assert.equal(gesture.mode, "pending");
});

test("a press that never moves stays a click", () => {
  const gesture = createStripGesture();
  gesture.down({ tabId: "tab-a", x: 100, scrollLeft: 0 });
  gesture.move({ x: 102 });
  const result = gesture.up();
  assert.equal(result.moved, false, "an unmoved press must still focus the tab");
  assert.equal(result.mode, "pending");
});

test("secondary buttons and touch are left to the browser", () => {
  const gesture = createStripGesture();
  assert.equal(gesture.down({ tabId: "tab-a", x: 0, button: 2 }), false);
  assert.equal(gesture.mode, "idle");
  assert.equal(gesture.down({ tabId: "tab-a", x: 0, pointerType: "touch" }), false);
  assert.equal(gesture.mode, "idle");
  assert.equal(gesture.move({ x: 400 }), null);
});

test("the drop target is the nearest tab, including gaps and past the ends", () => {
  const rects = [
    { tabId: "tab-a", left: 0, right: 100 },
    { tabId: "tab-b", left: 104, right: 204 },
    { tabId: "tab-c", left: 208, right: 308 },
  ];
  assert.equal(resolveDropTabId(50, rects), "tab-a");
  assert.equal(resolveDropTabId(150, rects), "tab-b");
  // In the 4px gap: nearest wins rather than clearing the target.
  assert.equal(resolveDropTabId(205, rects), "tab-b");
  // Past either end clamps instead of dropping the drag.
  assert.equal(resolveDropTabId(-80, rects), "tab-a");
  assert.equal(resolveDropTabId(9999, rects), "tab-c");
  assert.equal(resolveDropTabId(50, []), null);
});

test("a reorder drag at the edge pulls the strip with it", () => {
  const bounds = { left: 0, right: 400 };
  assert.equal(edgeScrollStep(10, bounds) < 0, true);
  assert.equal(edgeScrollStep(390, bounds) > 0, true);
  assert.equal(edgeScrollStep(200, bounds), 0);
  assert.equal(edgeScrollStep(200, { left: 0, right: 0 }), 0, "a collapsed strip never scrolls");
});

test("revealing a tab moves the strip the shortest way, and not past its ends", () => {
  const base = { viewport: 400, max: 600, margin: 10 };
  // Already in view: untouched.
  assert.equal(scrollLeftToReveal({ ...base, scrollLeft: 0, start: 100, end: 200 }), 0);
  // Off the right edge: scroll just far enough.
  assert.equal(scrollLeftToReveal({ ...base, scrollLeft: 0, start: 500, end: 600 }), 210);
  // Off the left edge.
  assert.equal(scrollLeftToReveal({ ...base, scrollLeft: 300, start: 100, end: 200 }), 90);
  // Never negative, never past the scrollable width.
  assert.equal(scrollLeftToReveal({ ...base, scrollLeft: 20, start: 0, end: 100 }), 0);
  assert.equal(scrollLeftToReveal({ ...base, scrollLeft: 0, start: 5000, end: 5100 }), 600);
  // An unmeasured strip (never laid out) is left alone.
  assert.equal(scrollLeftToReveal({ scrollLeft: 42, viewport: 0, start: 900, end: 1000 }), 42);
});

test("a vertical wheel scrolls the strip sideways", () => {
  assert.equal(wheelScrollDelta({ deltaY: 120 }), 120);
  assert.equal(wheelScrollDelta({ deltaY: -120 }), -120);
  // A trackpad's horizontal axis wins when it is the dominant one.
  assert.equal(wheelScrollDelta({ deltaX: -40, deltaY: 3 }), -40);
  // Line and page deltas are pixels once scaled.
  assert.equal(wheelScrollDelta({ deltaY: 3, deltaMode: 1 }), 48);
  assert.equal(wheelScrollDelta({ deltaY: 1, deltaMode: 2 }, 500), 500);
  assert.equal(wheelScrollDelta({}), 0);
});
