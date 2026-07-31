// The provider mark in a session tab's leading slot.
//
// That slot is a fixed box holding the activity dot. When a session is idle it
// has no dot, so the box sat empty — dead space in the one place a tab could
// cheaply say WHICH agent it is. It now shows the provider's mark there.
//
// The slot keeps ONE width across both states. It exists precisely so titles
// line up whether or not a session has a dot, and a slot that resized per state
// would make every tab title jump each time a turn starts or finishes.
//
// Status still wins the slot: a dot is transient and demands attention, the
// provider is static and can wait. That is the deliberate trade of showing the
// mark only while idle.
import test from "node:test";
import assert from "node:assert/strict";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionTabStrip, buildSessionTabItems } from "./session-tab-strip.js";
import { providerIconSvg } from "./provider-icons.js";

const h = React.createElement;

const WORKSPACE = { tabs: [{ id: "tab-a", layout: "l-a", pinned: false }] };

function build(extra = {}) {
  return buildSessionTabItems({
    workspace: WORKSPACE,
    layoutThreadIds: () => ["t1"],
    resolveThread: () => ({ title: "Alpha", tooltip: "/work", provider: "claude_code" }),
    ...extra,
  });
}

function renderStrip(items) {
  return renderToStaticMarkup(h(SessionTabStrip, { items, focusedTabId: null }));
}

// --- the view model ---------------------------------------------------------

test("a tab item carries the thread's provider", () => {
  assert.equal(build()[0].provider, "claude_code");
});

test("a tab item without a resolvable provider carries an empty string", () => {
  const items = build({ resolveThread: () => ({ title: "Alpha" }) });
  assert.equal(items[0].provider, "");
});

// --- the rendered slot ------------------------------------------------------

test("an idle tab shows its provider mark", () => {
  const markup = renderStrip(build());
  assert.ok(
    markup.includes(providerIconSvg("claude_code")),
    "the idle slot should inline the shipped Claude mark"
  );
});

test("a provider we ship no mark for leaves the slot empty rather than borrowing one", () => {
  const markup = renderStrip(build({ resolveThread: () => ({ title: "Alpha", provider: "fake" }) }));
  assert.doesNotMatch(markup, /session-tab-provider/);
  // Scoped to the slot on purpose: the tab's own pin and close buttons are svgs,
  // so asserting "no <svg> anywhere" would pass for the wrong reason.
  assert.match(markup, /<span class="session-tab-lead" aria-hidden="true"><\/span>/);
});

// --- status outranks identity ----------------------------------------------

test("a working tab shows its activity dot, not the provider mark", () => {
  const markup = renderStrip(
    build({ threadActivity: new Map([["t1", { tool: "bash" }]]) })
  );
  assert.match(markup, /conversation-activity-dot/);
  assert.ok(
    !markup.includes(providerIconSvg("claude_code")),
    "a live dot must not be displaced by a logo"
  );
});

test("a tab needing input shows its dot, not the provider mark", () => {
  const markup = renderStrip(
    build({ threadAttention: new Map([["t1", "needs_input"]]) })
  );
  assert.match(markup, /is-attention-input/);
  assert.ok(!markup.includes(providerIconSvg("claude_code")));
});

// --- the slot never changes width ------------------------------------------

// Both states must render the SAME slot element, so its width comes from one
// CSS rule and titles cannot shift as a session starts or settles.
test("idle and active tabs use the same slot class", () => {
  const idle = renderStrip(build());
  const working = renderStrip(build({ threadActivity: new Map([["t1", { tool: "bash" }]]) }));
  for (const markup of [idle, working]) {
    assert.match(markup, /class="session-tab-lead"/, `expected a shared slot: ${markup.slice(0, 200)}`);
  }
});
