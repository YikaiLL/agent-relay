import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FileChangeDiff, splitDisplayPath } from "./transcript-react.js";

// A file header is scanned for its BASENAME. The workspace-diff rail already
// knows this: it splits the display path and lets the directory give up space
// first (styles.css:5346-5367, with the asymmetric 1000-vs-1 shrink that keeps
// the basename whole). The transcript rendered the same data as one flat
// string, so a deep path pushed the filename out of view — the part you were
// actually looking for was the first thing truncated.
//
// This pins BOTH variants to the same treatment, with the rail as the
// reference. The point is not the styling; it is that one component should not
// present the same value two different ways on two surfaces.

const DEEP_PATH = "crates/relay-broker/src/pairing.rs";

const TOOL = {
  file_changes: [
    {
      path: DEEP_PATH,
      change_type: "modified",
      added: 24,
      removed: 6,
      diff: "@@ -410,3 +410,4 @@\n context\n+added\n-removed\n",
    },
  ],
};

function render(variant) {
  return renderToStaticMarkup(
    React.createElement(FileChangeDiff, { tool: TOOL, itemId: "item-1", variant })
  );
}

test("splitDisplayPath keeps the trailing slash on the directory half", () => {
  assert.deepEqual(splitDisplayPath(DEEP_PATH), ["crates/relay-broker/src/", "pairing.rs"]);
  // A bare filename has no directory half at all — the caller must not render
  // an empty dir span, or the flex row gains a stray baseline item.
  assert.deepEqual(splitDisplayPath("README.md"), ["", "README.md"]);
});

for (const variant of ["rail", "transcript"]) {
  test(`the ${variant} file header separates directory from basename`, () => {
    const markup = render(variant);

    assert.match(
      markup,
      /class="diff-file-dir"[^>]*>crates\/relay-broker\/src\/</,
      `${variant} should render the directory in its own dimmable element`
    );
    assert.match(
      markup,
      /class="diff-file-base"[^>]*>pairing\.rs</,
      `${variant} should render the basename in its own element so it survives truncation`
    );
    // Guards against a "fix" that renders the split parts but leaves the flat
    // path in place too, which would double the filename in the accessible name.
    assert.doesNotMatch(
      markup,
      />crates\/relay-broker\/src\/pairing\.rs</,
      `${variant} should not also emit the path as one flat string`
    );
  });
}
