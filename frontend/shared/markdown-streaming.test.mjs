// renderStreamingMarkdown (frontend/shared/markdown.js) exists so a running
// agent message stops re-parsing its whole growing text on every token. It
// splits into a stable "prefix" (rendered through the ordinary cached
// renderMarkdown, so it's a cache hit on every later flush) and a short
// "tail" (the only part that's a fresh parse). These tests cover the split
// boundary rule directly (fast, precise), then the same security posture as
// markdown.test.mjs run through the streaming path, then the perf property
// the whole thing exists for: parse cost proportional to the tail, not the
// growing message.

import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  renderMarkdown,
  renderStreamingMarkdown,
  __clearMarkdownCacheForTests,
  __getMarkdownCacheSizeForTests,
  __test__,
} from "./markdown.js";

const { findStreamingSplitOffset, unterminatedFenceMarker } = __test__;

const h = React.createElement;

function renderStreaming(text) {
  const node = renderStreamingMarkdown(text);
  if (node == null || node === "") return "";
  return renderToStaticMarkup(h(React.Fragment, null, node));
}

// Walks the React element tree WITHOUT rendering it, failing on the first
// element whose props carry `dangerouslySetInnerHTML` — the prop that would
// let untrusted agent text become live HTML. Distinct from the markup-pattern
// checks above: this asserts on the element tree itself, so it also catches
// the prop being set on a wrapper (Fragment/prefix/tail) that happens to
// render markup which looks safe.
function assertNoDangerousHtml(node, seen = new Set()) {
  if (node == null || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    node.forEach((child) => assertNoDangerousHtml(child, seen));
    return;
  }
  if (React.isValidElement(node)) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(node.props || {}, "dangerouslySetInnerHTML"),
      `element of type ${String(node.type)} must not use dangerouslySetInnerHTML in the markdown body path`
    );
    assertNoDangerousHtml(node.props?.children, seen);
  }
}

// -- Boundary rule: fences ----------------------------------------------------

test("no split found while a blank line inside a fence is the only candidate", () => {
  const text = "```js\nconst x = 1;\n\nconst y = 2;\n```";
  assert.equal(findStreamingSplitOffset(text), null);
});

test("a blank line after a closed fence is a safe split point", () => {
  const text = "Before.\n\n```js\nconst x = 1;\n```\n\nAfter.";
  const offset = findStreamingSplitOffset(text);
  assert.ok(offset != null);
  assert.equal(text.slice(0, offset), "Before.\n\n```js\nconst x = 1;\n```\n\n");
  assert.equal(text.slice(offset), "After.");
});

test("a fence never splits even when a paragraph's own blank line precedes it", () => {
  // The LAST safe boundary must be the one before the still-open fence, not a
  // later blank line that only exists INSIDE it.
  const text = "Intro.\n\n```js\nconst x = 1;\n\n// still typing";
  const offset = findStreamingSplitOffset(text);
  assert.equal(text.slice(0, offset), "Intro.\n\n");
  assert.equal(text.slice(offset), "```js\nconst x = 1;\n\n// still typing");
});

