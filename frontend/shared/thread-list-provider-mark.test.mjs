// The provider mark in a sidebar row's leading slot.
//
// The slot used to hold a filled text pill — "Claude" / "Codex" — at 11px/600 on
// a tinted background, repeated on every row. Two problems. It was a second type
// size and a block of colour per row, which is most of what made the column read
// heavy; and because the pill sized to its text, the slot was a different width
// per provider, so every title stepped left and right down the list.
//
// It now shows the same vendored mark the transcript avatar and the session tab
// use, in a FIXED 14px slot. The width is fixed rather than `auto` precisely so
// the titles share one left edge — including for a provider we ship no mark for,
// where the slot stays empty but keeps its width.
import test from "node:test";
import assert from "node:assert/strict";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ThreadGroupItem } from "./thread-list-react.js";
import { providerIconSvg } from "./provider-icons.js";

const h = React.createElement;

const GROUP = { cwd: "/tmp/project", label: "project" };

function renderItem(props = {}) {
  return renderToStaticMarkup(
    h(ThreadGroupItem, {
      group: GROUP,
      thread: { id: "t1", provider: "claude_code", name: "Alpha", updated_at: 1 },
      formatThreadMeta: () => "11h",
      ...props,
    })
  );
}

// --- the mark replaces the pill ---------------------------------------------

test("a sidebar row inlines the shipped mark for its provider", () => {
  const markup = renderItem();
  assert.ok(
    markup.includes(providerIconSvg("claude_code")),
    "the leading slot should inline the vendored Claude mark"
  );
});

test("a codex row gets the codex mark, not claude's", () => {
  const markup = renderItem({
    thread: { id: "t2", provider: "codex", name: "Beta", updated_at: 1 },
  });
  assert.ok(markup.includes(providerIconSvg("codex")));
  assert.ok(
    !markup.includes(providerIconSvg("claude_code")),
    "a row must never borrow another vendor's logo"
  );
});

// The filled text chip is what made the column read heavy. If it comes back,
// this catches it — the mark and the pill must not both be rendering.
test("the filled provider text pill is gone from sidebar rows", () => {
  const markup = renderItem();
  assert.doesNotMatch(markup, /conversation-provider-badge/);
  assert.doesNotMatch(markup, />Claude</, "the provider name must not render as row text");
});

// --- the slot keeps one width -----------------------------------------------

test("a provider we ship no mark for leaves the slot empty but present", () => {
  const markup = renderItem({
    thread: { id: "t3", provider: "fake", name: "Gamma", updated_at: 1 },
  });
  assert.doesNotMatch(markup, /provider-mark/);
  // The slot element itself must survive: it is what holds the 14px column open
  // so this row's title lines up with every other row's.
  assert.match(markup, /<span class="conversation-lead" aria-hidden="true"><\/span>/);
});

test("every row renders the same fixed-width slot class", () => {
  for (const provider of ["claude_code", "codex", "fake", ""]) {
    const markup = renderItem({
      thread: { id: `t-${provider}`, provider, name: "Row", updated_at: 1 },
    });
    assert.match(
      markup,
      /class="conversation-lead"/,
      `expected the shared slot for provider "${provider}"`
    );
  }
});

// --- the provider name is not lost ------------------------------------------

// Swapping a text label for a glyph must not drop the information. The row's
// tooltip still leads with the provider, and the mark is aria-hidden so a screen
// reader reads that title rather than announcing a decorative image.
test("the provider name survives in the row tooltip", () => {
  const markup = renderItem();
  assert.match(markup, /title="Claude · Alpha"/);
});

test("the mark is aria-hidden so it is not announced as content", () => {
  const markup = renderItem();
  assert.match(markup, /<span class="conversation-lead" aria-hidden="true">/);
});
