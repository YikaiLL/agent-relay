import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StartSessionSplitButton } from "./start-session-split-button.js";

const h = React.createElement;

const TWO = [
  { label: "Codex", value: "codex" },
  { label: "Claude Code", value: "claude_code" },
];

function render(props = {}) {
  return renderToStaticMarkup(
    h(StartSessionSplitButton, {
      buttonId: "open-start-session-dialog",
      menuId: "agent-menu",
      onStart() {},
      onStartWithProvider() {},
      providerOptions: TWO,
      ...props,
    })
  );
}

test("the primary half keeps the id and the label the plain button had", () => {
  const html = render();
  // app.js has a document-level delegated listener on #open-start-session-dialog that
  // clears a pending project assignment; losing the id would silently break it.
  assert.match(html, /id="open-start-session-dialog"/);
  assert.match(html, /New session/);
  assert.match(html, /class="start-session-button"/);
});

test("one agent means no caret at all, not a dead one", () => {
  // A disabled half of a split button reads as broken. With nothing to choose between,
  // the control is simply the button it always was.
  const html = render({ providerOptions: [{ label: "Codex", value: "codex" }] });
  assert.doesNotMatch(html, /start-session-split-toggle/);
  assert.match(html, /id="open-start-session-dialog"/);
});

test("no picker handler also means no caret", () => {
  const html = render({ onStartWithProvider: undefined });
  assert.doesNotMatch(html, /start-session-split-toggle/);
});

test("the caret is a closed menu button until it is opened", () => {
  const html = render();
  assert.match(html, /start-session-split-toggle/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
  // Closed means ABSENT, not hidden — same rule the sidebar search field follows.
  assert.doesNotMatch(html, /start-session-split-menu/);
  // aria-controls must not point at a node that isn't rendered.
  assert.doesNotMatch(html, /aria-controls/);
});

test("an empty provider list degrades to the plain button", () => {
  const html = render({ providerOptions: [] });
  assert.doesNotMatch(html, /start-session-split-toggle/);
  assert.match(html, /New session/);
});

test("disabled propagates to both halves", () => {
  const html = render({ disabled: true });
  const disabledCount = (html.match(/disabled=""/g) || []).length;
  assert.equal(disabledCount, 2, "the caret must not stay live while the action is not");
});
