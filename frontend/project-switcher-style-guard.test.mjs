// CSS defects in the Project switcher that a green suite could not see.
//
// Every one of these was found by eye, and the first version of this file was
// itself green under one of them: it compared SOURCE STRINGS, so
// `var(--surface-4, var(--surface-3))` and `var(--surface-3)` looked like two
// different colours while resolving to the same one — because `--surface-4` was
// never defined and the fallback quietly took over.
//
// So the rule this file now follows: resolve variables against the real token
// tables, per theme, and compare the values a browser would actually paint. A
// guard that reads declarations literally cannot catch the bugs that live in the
// gap between what a declaration says and what it computes to.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CSS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "styles.css"),
  "utf8"
);

// --- reading the stylesheet -------------------------------------------------

// Scan rather than regex the selector: a rule head can span lines (a grouped
// `a:hover,\n  a:focus-visible {` is the normal way to write one here), and a
// single-line pattern silently finds nothing — which reads as "the rule is fine"
// rather than "the test cannot see it".
function ruleBody(selector) {
  for (let from = 0; ; ) {
    const at = CSS.indexOf(selector, from);
    assert.notEqual(at, -1, `no rule found for ${selector}`);
    from = at + selector.length;

    // A whole selector, not a prefix of a longer one (`.project-switcher-option`
    // must not match `.project-switcher-options`).
    if (/[\w-]/.test(CSS.slice(from, from + 1))) {
      continue;
    }
    const open = CSS.indexOf("{", from);
    const close = CSS.indexOf("}", open);
    if (open === -1 || close === -1) {
      continue;
    }
    // Nothing but selector characters between here and the brace.
    if (/[;]/.test(CSS.slice(from, open))) {
      continue;
    }
    return CSS.slice(open + 1, close);
  }
}

function declaration(body, property) {
  const match = body.match(new RegExp(`(?:^|;|\\n)\\s*${property}\\s*:\\s*([^;\\n]+)`));
  return match ? match[1].trim() : null;
}

// Token tables. The light theme overrides the base one, exactly as the cascade
// does, so a token defined in only one theme still resolves in both — and one
// defined in NEITHER is what this file exists to catch.
function tokenTable({ light }) {
  const table = new Map();
  const blockPattern = /(^|\n)([^\n{}]*(?::root|prefers-color-scheme)[^{}]*)\{([^}]*)\}/g;
  for (const match of CSS.matchAll(blockPattern)) {
    const head = match[2];
    const isLightBlock = /data-theme="light"|prefers-color-scheme:\s*light/.test(head);
    if (isLightBlock && !light) {
      continue;
    }
    for (const declMatch of match[3].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      table.set(declMatch[1], declMatch[2].trim());
    }
  }
  return table;
}

const THEMES = [
  { name: "dark", tokens: tokenTable({ light: false }) },
  { name: "light", tokens: tokenTable({ light: true }) },
];

// Resolve `var(--a, fallback)` the way a browser does: an UNDEFINED token falls
// through to its fallback silently. That silence is the whole bug class here, so
// undefined references are reported rather than resolved away.
function resolve(value, tokens, missing, depth = 0) {
  assert.ok(depth < 12, `var() chain too deep resolving ${value}`);
  const at = value.indexOf("var(");
  if (at === -1) {
    return value.trim();
  }

  // Find this var()'s matching close paren so nested fallbacks survive.
  let depthCount = 0;
  let end = -1;
  for (let i = at + 3; i < value.length; i += 1) {
    if (value[i] === "(") depthCount += 1;
    else if (value[i] === ")") {
      depthCount -= 1;
      if (depthCount === 0) {
        end = i;
        break;
      }
    }
  }
  assert.notEqual(end, -1, `unbalanced var() in ${value}`);

  const inner = value.slice(at + 4, end);
  const comma = inner.indexOf(",");
  const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
  const fallback = comma === -1 ? null : inner.slice(comma + 1).trim();

  let replacement;
  if (tokens.has(name)) {
    replacement = tokens.get(name);
  } else {
    missing.add(name);
    replacement = fallback ?? `UNDEFINED(${name})`;
  }

  return resolve(
    value.slice(0, at) + replacement + value.slice(end + 1),
    tokens,
    missing,
    depth + 1
  );
}

function paintedBackground(selector, theme) {
  const value = declaration(ruleBody(selector), "background");
  assert.ok(value, `${selector} declares a background`);
  const missing = new Set();
  const resolved = resolve(value, theme.tokens, missing);
  assert.deepEqual(
    [...missing],
    [],
    `${selector} references custom properties that are defined in no theme: ${[...missing].join(", ")}`
      + " — an undefined token resolves to its fallback, so the declaration reads correct and paints wrong"
  );
  return resolved;
}

// --- the invariants ---------------------------------------------------------

// `button { display: inline-flex; justify-content: center }` is global in this
// stylesheet, so `text-align: left` on a button is a no-op on its own — the flex
// container keeps centring the content. Every other left-aligned button here sets
// both (.context-menu-button, .thread-group-name-button); the switcher shipped
// with only text-align and rendered a centred menu.
//
// Both are asserted unconditionally. An earlier version skipped the check when
// text-align was absent, which would have passed a rule that simply deleted it.
test("left-aligned switcher controls set BOTH text-align and justify-content", () => {
  for (const selector of [".project-switcher-trigger", ".project-switcher-option"]) {
    const body = ruleBody(selector);
    assert.equal(declaration(body, "text-align"), "left", `${selector} sets text-align: left`);
    assert.equal(
      declaration(body, "justify-content"),
      "flex-start",
      `${selector} must also set justify-content: flex-start — buttons are centred `
        + "flex containers globally, so text-align alone does nothing"
    );
  }
});

// The menu paints on --surface-2. Hover was ALSO --surface-2, so the highlight was
// the same colour as what it highlighted: the menu looked inert under the cursor.
test("the menu's hover background differs from the menu's own background, in both themes", () => {
  for (const theme of THEMES) {
    assert.notEqual(
      paintedBackground(".project-switcher-option:hover", theme),
      paintedBackground(".project-switcher-menu", theme),
      `${theme.name}: hover paints the same colour as the surface beneath it, so it is invisible`
    );
  }
});

// Same trap one level down, and the one the first version of this file missed:
// the selected row is already tinted, so its hover has to move AGAIN or the
// current selection becomes the one row in the menu that stops responding.
test("the active option still changes colour under the cursor, in both themes", () => {
  for (const theme of THEMES) {
    assert.notEqual(
      paintedBackground(".project-switcher-option.is-active:hover", theme),
      paintedBackground(".project-switcher-option.is-active", theme),
      `${theme.name}: the active row would not react to the cursor`
    );
  }
});

// The resolver is the load-bearing part of the two tests above, so it gets its own
// check: if it ever stops noticing an undefined token, they both go quietly green.
test("the resolver reports an undefined token instead of silently taking the fallback", () => {
  const missing = new Set();
  const resolved = resolve("var(--not-a-real-token, #ff0000)", THEMES[0].tokens, missing);
  assert.equal(resolved, "#ff0000", "a browser would take the fallback");
  assert.deepEqual([...missing], ["--not-a-real-token"], "and the guard has to say so");
});

test("both themes actually define the tokens these rules paint with", () => {
  for (const theme of THEMES) {
    for (const token of ["--surface-2", "--surface-3", "--surface-4"]) {
      assert.ok(theme.tokens.has(token), `${theme.name} defines ${token}`);
    }
  }
});
