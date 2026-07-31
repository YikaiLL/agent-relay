// Guards WHICH focus reveals a project header's rename/delete buttons.
//
// The bug: the reveal was scoped to the whole header
// (`.thread-group-header-project:focus-within .thread-group-actions`), so
// clicking the +/- disclosure — which is inside the header — left the pencil and
// trash icons latched on until focus moved elsewhere. Folding a group should not
// arm its destructive actions.
//
// This reads the SHIPPED selector out of styles.css and runs it against a real
// DOM in both focus states, so it tests the cascade we actually ship rather than
// a copy of it. jsdom does not apply stylesheets well enough to just read
// getComputedStyle().opacity here, but its selector engine matches :focus-within
// fine, which is the part that carries the bug.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Comments are stripped first: they carry no braces, so the rule regex below
// would otherwise swallow a preceding comment into the selector list and hand
// matches() a string that throws.
const CSS = fs
  .readFileSync(path.join(HERE, "..", "styles.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

// The rule that un-hides the actions: a selector list ending in
// `.thread-group-actions` (or targeting it directly) whose body is `opacity: 1`.
function revealSelectors() {
  const rules = [...CSS.matchAll(/([^{}]*\.thread-group-actions[^{}]*)\{([^}]*)\}/g)];
  const reveal = rules.filter(([, , body]) => /opacity:\s*1\s*;?/.test(body));
  assert.ok(reveal.length, "expected a rule setting .thread-group-actions to opacity: 1");
  return reveal
    .flatMap(([, selectorList]) => selectorList.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildHeader() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="thread-group-header thread-group-header-project is-clickable">
      <span class="thread-group-icon"></span>
      <button type="button" class="thread-group-name thread-group-name-button">Alpha</button>
      <span class="thread-group-actions">
        <button type="button" class="thread-group-action" id="rename">rename</button>
        <button type="button" class="thread-group-action thread-group-action-danger" id="delete">delete</button>
      </span>
      <button type="button" class="thread-group-disclosure" id="disclosure" data-state="expanded"></button>
    </div>
  </body></html>`);
  return dom;
}

function actionsRevealed(dom) {
  const actions = dom.window.document.querySelector(".thread-group-actions");
  return revealSelectors().some((selector) => actions.matches(selector));
}

test("focusing the +/- disclosure does not reveal the project actions", () => {
  const dom = buildHeader();
  dom.window.document.querySelector("#disclosure").focus();
  assert.equal(
    actionsRevealed(dom),
    false,
    "folding a group must not arm its rename/delete buttons"
  );
});

test("focusing the project label does not reveal the project actions", () => {
  const dom = buildHeader();
  dom.window.document.querySelector(".thread-group-name-button").focus();
  assert.equal(actionsRevealed(dom), false);
});

// The reveal still has to happen for keyboard users, or rename/delete become
// mouse-only. `opacity: 0` keeps them focusable, so tabbing in must light them up.
test("focusing a rename/delete button reveals the project actions", () => {
  const dom = buildHeader();
  dom.window.document.querySelector("#rename").focus();
  assert.equal(actionsRevealed(dom), true, "tabbing to rename must make it visible");

  const other = buildHeader();
  other.window.document.querySelector("#delete").focus();
  assert.equal(actionsRevealed(other), true);
});

test("hovering the header still reveals the project actions", () => {
  // :hover cannot be simulated in jsdom, so assert the selector is still shipped.
  assert.ok(
    revealSelectors().some((s) => /\.thread-group-header-project:hover/.test(s)),
    "the mouse path must keep working"
  );
});