test("renderStreamingMarkdown closes an unterminated fence in the tail so it renders as a real code block", () => {
  const text = "Intro.\n\n```js\nconst x = 1;";
  const html = renderStreaming(text);
  assert.match(html, /<pre><code[^>]*>/);
  assert.match(html, /const x = 1;/);
  // The synthetic closer is parsed away as fence syntax, never leaks as text.
  assert.doesNotMatch(html, /```/);
});

test("unterminatedFenceMarker reports the exact marker that needs closing", () => {
  assert.equal(unterminatedFenceMarker("```js\ncode"), "```");
  assert.equal(unterminatedFenceMarker("~~~~\ncode"), "~~~~");
  assert.equal(unterminatedFenceMarker("```js\ncode\n```"), null);
  assert.equal(unterminatedFenceMarker("no fence here"), null);
});

// A closing fence is the marker run plus optional trailing whitespace ONLY —
// CommonMark treats anything else after it (an info string, stray text) as
// code content, not a closer. A line like "```not-a-closer" inside an open
// ```-fence must NOT close it, or a later blank line would be (wrongly)
// treated as a safe split point while still really inside the fence.
test("a fence-shaped line with trailing content does not close the fence", () => {
  const text = "Intro paragraph.\n\n```js\nconst x = 1;\n```not-a-closer\nstill fenced content\n\nMore text after, still typ";
  const offset = findStreamingSplitOffset(text);
  // The only real boundary is before the fence opens — the fence is never
  // validly closed, so both blank lines inside/after the bogus "closer" stay
  // unsafe.
  assert.equal(text.slice(0, offset), "Intro paragraph.\n\n");
  assert.equal(text.slice(offset), "```js\nconst x = 1;\n```not-a-closer\nstill fenced content\n\nMore text after, still typ");
});

test("a fence-shaped line with only trailing whitespace DOES close the fence", () => {
  const text = "```js\ncode\n```   \n\nAfter, still typ";
  const offset = findStreamingSplitOffset(text);
  assert.equal(text.slice(0, offset), "```js\ncode\n```   \n\n");
  assert.equal(text.slice(offset), "After, still typ");
});

// -- Boundary rule: lists -----------------------------------------------------

test("no split between two loose ordered-list items", () => {
  const text = "1. one\n\n2. two";
  assert.equal(findStreamingSplitOffset(text), null);
});

test("no split between two loose unordered-list items", () => {
  const text = "- one\n\n- two";
  assert.equal(findStreamingSplitOffset(text), null);
});

test("a list stays whole in the prefix once it is followed by a real boundary", () => {
  const text = "Some prose.\n\n1. first\n2. second\n\nMore text, still typ";
  const offset = findStreamingSplitOffset(text);
  const prefix = text.slice(0, offset);
  assert.equal(prefix, "Some prose.\n\n1. first\n2. second\n\n");
  assert.equal(text.slice(offset), "More text, still typ");
});

test("ordered-list numbering never restarts mid-stream", () => {
  const text = "Some prose.\n\n1. first\n2. second\n\nMore text, still typ";
  const html = renderStreaming(text);
  const olCount = (html.match(/<ol/g) || []).length;
  assert.equal(olCount, 1, "the list must render as one <ol>, never split into two");
  assert.doesNotMatch(html, /<ol start=/, "the (single, whole) list starts at 1 — no start= override");
  assert.match(html, /<li>first<\/li>/);
  assert.match(html, /<li>second<\/li>/);
});

// -- Boundary rule: blockquotes -----------------------------------------------

test("no split between two blockquote continuation lines", () => {
  const text = "> line one\n\n> line two";
  assert.equal(findStreamingSplitOffset(text), null);
});

test("a blockquote stays whole in the prefix once followed by a real boundary", () => {
  const text = "> quoted line\n> more quote\n\nAfter, still typ";
  const offset = findStreamingSplitOffset(text);
  assert.equal(text.slice(0, offset), "> quoted line\n> more quote\n\n");
});

// -- Boundary rule: indented continuation -------------------------------------

test("no split before a 4-space-indented continuation line", () => {
  const text = "Some text.\n\n    still part of the block above";
  assert.equal(findStreamingSplitOffset(text), null);
});

// Real CommonMark list continuations are narrower than 4 spaces: a "- "
// bullet's content column is 2, a single-digit "1. " ordered marker's is 3.
// A continuation at those (smaller) widths must still refuse to split, or the
// second paragraph gets cut out of its list item.
test("no split before a 2-space-indented bullet-list continuation paragraph", () => {
  const text = "- item one\n\n  continued paragraph, still typ";
  assert.equal(findStreamingSplitOffset(text), null);
});

test("no split before a 3-space-indented ordered-list continuation paragraph", () => {
  const text = "1. item one\n\n   continued paragraph, still typ";
  assert.equal(findStreamingSplitOffset(text), null);
});

test("a bullet list's continuation paragraph is not split out of its list", () => {
  const text = "- item one\n\n  continued paragraph in item one, still typ";
  // No split found → renderStreaming falls back to the whole text as tail,
  // identical to a direct renderMarkdown call (same proof shape as the
  // no-safe-boundary test above).
  const viaStreaming = renderStreaming(text);
  __clearMarkdownCacheForTests();
  const viaPlain = renderToStaticMarkup(h(React.Fragment, null, renderMarkdown(text)));
  assert.equal(viaStreaming, viaPlain);
});

// -- Refuse-rather-than-split-wrongly -----------------------------------------

test("no safe boundary anywhere falls back to the whole text as tail — same cost as today, never worse", () => {
  const text = "One giant paragraph with no blank line anywhere in it at all.";
  assert.equal(findStreamingSplitOffset(text), null);
  const viaStreaming = renderStreaming(text);
  __clearMarkdownCacheForTests();
  const viaPlain = renderToStaticMarkup(h(React.Fragment, null, renderMarkdown(text)));
  assert.equal(viaStreaming, viaPlain);
});

test("empty and non-string input do not crash", () => {
  assert.equal(renderStreamingMarkdown(""), "");
  assert.equal(renderStreamingMarkdown(null), "");
  assert.equal(renderStreamingMarkdown(undefined), "");
});

// -- Cache behavior: the prefix is a hit, the tail is the only fresh parse ----

test("the same stable prefix is reference-equal across two flushes that only grow the tail", () => {
  __clearMarkdownCacheForTests();
  const textAtFlushOne = "Finished paragraph.\n\nStreaming paragraph, tok";
  const textAtFlushTwo = "Finished paragraph.\n\nStreaming paragraph, token token";

  const one = renderStreamingMarkdown(textAtFlushOne);
  const two = renderStreamingMarkdown(textAtFlushTwo);

  // Both split at the same boundary (the prefix has not grown), so the
  // prefix's rendered element must be the SAME reference both times.
  assert.equal(one.props.children[0], two.props.children[0]);
  // The tail differs and must be its own (different) element.
  assert.notEqual(one.props.children[1], two.props.children[1]);
});

test("a flush that never leaves a growing paragraph never inserts the growing paragraph's full text as its own cache key", () => {
  __clearMarkdownCacheForTests();
  const finished = "Finished paragraph.\n\n";
  let text = finished;
  for (let i = 0; i < 20; i += 1) {
    text += `tok${i} `;
    renderStreamingMarkdown(text);
  }
  // The finished prefix is one cache entry; the tail churns through many
  // distinct (short) strings, but the full accumulated text — finished +
  // all 20 tokens — must never itself have been handed to renderMarkdown as
  // one string (that would be exactly the O(message) cost this exists to
  // avoid).
  const sizeBefore = __getMarkdownCacheSizeForTests();
  renderMarkdown(text);
  assert.equal(
    __getMarkdownCacheSizeForTests(),
    sizeBefore + 1,
    "the full accumulated text must be a fresh cache miss — it was never parsed as one piece during streaming"
  );
});

// -- Perf: cost proportional to the tail, not the message ---------------------

test("the prefix stays fixed and the tail grows only by what was appended, while the message grows large", () => {
  // 200 "settled" paragraphs (a blank line after each) followed by one
  // paragraph that keeps growing, token by token — the shape of a long
  // agent response that is still actively streaming its last paragraph. The
  // tail is NOT expected to stay small in absolute terms here — a single
  // still-open paragraph legitimately grows as tokens land in it, same as
  // today. What must hold is that the tail's growth is exactly what was
  // appended to THIS paragraph, never inflated by the 200 settled ones ahead
  // of it, and that the prefix (the expensive part to get wrong) never moves.
  const settled = Array.from({ length: 200 }, (_, i) => `Paragraph number ${i}, already finished streaming.`)
    .join("\n\n");
  const prefixBoundary = `${settled}\n\n`;
  const growingTailStart = "Now streaming the final paragraph,";

  let growingTail = growingTailStart;
  let previousSplitOffset = null;
  for (let i = 0; i < 100; i += 1) {
    growingTail += ` tok${i}`;
    const text = prefixBoundary + growingTail;
    const offset = findStreamingSplitOffset(text);

    assert.ok(offset != null, `flush ${i}: a safe boundary must exist once the settled paragraphs are behind us`);
    assert.equal(text.slice(0, offset), prefixBoundary, `flush ${i}: the prefix must stay exactly the settled paragraphs`);
    assert.equal(
      text.length - offset,
      growingTail.length,
      `flush ${i}: the tail must be exactly the still-open paragraph, not the settled paragraphs ahead of it`
    );
    if (previousSplitOffset != null) {
      assert.equal(offset, previousSplitOffset, `flush ${i}: the split point must not move while only the tail grows`);
    }
    previousSplitOffset = offset;
  }

  // Sanity: the message really did grow large — the property above is not
  // vacuously true because the message stayed small.
  const finalText = prefixBoundary + growingTail;
  assert.ok(finalText.length > 10_000, `expected the accumulated message to be large, got ${finalText.length} chars`);
});

test("the tail's size depends only on the still-open paragraph, never on how many earlier paragraphs are already settled", () => {
  function buildText(settledCount, growingTailChars) {
    const settled = Array.from(
      { length: settledCount },
      (_, i) => `Paragraph number ${i}, already finished streaming.`
    ).join("\n\n");
    const prefixBoundary = `${settled}\n\n`;
    const growingTail = `Now streaming the final paragraph, ${"x".repeat(growingTailChars)}`;
    return prefixBoundary + growingTail;
  }

  const fewSettled = buildText(20, 50);
  const manySettled = buildText(2000, 50); // 100x more settled paragraphs, same growing tail.

  const tailOfFew = fewSettled.length - findStreamingSplitOffset(fewSettled);
  const tailOfMany = manySettled.length - findStreamingSplitOffset(manySettled);

  assert.equal(
    tailOfFew,
    tailOfMany,
    "the tail length must depend only on the still-growing paragraph, not on how many settled paragraphs came before it"
  );
  assert.ok(
    manySettled.length > fewSettled.length * 50,
    "the two messages must differ dramatically in total size for this comparison to be meaningful"
  );
});

// -- Security: every case from markdown.test.mjs, through the streaming path -

test("[streaming] raw <script> tags do NOT execute — rendered as text", () => {
  const html = renderStreaming("hello <script>alert(1)</script> world");
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /alert\(1\)/);
});

test("[streaming] inline <img onerror=…> stays as escaped text, not an executable tag", () => {
  const html = renderStreaming('<img src=x onerror="alert(1)">');
  assert.doesNotMatch(html, /<img[^&]/i);
  assert.match(html, /&lt;img/);
});

test("[streaming] javascript: URL on a markdown link is replaced with #blocked", () => {
  const html = renderStreaming("[click](javascript:alert(1))");
  assert.match(html, /href="#blocked"/);
  assert.doesNotMatch(html, /javascript:/i);
});

test("[streaming] data: URL on a link is blocked", () => {
  const html = renderStreaming("[boom](data:text/html,<script>alert(1)</script>)");
  assert.match(html, /href="#blocked"/);
  assert.doesNotMatch(html, /data:/);
});

test("[streaming] vbscript: URL is blocked", () => {
  const html = renderStreaming("[hi](vbscript:msgbox)");
  assert.match(html, /href="#blocked"/);
});

test("[streaming] http(s)/mailto links go through untouched", () => {
  const html = renderStreaming("[home](https://example.com) [mail](mailto:a@b.c)");
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /href="mailto:a@b\.c"/);
});

test("[streaming] relative paths and fragment URLs are allowed", () => {
  const html = renderStreaming("[frag](#section) [rel](/local/path) [q](?query=1)");
  assert.match(html, /href="#section"/);
  assert.match(html, /href="\/local\/path"/);
  assert.match(html, /href="\?query=1"/);
});

test("[streaming] file/chrome/ftp URL schemes are blocked", () => {
  const html = renderStreaming(
    "[a](file:///etc/passwd) [b](chrome://settings) [c](ftp://ftp.example.com)"
  );
  assert.doesNotMatch(html, /href="file:/);
  assert.doesNotMatch(html, /href="chrome:/);
  assert.doesNotMatch(html, /href="ftp:/);
  const blockedCount = (html.match(/href="#blocked"/g) || []).length;
  assert.equal(blockedCount, 3);
});

test("[streaming] images render as alt text only (no <img>, no remote fetch)", () => {
  const html = renderStreaming("![my picture](https://example.com/pixel.png)");
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /my picture/);
});

test("[streaming] security cases still hold when the payload is split across a boundary", () => {
  // A completed paragraph ahead of the payload forces an actual split, so
  // the security-sensitive content is rendered via the TAIL's independent
  // renderMarkdown call, not the whole-text fallback.
  const html = renderStreaming(
    "Finished paragraph.\n\n[click](javascript:alert(1)) and <script>alert(2)</script>"
  );
  assert.match(html, /href="#blocked"/);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /<script>/i);
});

test("[streaming] anchors get rel=noopener noreferrer nofollow and target=_blank", () => {
  const html = renderStreaming("[home](https://example.com)");
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
});

test("[streaming] single *asterisks* stay literal (no italic) in both prefix and tail", () => {
  const html = renderStreaming("Finished para with *literal*.\n\nSecond para also *literal*, still typ");
  assert.doesNotMatch(html, /<em>/);
  const matches = html.match(/\*literal\*/g) || [];
  assert.equal(matches.length, 2);
});

test("[streaming] the body path never uses dangerouslySetInnerHTML, in the prefix or the tail", () => {
  const node = renderStreamingMarkdown(
    "Finished paragraph.\n\nStill *typing* with <script>alert(1)</script> and a [link](javascript:alert(1))"
  );
  assertNoDangerousHtml(node);
});
