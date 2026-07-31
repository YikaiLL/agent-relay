// The remote sidebar's Providers panel shows each agent's MARK, not its name.
//
// The drawer is narrow and the row already spends width on a status dot and a status
// word, so the provider name was the thing to trade for a glyph — matching the session
// rows and the tab strip, which already use the mark.
//
// Kept in its own file so the DOM globals below don't leak into the static suite.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ProviderStatusSection } = await import("./provider-status-section.js");

const h = React.createElement;

const row = (over = {}) => ({
  key: "codex",
  label: "Codex",
  status: "connected",
  statusLabel: "ready",
  dotClass: "provider-dot-connected",
  reason: null,
  ...over,
});

function render(model) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(h(ProviderStatusSection, { model })));
  return {
    host,
    rowFor: (key) => host.querySelector(`.provider-status-row[data-provider="${key}"]`),
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test("a provider with an icon shows the mark and no visible name", () => {
  const view = render([row()]);
  try {
    const name = view.rowFor("codex").querySelector(".provider-status-name");
    assert.ok(name.querySelector(".provider-mark"), "the mark is rendered");
    assert.equal(
      name.querySelector(".provider-mark").getAttribute("data-provider"),
      "codex"
    );
    // The name survives only for assistive tech.
    assert.equal(name.querySelector(".sr-only").textContent, "Codex");
    assert.equal(
      name.textContent.replace("Codex", "").trim(),
      "",
      "no provider name is painted next to the mark"
    );
  } finally {
    view.cleanup();
  }
});

test("claude gets its own mark, not codex's", () => {
  const view = render([row({ key: "claude_code", label: "Claude" })]);
  try {
    const mark = view.rowFor("claude_code").querySelector(".provider-mark");
    assert.equal(mark.getAttribute("data-provider"), "claude_code");
  } finally {
    view.cleanup();
  }
});

// The rule that keeps this honest: we ship icons for exactly claude_code and codex, so
// anything else must keep its NAME rather than borrow a logo that would mislabel it.
test("a provider with no icon still shows its name as text", () => {
  const view = render([row({ key: "fake", label: "Fake" })]);
  try {
    const name = view.rowFor("fake").querySelector(".provider-status-name");
    assert.equal(name.querySelector(".provider-mark"), null, "no borrowed logo");
    assert.equal(name.textContent, "Fake");
    assert.equal(name.querySelector(".sr-only"), null, "the visible name is the label");
  } finally {
    view.cleanup();
  }
});

test("the status word and dot are untouched by the swap", () => {
  const view = render([row({ statusLabel: "degraded", dotClass: "provider-dot-warn" })]);
  try {
    const el = view.rowFor("codex");
    assert.equal(el.querySelector(".provider-status-state").textContent, "degraded");
    assert.ok(el.querySelector(".provider-status-dot").classList.contains("provider-dot-warn"));
  } finally {
    view.cleanup();
  }
});

test("mixed providers each resolve independently", () => {
  const view = render([row(), row({ key: "fake", label: "Fake" })]);
  try {
    assert.ok(view.rowFor("codex").querySelector(".provider-mark"));
    assert.equal(view.rowFor("fake").querySelector(".provider-mark"), null);
  } finally {
    view.cleanup();
  }
});

test("an empty model renders nothing at all", () => {
  for (const model of [[], null, undefined]) {
    const view = render(model);
    try {
      assert.equal(view.host.querySelector(".provider-status-list"), null);
    } finally {
      view.cleanup();
    }
  }
});
