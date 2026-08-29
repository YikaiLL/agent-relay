import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConversationHeader, ConversationHeadingBody } from "./conversation-header.js";

const h = React.createElement;

test("the header renders one leading wrapper, one heading and one action cluster", () => {
  const html = renderToStaticMarkup(
    h(ConversationHeader, {
      backButtonId: "go-console-home",
      backLabel: "Back to console",
      composeButtonId: "new-session-compose-button",
      leftPanelToggleId: "toggle-left-panel",
      heading: h("span", null, "heading"),
      actions: h("span", null, "actions"),
    })
  );
  assert.match(html, /class="chat-header"/);
  assert.match(html, /class="chat-header-leading"/);
  assert.match(html, /class="chat-heading"/);
  assert.match(html, /class="chat-header-actions"/);
  // The wrapper that remote used to call `.chat-header-main`. Both surfaces now emit the
  // same one, which is the whole point of this component existing.
  assert.doesNotMatch(html, /chat-header-main/);
});

test("ids and the back label travel with the surface, not with the component", () => {
  const html = renderToStaticMarkup(
    h(ConversationHeader, {
      backButtonId: "remote-home-button",
      backLabel: "All relays",
      backHidden: false,
      composeButtonId: "remote-new-session-compose-button",
      leftPanelToggleId: "remote-toggle-left-panel",
      headingId: "remote-chat-heading",
    })
  );
  assert.match(html, /id="remote-home-button"/);
  assert.match(html, /title="All relays"/);
  assert.match(html, /id="remote-chat-heading"/);
  // Not hidden when the surface says it should show.
  assert.doesNotMatch(html, /id="remote-home-button"[^>]*hidden/);
});

test("the back button is hidden by default, because most views have nowhere to go back to", () => {
  const html = renderToStaticMarkup(
    h(ConversationHeader, { backButtonId: "b", composeButtonId: "c", leftPanelToggleId: "l" })
  );
  assert.match(html, /chat-heading-back-button[^>]*hidden/);
});

test("the nav toggle is a slot, so the surface without a drawer renders none", () => {
  const withDrawer = renderToStaticMarkup(
    h(ConversationHeader, {
      backButtonId: "b",
      composeButtonId: "c",
      leftPanelToggleId: "l",
      navToggle: h("button", { className: "remote-nav-toggle-button" }),
    })
  );
  const without = renderToStaticMarkup(
    h(ConversationHeader, { backButtonId: "b", composeButtonId: "c", leftPanelToggleId: "l" })
  );
  assert.match(withDrawer, /remote-nav-toggle-button/);
  assert.doesNotMatch(without, /remote-nav-toggle-button/);
});

test("the heading body puts title, status and info on one row above the subtitle", () => {
  const html = renderToStaticMarkup(
    h(ConversationHeadingBody, {
      titleNode: h("h1", null, "Curio"),
      statusNode: h("span", { className: "status-badge" }, "Idle"),
      infoButton: h("button", { className: "chat-heading-info-button" }),
      subtitleNode: h("p", { className: "chat-subtitle" }, "standby"),
    })
  );
  const row = html.indexOf("chat-heading-title-row");
  const subtitle = html.indexOf("chat-subtitle");
  assert.ok(row >= 0 && subtitle > row, "the subtitle follows the title row");
  assert.match(html, /<h1>Curio<\/h1>/);
  assert.match(html, /status-badge/);
});

// The reason the two headers drifted in the first place was that nothing stopped a second
// copy of this markup from appearing. Both surfaces must go through the component.
test("neither surface hand-rolls its own .chat-header markup any more", () => {
  for (const rel of ["../local/react-shell.js", "../remote/react-app.js"]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.match(src, /ConversationHeader/, `${rel} should render the shared header`);
    assert.doesNotMatch(
      src,
      /className:\s*"chat-header"/,
      `${rel} builds its own <header class="chat-header"> instead of using ConversationHeader`
    );
  }
});
