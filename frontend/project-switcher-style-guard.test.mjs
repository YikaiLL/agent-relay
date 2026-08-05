// Two CSS defects that shipped in the Project switcher and were caught by eye,
// not by a test. Both are invisible to JSDOM (no stylesheet) and to the type-scale
// guard, so they are asserted against the stylesheet source instead — the same
// approach type-scale-guard.test.mjs takes.
//
// They are worth a guard because neither breaks anything: the control still works,
// it just quietly stops communicating. That is exactly the class of bug that
// survives a green suite.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CSS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "styles.css"),
  "utf8"
);

// Scan rather than regex the selector: a rule head can span lines (a grouped
// `a:hover,\n  a:focus-visible {` is the normal way to write one here), and a
// single-line pattern silently finds nothing — which reads as "the rule is fine"
// rather than "the test cannot see it".
function ruleBody(selector) {
  for (let from = 0; ; ) {
    const at = CSS.indexOf(selector, from);
    assert.notEqual(at, -1, `no rule found for ${selector}`);
    from = at + selector.length;

    // The match must be a whole selector, not a prefix of a longer one
    // (`.project-switcher-option` must not match `.project-switcher-options`),
    // and it must be in a rule HEAD rather than inside a declaration.
    const after = CSS.slice(from, from + 1);
    if (/[\w-]/.test(after)) {
      continue;
    }
    const open = CSS.indexOf("{", from);
    const close = CSS.indexOf("}", open);
    if (open === -1 || close === -1) {
      continue;
    }
    // Nothing but selector characters may sit between here and the brace.
    if (/[;:]/.test(CSS.slice(from, open).replace(/:[\w-]+(\([^)]*\))?/g, ""))) {
      continue;
    }
    return CSS.slice(open + 1, close);
  }
}

function declaration(body, property) {
  const match = body.match(new RegExp(`(?:^|;|\\n)\\s*${property}\\s*:\\s*([^;\\n]+)`));
  return match ? match[1].trim() : null;
}

// `button { display: inline-flex; justify-content: center }` is global in this
// stylesheet, so `text-align: left` on a button is a no-op on its own — the flex
// container keeps centring the content. Every other left-aligned button here sets
// both (.context-menu-button, .thread-group-name-button); the switcher shipped
// with only text-align and rendered a centred menu.
test("left-aligned switcher controls set justify-content, not just text-align", () => {
  for (const selector of [".project-switcher-trigger", ".project-switcher-option"]) {
    const body = ruleBody(selector);
    if (declaration(body, "text-align") !== "left") {
      continue;
    }
    assert.equal(
      declaration(body, "justify-content"),
      "flex-start",
      `${selector} sets text-align: left but not justify-content: flex-start — `
        + "buttons are centred flex containers globally, so text-align alone does nothing"
    );
  }
});

// The menu paints on --surface-2. Hover was ALSO --surface-2, so the highlight was
// the same colour as what it highlighted: the menu looked inert under the cursor.
test("the menu's hover background differs from the menu's own background", () => {
  const menuBackground = declaration(ruleBody(".project-switcher-menu"), "background");
  const hoverBackground = declaration(ruleBody(".project-switcher-option:hover"), "background");

  assert.ok(menuBackground, "the menu declares a background");
  assert.ok(hoverBackground, "hover declares a background");
  assert.notEqual(
    hoverBackground,
    menuBackground,
    "hover paints the same token as the surface beneath it, so it is invisible"
  );
});

// Same trap one level down: the selected row is already tinted, so its hover has
// to move again or the current selection becomes the one row that stops responding.
test("the active option still changes under the cursor", () => {
  const activeBackground = declaration(ruleBody(".project-switcher-option.is-active"), "background");
  const activeHover = declaration(ruleBody(".project-switcher-option.is-active:hover"), "background");

  assert.ok(activeHover, "the active option declares a hover background");
  assert.notEqual(activeHover, activeBackground, "the active row would not react to the cursor");
});
