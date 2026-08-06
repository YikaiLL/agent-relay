// The local surface renders its composer options OUTSIDE React — app.js fills
// #message-model imperatively — so the chip's logo cannot be derived from props
// there. It is resolved from the DOM instead: every <option> carries its vendor
// in data-provider, and the mark slot is rewritten from whichever option is
// currently selected.
//
// That path has no React to re-render it and no props to assert against, so it
// gets a DOM-level guard exercising the real renderer and a real <select>
// rather than a hand-rolled stand-in for one.
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

const { applyProviderMark } = await import("./provider-mark.js");
const { replaceSelectOptions } = await import("./select-options.js");

// Shaped like the catalog app.js builds: display label, vendor, model id. The
// fake provider reports no vendor, which is the "ship no logo" case.
const MODEL_OPTIONS = [
  { label: "Sonnet 4.6", provider: "anthropic", value: "claude-sonnet-4-6" },
  { label: "GPT-5.5", provider: "openai", value: "gpt-5.5" },
  { label: "Fake Echo", provider: "", value: "fake-echo" },
];

// The exact read syncComposerModelMark() performs in app.js.
function syncMark(select, slot) {
  return applyProviderMark(slot, select.selectedOptions[0]?.dataset?.provider || "");
}

function mount(selectedValue) {
  document.body.innerHTML =
    '<span class="composer-model-picker">'
    + '<span class="composer-model-mark" id="message-model-mark"></span>'
    + '<select id="message-model"></select>'
    + "</span>";
  const select = document.getElementById("message-model");
  const slot = document.getElementById("message-model-mark");
  replaceSelectOptions(select, MODEL_OPTIONS, selectedValue);
  return { select, slot };
}

test("options rendered outside React still carry their vendor", () => {
  const { select } = mount("gpt-5.5");
  assert.equal(select.options[0].dataset.provider, "anthropic");
  assert.equal(select.options[1].dataset.provider, "openai");
  // No vendor reported means no attribute at all, so nothing to mis-resolve.
  assert.equal(select.options[2].dataset.provider, undefined);
  assert.equal(select.value, "gpt-5.5");
});

test("the slot shows the vendor of the selected option", () => {
  const { select, slot } = mount("gpt-5.5");
  assert.equal(syncMark(select, slot), true);
  assert.equal(slot.getAttribute("data-provider"), "codex");
  assert.match(slot.innerHTML, /<svg/);
});

test("changing the selection swaps the logo", () => {
  const { select, slot } = mount("gpt-5.5");
  syncMark(select, slot);
  const openaiMark = slot.innerHTML;

  select.value = "claude-sonnet-4-6";
  syncMark(select, slot);
  assert.equal(slot.getAttribute("data-provider"), "claude_code");
  assert.notEqual(slot.innerHTML, openaiMark);
});

test("selecting a vendor we ship no mark for empties the slot", () => {
  // The regression this exists for: leaving the previous logo in place would
  // relabel a fake/unknown model as the vendor the user was last on.
  const { select, slot } = mount("claude-sonnet-4-6");
  syncMark(select, slot);
  assert.equal(slot.getAttribute("data-provider"), "claude_code");

  select.value = "fake-echo";
  assert.equal(syncMark(select, slot), false);
  assert.equal(slot.getAttribute("data-provider"), null);
  assert.equal(slot.innerHTML, "");
});

test("a catalog refresh that changes vendors is picked up", () => {
  // replaceSelectOptions short-circuits when options look unchanged; vendor is
  // part of that comparison, so a same-label/same-value catalog that switched
  // vendors must still re-render (and re-mark).
  const { select, slot } = mount("gpt-5.5");
  syncMark(select, slot);
  assert.equal(slot.getAttribute("data-provider"), "codex");

  replaceSelectOptions(
    select,
    [{ label: "GPT-5.5", provider: "anthropic", value: "gpt-5.5" }],
    "gpt-5.5"
  );
  syncMark(select, slot);
  assert.equal(slot.getAttribute("data-provider"), "claude_code");
});
