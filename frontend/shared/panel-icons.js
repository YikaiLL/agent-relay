// Panel and header glyphs, drawn once.
//
// These four existed twice, byte-for-byte, differing only by a `Remote` prefix on the
// function name: `ToggleLeftPanelIcon` / `RemoteToggleLeftPanelIcon`, and the same for the
// right-panel toggle, the back arrow and the compose mark. Identical viewBox, identical
// stroke width, identical path coordinates.
//
// That is the most expensive kind of duplication to leave alone, because nothing about it
// looks wrong: a nudge to one surface's icon geometry simply never reaches the other, and
// the drift surfaces as "the panel toggle looks slightly different on my phone" long after
// the change that caused it.
//
// These are inline SVG COMPONENTS rather than entries in `svg.js` (which holds markup
// strings injected with `dangerouslySetInnerHTML`). The distinction matters: real elements
// need no `pointer-events: none` defence, because React reconciles them in place instead of
// replacing the subtree, so a re-render mid-gesture cannot swallow a click the way an
// innerHTML swap does.
//
// `stroke="currentColor"` throughout, so the button's own colour drives the glyph and
// hover/selected states need no icon-specific rules.
//
// Geometry here is copied EXACTLY from the originals — sizes included, which is why the
// back arrow is 14px while the rest are 16px. `panel-icons.test.mjs` pins every coordinate
// so a future change to any of them has to be deliberate rather than incidental.

import React from "react";

const h = React.createElement;

// Shared by the two panel toggles only. The back arrow and the compose mark carry their
// own attributes (different size, extra line joins), so folding them in here would mean
// overriding more than it saved.
const PANEL_STROKE = {
  "aria-hidden": "true",
  fill: "none",
  height: "16",
  viewBox: "0 0 16 16",
  width: "16",
  stroke: "currentColor",
  strokeWidth: "1.4",
};

// A panel outline with the divider on the LEFT — the sidebar's edge. Its mirrored twin
// below is the right rail, and the ONLY difference is which x the line sits at (6 vs 10),
// which is exactly why they belong next to each other.
export function ToggleLeftPanelIcon() {
  return h(
    "svg",
    PANEL_STROKE,
    h("rect", { x: "1.5", y: "2.5", width: "13", height: "11", rx: "2" }),
    h("line", { x1: "6", y1: "2.5", x2: "6", y2: "13.5" })
  );
}

export function ToggleRightPanelIcon() {
  return h(
    "svg",
    PANEL_STROKE,
    h("rect", { x: "1.5", y: "2.5", width: "13", height: "11", rx: "2" }),
    h("line", { x1: "10", y1: "2.5", x2: "10", y2: "13.5" })
  );
}

// 14px, not 16: it sits inline beside text rather than alone in a square button.
export function BackArrowIcon() {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      fill: "none",
      height: "14",
      viewBox: "0 0 16 16",
      width: "14",
      stroke: "currentColor",
      strokeWidth: "1.6",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    h("path", { d: "M10 3.5L5.5 8L10 12.5" })
  );
}

export function ComposeIcon() {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      fill: "none",
      height: "16",
      viewBox: "0 0 16 16",
      width: "16",
      stroke: "currentColor",
      strokeWidth: "1.4",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    h("path", { d: "M2.5 13.5h4l6.5-6.5a1.8 1.8 0 0 0-2.5-2.5L4 11v2.5z" }),
    h("path", { d: "M10 5.5l2 2" })
  );
}
