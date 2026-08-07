// Geometry guards for the four glyphs that used to exist twice.
//
// Each was byte-for-byte duplicated between `local/react-shell.js` and
// `remote/react-app.js`, differing only by a `Remote` prefix on the function name. The
// coordinates below are pinned not because these numbers are sacred, but because the
// failure mode of an ACCIDENTAL change is invisible: a glyph that shifts by half a pixel
// looks fine in isolation and only reads as wrong beside the version that did not change.
// Now there is one version, and changing it has to be deliberate.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  BackArrowIcon,
  ComposeIcon,
  ToggleLeftPanelIcon,
  ToggleRightPanelIcon,
} from "./panel-icons.js";

const h = React.createElement;
const render = (Component) => renderToStaticMarkup(h(Component));

// The two toggles are the same outline with the divider on opposite sides — that mirroring
// IS the meaning, so it gets asserted rather than assumed. Swapping them (a plausible
// copy-paste) would leave both looking like plausible icons pointing the wrong way.
test("the panel toggles are one outline mirrored, differing only in the divider's x", () => {
  const left = render(ToggleLeftPanelIcon);
  const right = render(ToggleRightPanelIcon);

  for (const html of [left, right]) {
    assert.match(html, /<rect x="1.5" y="2.5" width="13" height="11" rx="2"/);
    // Asserted separately: React emits attributes in prop order, so `height` and `width`
    // are not adjacent in the output and a combined pattern would pin the ordering rather
    // than the sizes.
    assert.match(html, /\bwidth="16"/);
    assert.match(html, /\bheight="16"/);
  }
  assert.match(left, /x1="6"[^/]*x2="6"/, "the sidebar's divider sits on the LEFT");
  assert.match(right, /x1="10"[^/]*x2="10"/, "the right rail's sits on the RIGHT");
  assert.notEqual(left, right, "if these ever render the same, one of them is wrong");
});

// 14px, not 16, because it sits inline beside text rather than alone in a square button.
// Normalising it to 16 "for consistency" would make it visibly heavier than the label.
test("the back arrow keeps its 14px inline size", () => {
  const html = render(BackArrowIcon);
  assert.match(html, /width="14"/);
  assert.match(html, /height="14"/);
  assert.match(html, /viewBox="0 0 16 16"/, "still a 16-unit coordinate space, just drawn smaller");
  assert.match(html, /d="M10 3.5L5.5 8L10 12.5"/);
});

test("the compose mark is a pencil over a baseline", () => {
  const html = render(ComposeIcon);
  assert.match(html, /d="M2.5 13.5h4l6.5-6.5a1.8 1.8 0 0 0-2.5-2.5L4 11v2.5z"/);
  assert.match(html, /d="M10 5.5l2 2"/, "the nib detail");
});

// All four are decorative: every one of them sits inside a button that carries its own
// `aria-label`, so an accessible name here would be read out twice.
test("every glyph is aria-hidden and stroked in currentColor", () => {
  for (const Component of [ToggleLeftPanelIcon, ToggleRightPanelIcon, BackArrowIcon, ComposeIcon]) {
    const html = render(Component);
    assert.match(html, /aria-hidden="true"/, Component.name);
    assert.match(html, /stroke="currentColor"/, `${Component.name} must inherit its button's colour`);
    assert.match(html, /fill="none"/, Component.name);
  }
});
