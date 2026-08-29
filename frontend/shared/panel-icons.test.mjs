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
  ProjectTagIcon,
  ToggleLeftPanelIcon,
  ToggleRightPanelIcon,
  WorkspaceFolderIcon,
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

// The two sidebar group marks are Lucide `folder` and `tag`, copied verbatim. Pinned
// as EXACT path data for the same reason as the glyphs above, plus one specific to
// copied geometry: a path that has been nudged still renders a plausible folder, so
// the only way to notice the drift is to compare against the source it came from.
// If Lucide's own path changes, re-copy it and update this string deliberately.
test("the workspace mark is Lucide's folder, unmodified", () => {
  const html = render(WorkspaceFolderIcon);
  assert.match(
    html,
    /d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7\.9a2 2 0 0 1-1\.69-\.9L9\.6 3\.9A2 2 0 0 0 7\.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/
  );
  assert.match(html, /viewBox="0 0 24 24"/, "Lucide's native coordinate space, drawn at 16px");
  assert.match(html, /stroke-width="2"/, "and its native stroke weight");
});

test("the project mark is Lucide's tag, dot included", () => {
  const html = render(ProjectTagIcon);
  assert.match(
    html,
    /d="M12\.586 2\.586A2 2 0 0 0 11\.172 2H4a2 2 0 0 0-2 2v7\.172a2 2 0 0 0 \.586 1\.414l8\.704 8\.704a2\.426 2\.426 0 0 0 3\.42 0l6\.58-6\.58a2\.426 2\.426 0 0 0 0-3\.42z"/
  );
  // The dot is filled while the svg is `fill="none"`, so it needs its own fill — and
  // it has to be currentColor, not a literal: the mark turns accent as a whole when
  // its project is active, and a hardcoded dot would stay behind.
  assert.match(html, /<circle cx="7\.5" cy="7\.5" r="\.5" fill="currentColor"/);
});

// The two group marks must not converge. A project is not a directory, and the
// defect this pair was added for was precisely one glyph standing in for both.
test("the project and workspace marks are different shapes", () => {
  assert.notEqual(
    render(ProjectTagIcon),
    render(WorkspaceFolderIcon),
    "if these ever render the same, the sidebar has stopped distinguishing its two group kinds"
  );
});

// All of them are decorative: every one sits inside a button or an aria-hidden slot that
// carries its own name, so an accessible name here would be read out twice.
test("every glyph is aria-hidden and stroked in currentColor", () => {
  for (const Component of [
    ToggleLeftPanelIcon,
    ToggleRightPanelIcon,
    BackArrowIcon,
    ComposeIcon,
    ProjectTagIcon,
    WorkspaceFolderIcon,
  ]) {
    const html = render(Component);
    assert.match(html, /aria-hidden="true"/, Component.name);
    assert.match(html, /stroke="currentColor"/, `${Component.name} must inherit its button's colour`);
    assert.match(html, /fill="none"/, Component.name);
  }
});
