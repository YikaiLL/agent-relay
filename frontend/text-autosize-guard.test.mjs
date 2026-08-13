import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Guard against iOS text autosizing silently rescaling the transcript.
//
// THE BUG (reported as "remote 字体有时候会突然变大"): mobile WebKit runs a text
// "autosizer" that picks its own font multiplier for any block it decides is an
// autosizing cluster — typically a scroll container whose content is much wider
// than the viewport. It scales that cluster and leaves everything around it at
// 1, so a page ends up with two different body sizes.
//
// Our transcript hands it a perfect candidate. `.diff-line` sets
// `min-width: max-content` — the ONLY unbounded width in the whole stylesheet —
// and `.diff-line code` is `white-space: pre` inside `.diff-view`'s
// `overflow: auto`. On a 390px phone a 100-column diff row is ~850px, i.e. more
// than twice the viewport, so the diff gets boosted while the 14px sans body
// text around it does not. Every other mono block in the app is `pre-wrap` +
// `overflow-wrap: anywhere`, never exceeds the viewport, and is never boosted —
// which is exactly why the symptom looked specific to diffs.
//
// The "suddenly" comes from re-layout: `content-visibility: auto` on
// `.chat-message` means an off-screen diff is first laid out mid-scroll, the
// 400-row diff cap injects hundreds of rows when expanded, and rotation re-runs
// the autosizer.
//
// `<meta name="viewport" content="width=device-width">` disables Chrome/Android
// font boosting but does NOT disable iOS autosizing. Only text-size-adjust does.
//
// WHY THE GUARD IS SHAPED THIS WAY: the fix must sit on a document-level
// selector. Scoping it to `.diff-view` would fix today's cluster and leave the
// next one — any future wide scroller — to regress in the same way, on a
// surface most of us do not develop against.

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// Rule bodies for a selector list containing `name` as a whole selector.
function bodiesForSelector(css, name) {
  const bodies = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match = re.exec(css);
  while (match) {
    const selectors = match[1].split(",").map((s) => s.trim());
    if (selectors.includes(name)) {
      bodies.push(match[2]);
    }
    match = re.exec(css);
  }
  return bodies;
}

function declaredValue(bodies, property) {
  for (const body of bodies) {
    const found = body.match(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;}]+)`));
    if (found) return found[1].trim();
  }
  return null;
}

test("text size adjust is pinned at the document root", () => {
  // `html` and not `body`: the autosizer inherits text-size-adjust, and a
  // cluster can be established above body in quirks/edge cases.
  const bodies = [...bodiesForSelector(CSS, "html"), ...bodiesForSelector(CSS, ":root")];
  assert.ok(bodies.length > 0, "expected an `html` or `:root` rule in styles.css");

  const prefixed = declaredValue(bodies, "-webkit-text-size-adjust");
  assert.equal(
    prefixed,
    "100%",
    "`html { -webkit-text-size-adjust: 100% }` is required: without it iOS Safari " +
      "rescales the diff view (the app's only max-content block) independently of " +
      "the surrounding text, which reads as the font randomly getting bigger"
  );

  const standard = declaredValue(bodies, "text-size-adjust");
  assert.equal(
    standard,
    "100%",
    "ship the unprefixed `text-size-adjust` alongside the -webkit- one so the " +
      "guard survives WebKit unprefixing it"
  );
});

test("the diff view still has the geometry that makes the guard necessary", () => {
  // Not a style preference — a tripwire. `min-width: max-content` is what makes
  // a diff row wider than a phone, and it is load-bearing: it is what lets a
  // long line scroll horizontally instead of wrapping mid-token. If someone
  // removes it, the guard above stops being load-bearing too and this comment
  // should be revisited rather than the guard silently kept forever.
  const conversation = readFileSync(join(HERE, "conversation.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    ""
  );
  const diffLine = bodiesForSelector(conversation, ".diff-line");
  assert.ok(diffLine.length > 0, "expected a `.diff-line` rule in conversation.css");
  assert.equal(
    declaredValue(diffLine, "min-width"),
    "max-content",
    "if .diff-line no longer uses max-content, re-check whether the root " +
      "text-size-adjust guard is still the right fix"
  );
});
