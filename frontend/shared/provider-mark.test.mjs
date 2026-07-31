import test from "node:test";
import assert from "node:assert/strict";

import { providerMark } from "./provider-mark.js";
import { providersWithIcons } from "./provider-icons.js";

test("a provider we ship an icon for renders a mark in the caller's slot class", () => {
  const mark = providerMark("codex", "provider-status-mark");
  assert.ok(mark, "codex ships an icon");
  assert.equal(mark.props.className, "provider-status-mark");
  assert.equal(mark.props["data-provider"], "codex");
  assert.match(mark.props.dangerouslySetInnerHTML.__html, /<svg/);
});

test("the slot class defaults to provider-mark", () => {
  assert.equal(providerMark("claude_code").props.className, "provider-mark");
});

// The rule every caller depends on: never borrow another vendor's logo. A null here is
// what makes the caller fall back to text (or leave a fixed slot empty).
test("a provider with no icon returns null rather than a stand-in", () => {
  assert.equal(providerMark("fake"), null);
  assert.equal(providerMark("some_new_provider"), null);
  assert.equal(providerMark(""), null);
  assert.equal(providerMark(undefined), null);
});

test("exactly the advertised providers produce a mark", () => {
  for (const provider of providersWithIcons()) {
    assert.ok(providerMark(provider), `${provider} should render`);
  }
});
