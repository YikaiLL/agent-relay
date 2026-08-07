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
const renderSession = readFileSync(fileURLToPath(new URL("./render-session.js", import.meta.url)), "utf8");

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

// --- collapsed, the rail IS the navigation -----------------------------------
//
// While `body.sidebar-collapsed` is set the sidebar is `visibility: hidden`, so
// every row in `SidebarNav` is unreachable and the rail is the only navigation on
// screen. It shipped with a Tasks button and NO Sessions button — a user who
// collapsed the panel while on the Task screen had no way back to their sessions
// short of re-opening the panel. That gap was a consequence of the nav being a
// segmented control, which has no icon-only form to collapse into; a row is
// already a glyph plus a label, so the rail is just the same rows with the labels
// dropped. Both destinations, or the rail is not a nav.

// `assert.match` prints the ENTIRE haystack when it fails, and app.js is ~156 KB —
// one failed match scrolls the real message off the screen. These files are big
// enough that the regex plus a sentence is the more useful failure.
function assertSource(source, pattern, message) {
  assert.ok(pattern.test(source), `${message} (no match for ${pattern})`);
}

test("the collapsed rail offers both destinations, not just Tasks", () => {
  for (const id of ["icon-rail-sessions", "icon-rail-tasks"]) {
    assertSource(shell, new RegExp(`id:\\s*"${id}"`), `the rail is the whole nav while collapsed; it must render #${id}`);
  }
});

test("both rail destinations go to the same screens as their sidebar rows", () => {
  assertSource(
    appJs,
    /iconRailSessionsButton\?\.addEventListener\("click",\s*openSessionsScreen\)/,
    "the rail's Sessions button must open the Sessions screen"
  );
  assertSource(
    appJs,
    /iconRailTasksButton\?\.addEventListener\("click",\s*openTaskScreen\)/,
    "the rail's Tasks button must open the Task screen"
  );
});

// The rail lives outside `.app-shell`, so `[data-view]` on the shell cannot select
// into it. render-session mirrors the view onto `<body>`; drop that write and the
// rail silently stops saying where you are, with no other symptom.
test("the rail lights its current destination from body[data-view]", () => {
  assertSource(
    renderSession,
    /document\.body\.dataset\.view\s*=/,
    "the rail's selected state has no other source"
  );
  for (const selector of [
    'body:not([data-view="tasks"]) .icon-rail-sessions',
    'body[data-view="tasks"] .icon-rail-tasks',
  ]) {
    assert.match(ruleBody(selector), /background:\s*var\(/, `${selector} must fill, not merely recolour`);
  }
});

// One fact, two renderings: the sidebar shows a count, the rail shows a dot. Both
// are driven off the same `waiting` value inside renderTasksBadge, so they cannot
// disagree about whether anything is waiting. A rail that stayed quiet would go
// silent in exactly the state where the user has the least on screen to notice.
test("the waiting-task signal survives collapsing the sidebar", () => {
  assertSource(shell, /id:\s*"icon-rail-tasks-dot"/, "the badge needs a collapsed form");
  const start = renderSession.indexOf("function renderTasksBadge");
  assert.ok(start >= 0, "expected renderTasksBadge to still exist");
  const body = renderSession.slice(start, renderSession.indexOf("\n  }", start));
  assert.match(body, /sidebarTasksBadge\.hidden = waiting === 0/);
  assert.match(body, /iconRailTasksDot\.hidden = waiting === 0/, "both surfaces must read the same count");
});

// --- the sidebar nav is a row stack ------------------------------------------
//
// There is no track and no travelling indicator behind these rows, so the
// selected row has to carry a FILL of its own — colour alone leaves nothing
// marking where you are. And it must not be the raised/shadowed pill, which is
// this app's button treatment: "where you are" and "do this" have to stay apart.
test("the selected sidebar nav row is filled, not just recoloured", () => {
  const selected = ruleBody('.app-shell:not([data-view="tasks"]) #sidebar-nav-sessions');
  assert.match(selected, /background:\s*var\(--surface-\d\)/);
  assert.doesNotMatch(selected, /box-shadow/, "a shadow would make the current view look like a button");
});

// Hover and selection are both "a filled row", so if they land on adjacent
// surface steps they read as the same thing — hovering Sessions while on Tasks
// lit two rows that looked alike, worst in the light theme where the steps are
// closest. The exact tokens are free to move; sharing one is the bug.
test("hover and selection do not share a fill", () => {
  const fill = (body) => body.match(/background:\s*(var\(--surface-\d\))/)?.[1];
  const hover = fill(ruleBody(".sidebar-nav-row:hover"));
  const selected = fill(ruleBody('.app-shell:not([data-view="tasks"]) #sidebar-nav-sessions'));
  assert.ok(hover, "the hovered row must fill — it is the only affordance a row has");
  assert.ok(selected, "the selected row must fill");
  assert.notEqual(selected, hover, `hover and selected both use ${hover}; the row you are on becomes unreadable`);
});

test("exactly one nav row is marked aria-current", () => {
  assertSource(renderSession, /setAttribute\("aria-current", "page"\)/, "the current row must announce itself");
  assertSource(renderSession, /removeAttribute\("aria-current"\)/, "the row you left has to give it up");
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

// Every one of those gears is a bare glyph in a button, and the glyph is injected
// with `dangerouslySetInnerHTML`. A `click` only fires when mousedown and mouseup
// resolve to the SAME node, so if anything re-renders between the two the <svg> is
// replaced and the browser fires no click at all — the button hovers, depresses,
// and does nothing. Remote reproduces this on demand (its `[sidebar-debug]` tracer
// calls renderLog() on pointerdown, landing a re-render mid-gesture); local is one
// stray re-render away from the same thing. Making the icon transparent to hit
// testing means the button is always the target and the glyph's identity stops
// mattering.
test("an icon inside a button is never the click target", () => {
  assert.match(
    ruleBody(".inline-icon"),
    /pointer-events:\s*none/,
    "a re-render between mousedown and mouseup would otherwise swallow the click entirely"
  );
});

// The footer bar is `display: none` on local mobile, so the footer gear cannot be
// the only entry — the chat-header gear is what covers that case, and the ≤960px
// block has to un-hide it against the base `display: none`.
test("the mobile header gear survives as the phone entry point", () => {
  assert.match(mobileBlock(), /\.app-shell\s+\.header-settings-button\s*\{[^}]*display:\s*inline-flex/);
});
