// The vendored provider marks, and the transcript avatar that renders them.
//
// The avatar used to be one generic sparkle for every agent, so a transcript gave
// no clue which model wrote it. It now carries the provider's own mark, with the
// sparkle kept as the fallback for providers we ship no logo for — a fallback that
// must never be another vendor's mark.
import test from "node:test";
import assert from "node:assert/strict";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { providerIconSvg, providersWithIcons } from "./provider-icons.js";
import { TranscriptEntry } from "./transcript-react.js";

const h = React.createElement;

const AGENT_ENTRY = { kind: "agent_text", item_id: "item-1", text: "hello" };

function renderAgent(options) {
  return renderToStaticMarkup(h(TranscriptEntry, { entry: AGENT_ENTRY, options }));
}

// --- the vendored assets ----------------------------------------------------

test("ships a mark for each provider the relay can actually run", () => {
  assert.deepEqual(providersWithIcons().sort(), ["claude_code", "codex"]);
});

test("claude_code resolves to the Anthropic starburst in its brand colour", () => {
  const svg = providerIconSvg("claude_code");
  assert.match(svg, /^<svg /);
  // Brand salmon, baked in: it reads on both the light and the dark theme, so it
  // does not need to follow currentColor the way the OpenAI mark does.
  assert.match(svg, /#D97757/);
});

test("codex resolves to the OpenAI mark that follows currentColor", () => {
  const svg = providerIconSvg("codex");
  assert.match(svg, /^<svg /);
  // The OpenAI mark is monochrome black by design and would vanish on the dark
  // theme, so it MUST inherit colour rather than hard-code it.
  assert.match(svg, /fill="currentColor"/);
  assert.doesNotMatch(svg, /#[0-9a-f]{6}/i);
});

test("a provider we ship no mark for resolves to null, never to another vendor's logo", () => {
  assert.equal(providerIconSvg("fake"), null);
  assert.equal(providerIconSvg("some_new_provider"), null);
  assert.equal(providerIconSvg(""), null);
  assert.equal(providerIconSvg(null), null);
  assert.equal(providerIconSvg(undefined), null);
});

test("the vendored svgs carry no <title> and no <script>", () => {
  for (const provider of providersWithIcons()) {
    const svg = providerIconSvg(provider);
    // <title> inside an aria-hidden avatar is dead weight that only yields a
    // stray native tooltip.
    assert.doesNotMatch(svg, /<title>/i, `${provider} should have no <title>`);
    assert.doesNotMatch(svg, /<script/i, `${provider} should have no <script>`);
  }
});

// --- the transcript avatar --------------------------------------------------

test("an agent message shows its provider's mark", () => {
  const claude = renderAgent({ provider: "claude_code" });
  assert.match(claude, /class="message-avatar"/);
  assert.match(claude, /#D97757/, "the Claude starburst should be inlined");

  const codex = renderAgent({ provider: "codex" });
  assert.match(codex, /fill="currentColor"/, "the OpenAI mark should be inlined");
});

test("the avatar tags the provider so CSS can theme the mark", () => {
  // The OpenAI mark has to flip to white on the dark theme; that is a pure CSS
  // concern, so the provider has to be readable from the DOM.
  assert.match(renderAgent({ provider: "codex" }), /data-provider="codex"/);
  assert.match(renderAgent({ provider: "claude_code" }), /data-provider="claude_code"/);
});

test("an agent message with an unknown or missing provider keeps the sparkle", () => {
  for (const options of [{ provider: "fake" }, { provider: "" }, {}, null]) {
    const markup = renderAgent(options);
    assert.match(markup, /class="message-avatar"/, "the avatar slot must still render");
    assert.doesNotMatch(markup, /#D97757/);
    assert.doesNotMatch(markup, /data-provider="(claude_code|codex)"/);
  }
});

// A not-yet-hydrated agent message renders its own placeholder branch with its
// own copy of the avatar — it has to carry the mark too, or the logo flickers in
// as history loads.
test("a pending agent message shows the provider mark too", () => {
  const markup = renderToStaticMarkup(
    h(TranscriptEntry, {
      entry: { ...AGENT_ENTRY, content_state: "omitted" },
      options: { provider: "claude_code" },
    })
  );
  assert.match(markup, /class="message-avatar"/);
  assert.match(markup, /#D97757/);
});
