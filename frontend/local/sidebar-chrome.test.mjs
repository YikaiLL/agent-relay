// Guards for where the app's brand and its way into Settings live.
//
// Background: both used to sit in a 64px icon rail to the left of the sidebar —
// seal logo at the top, gear at the bottom, nothing else. They have moved into
// the sidebar itself (logo into the brand lockup, gear onto the footer status
// line), which leaves the rail with nothing to show while the sidebar is open.
// So the rail is now the COLLAPSED-state shell only.
//
// That split has two failure modes worth pinning down:
//
//   1. Show the rail while expanded and the logo and the gear each render TWICE,
//      64px apart.
//   2. Hide the rail while collapsed and the window has no brand and no reachable
//      Settings at all — the sidebar that holds the replacements is
//      `visibility: hidden` in exactly that state.
//
// The collapsed appearance is meant to be unchanged from before the split.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Comments are stripped before any parsing: the naive "walk back to the previous
// `}` to find the selector head" trick below would otherwise swallow the comment
// above a rule, and prose commas ("Expanded, its two occupants…") would split
// into bogus selectors and hide the real one.
const styles = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);
const shell = readFileSync(fileURLToPath(new URL("./react-shell.js", import.meta.url)), "utf8");
const appJs = readFileSync(fileURLToPath(new URL("../app.js", import.meta.url)), "utf8");

// Pull the body of the first rule whose selector list contains an exact match,
// searching only within `scope` (so a media-query block can be searched on its
// own). Mirrors the helper in panel-collapse.test.mjs.
function ruleBody(selector, scope = styles) {
  let cursor = 0;
  while (cursor < scope.length) {
    const brace = scope.indexOf("{", cursor);
    if (brace < 0) break;
    const head = scope.slice(Math.max(scope.lastIndexOf("}", brace - 1) + 1, 0), brace);
    if (head.trim().startsWith("@")) {
      cursor = brace + 1;
      continue;
    }
    const selectors = head.replace(/\s+/g, " ").split(",").map((s) => s.trim()).filter(Boolean);
    if (selectors.includes(selector)) {
      let depth = 1;
      let scan = brace + 1;
      while (scan < scope.length && depth > 0) {
        if (scope[scan] === "{") depth += 1;
        else if (scope[scan] === "}") depth -= 1;
        scan += 1;
      }
      return scope.slice(brace + 1, scan - 1);
    }
    cursor = brace + 1;
  }
  throw new Error(`Could not find CSS rule for selector \`${selector}\``);
}

// The text of the `@media (max-width: 960px)` block, brace-matched.
function mobileBlock() {
  const start = styles.indexOf("@media (max-width: 960px)");
  assert.ok(start >= 0, "expected a ≤960px media query");
  const brace = styles.indexOf("{", start);
  let depth = 1;
  let scan = brace + 1;
  while (scan < styles.length && depth > 0) {
    if (styles[scan] === "{") depth += 1;
    else if (styles[scan] === "}") depth -= 1;
    scan += 1;
  }
  return styles.slice(brace + 1, scan - 1);
}

// --- the rail is the collapsed-state shell ----------------------------------

test("the icon rail is hidden while the sidebar is expanded", () => {
  assert.match(
    ruleBody(".icon-rail"),
    /display:\s*none/,
    "an expanded sidebar already shows the logo and the gear; the rail would duplicate both"
  );
});

test("the icon rail comes back when the sidebar collapses", () => {
  assert.match(
    ruleBody("body.sidebar-collapsed .icon-rail"),
    /display:\s*flex/,
    "collapsed, the rail is the only surviving brand + Settings surface"
  );
});

// Specificity regression. `body.sidebar-collapsed .icon-rail { display: flex }`
// scores (0,2,1), and a media query contributes NO specificity of its own — so a
// bare `.icon-rail { display: none }` inside the ≤960px block scores (0,1,0) and
// LOSES. The rail would pop back onto a phone screen the moment the sidebar
// happened to be collapsed, which is most of the time on mobile.
test("the mobile kill-switch still beats the collapsed rule", () => {
  const mobile = mobileBlock();
  assert.match(
    ruleBody("body.sidebar-collapsed .icon-rail", mobile),
    /display:\s*none/,
    "≤960px must hide the rail even when the sidebar is collapsed"
  );
});

// --- the brand lockup --------------------------------------------------------

test("the local sidebar brand renders the seal logo beside the wordmark", () => {
  assert.match(shell, /className:\s*"sidebar-brand-logo"/);
  assert.match(shell, /src:\s*"\/static\/sealwire_logo\.png"/);
});

// --- Settings is reachable in every state -----------------------------------

test("the sidebar footer carries a Settings gear", () => {
  assert.match(shell, /id:\s*"sidebar-settings"/);
  assert.match(shell, /className:\s*"sidebar-settings-button"/);
});

test("all three Settings gears are wired to the modal", () => {
  for (const id of ["sidebar-settings", "open-settings-header"]) {
    assert.match(
      appJs,
      new RegExp(`getElementById\\("${id}"\\)[\\s\\S]{0,80}?openSettingsModal\\(\\)`),
      `#${id} must open the Settings modal`
    );
  }
  assert.match(appJs, /iconRailSettingsButton\?\.addEventListener\([\s\S]{0,60}?openSettingsModal\(\)/);
});

// The footer bar is `display: none` on local mobile, so the footer gear cannot be
// the only entry — the chat-header gear is what covers that case, and the ≤960px
// block has to un-hide it against the base `display: none`.
test("the mobile header gear survives as the phone entry point", () => {
  assert.match(mobileBlock(), /\.app-shell\s+\.header-settings-button\s*\{[^}]*display:\s*inline-flex/);
});
