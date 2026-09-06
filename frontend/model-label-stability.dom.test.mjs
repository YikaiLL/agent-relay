import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { syncModelSuggestions } from "./shared/select-options.js";

for (const { provider, model, displayName } of [
  { provider: "codex", model: "chatgpt", displayName: "ChatGPT" },
  { provider: "cursor", model: "default[]", displayName: "Auto" },
  {
    provider: "claude_code",
    model: "default",
    displayName: "Default (recommended, Opus 5)",
  },
]) {
  test(`${provider} local selector keeps its DOM label across an empty snapshot`, () => {
    const previousDocument = globalThis.document;
    const dom = new JSDOM("<select></select>");
    globalThis.document = dom.window.document;
    try {
      const select = document.querySelector("select");
      const catalog = [{ model, display_name: displayName, is_default: true }];
      const labels = [];

      syncModelSuggestions(select, catalog, model, true, true);
      labels.push(select.selectedOptions[0]?.textContent);
      syncModelSuggestions(select, [], model, true, true, catalog);
      labels.push(select.selectedOptions[0]?.textContent);
      syncModelSuggestions(select, catalog, model, true, true);
      labels.push(select.selectedOptions[0]?.textContent);

      assert.deepEqual(labels, [displayName, displayName, displayName]);
    } finally {
      globalThis.document = previousDocument;
      dom.window.close();
    }
  });
}
