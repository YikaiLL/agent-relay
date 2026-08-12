// Guards that a group header's icon actually REPAINTS when its group is the
// active/selected one.
//
// The bug this file was written for: the project rule said
//
//   .thread-group-header-project.is-active .thread-group-icon::before {
//     color: var(--accent-primary);
//   }
//
// but the glyph it was trying to recolour is drawn with
// `border: 1.5px solid var(--text-tertiary)`. `color` does not repaint a border,
// and `border-color` does not inherit, so the declaration was a no-op: selecting
// a project left its icon grey. The workspace rule two hundred lines earlier got
// it right (`color` AND `border-color`), which is exactly why nobody noticed —
// the source looked like it had been handled.
//
// So the invariant is not "the state rule mentions the icon". It is: for every
// declaration that paints the glyph in the resting colour, the state rule must
// override THAT property, on THAT part of the glyph — unless the property
// inherits, in which case setting it on the icon covers the descendants it draws
// with. Resolved against the real token tables per theme, because the whole bug
// class lives in the gap between what a declaration says and what it paints.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Comments are stripped once, up front: the prose in this stylesheet contains
// braces, semicolons and selector names in backticks, any of which would be
// parsed as structure and make a rule unfindable — i.e. indistinguishable from
// someone having deleted the rule this guard exists to watch.
const CSS = fs
  .readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
    "utf8"
  )
  .replace(/\/\*[\s\S]*?\*\//g, "");

// --- reading the stylesheet -------------------------------------------------

// Every rule in the sheet, as { selectors, body }. Rules are matched by whole
// selector rather than substring: `.thread-group-icon` must not read
// `.thread-group-icon::before`, and a descendant rule ENDING in the same string
// must not be mistaken for the bare one.
function allRules() {
  const rules = [];
  for (const match of CSS.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selectors = match[1]
      .split(",")
      .map((one) => one.trim())
      .filter(Boolean);
    if (selectors.length) {
      rules.push({ selectors, body: match[2] });
    }
  }
  return rules;
}

const RULES = allRules();

function declaration(body, property) {
  const match = body.match(
    new RegExp(`(?:^|;|\\n)\\s*${property}\\s*:\\s*([^;\\n]+)`)
  );
  return match ? match[1].trim() : null;
}

// Token tables, with the light theme layered over the base one exactly as the
// cascade does.
function tokenTable({ light }) {
  const table = new Map();
  const blocks = /(^|\n)([^\n{}]*(?::root|prefers-color-scheme)[^{}]*)\{([^}]*)\}/g;
  for (const match of CSS.matchAll(blocks)) {
    const isLightBlock = /data-theme="light"|prefers-color-scheme:\s*light/.test(match[2]);
    if (isLightBlock && !light) continue;
    for (const decl of match[3].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      table.set(decl[1], decl[2].trim());
    }
  }
  return table;
}

const THEMES = [
  { name: "dark", tokens: tokenTable({ light: false }) },
  { name: "light", tokens: tokenTable({ light: true }) },
];

// Resolve var() chains the way a browser does. An UNDEFINED token silently falls
// through to its fallback, so undefined references are reported rather than
// resolved away — a guard that resolves them is green on the bug it exists for.
function resolve(value, tokens, missing, depth = 0) {
  assert.ok(depth < 12, `var() chain too deep resolving ${value}`);
  const at = value.indexOf("var(");
  if (at === -1) return value.trim();

  let open = 0;
  let end = -1;
  for (let i = at + 3; i < value.length; i += 1) {
    if (value[i] === "(") open += 1;
    else if (value[i] === ")") {
      open -= 1;
      if (open === 0) {
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
  return resolve(value.slice(0, at) + replacement + value.slice(end + 1), tokens, missing, depth + 1);
}

function paint(value, theme) {
  const missing = new Set();
  const resolved = resolve(value, theme.tokens, missing);
  assert.deepEqual(
    [...missing],
    [],
    `references custom properties defined in no theme: ${[...missing].join(", ")}`
      + " — an undefined token takes its fallback, so the declaration reads correct and paints wrong"
  );
  return resolved;
}

// --- what the glyph is made of ----------------------------------------------

// Properties that can carry the glyph's ink. `border` is a shorthand and is the
// way the outline was actually set, so it is expanded — a guard reading only
// longhands sees a glyph with no colour at all and passes trivially.
const INK_PROPERTIES = ["color", "border-color", "stroke", "fill"];

// Only `color` inherits. That asymmetry IS the bug: setting `color` on the icon
// reaches an <svg> painted with `currentColor`, but never reaches a border.
const INHERITS = new Set(["color"]);

function inkDeclarations(body) {
  const ink = new Map();
  for (const property of INK_PROPERTIES) {
    const value = declaration(body, property);
    if (value) ink.set(property, value);
  }
  if (!ink.has("border-color")) {
    const shorthand = declaration(body, "border");
    if (shorthand) {
      const colour = shorthand
        .replace(/^[\d.]+\S*\s+/, "")
        .replace(/^(solid|dashed|dotted|double|groove|ridge|inset|outset|none|hidden)\s+/, "")
        .trim();
      if (colour) ink.set("border-color", colour);
    }
  }
  return ink;
}

// The trailing component of a selector, when it targets the icon. Both the base
// rule and the state rule are keyed by this so they are compared part-for-part:
// a state rule that recolours `.thread-group-icon` has NOT recoloured a border
// declared on `.thread-group-icon::before`.
function glyphPart(selector) {
  const last = selector.trim().split(/\s+/).pop();
  return last?.startsWith(".thread-group-icon") ? last : null;
}

// Declarations that paint a glyph part at rest: rules whose selector IS the
// glyph part, with no ancestor qualifier.
function restingInk() {
  const parts = new Map();
  for (const rule of RULES) {
    for (const selector of rule.selectors) {
      const part = glyphPart(selector);
      if (!part || selector !== part) continue;
      const ink = parts.get(part) ?? new Map();
      for (const [property, value] of inkDeclarations(rule.body)) {
        ink.set(property, value);
      }
      parts.set(part, ink);
    }
  }
  assert.ok(parts.size, "expected at least one rule painting .thread-group-icon");
  return parts;
}

// Which (glyph part, property) pairs a state rule overrides, and to WHAT. The
// value is carried because naming the property is not the invariant: a state
// rule that sets `color: var(--text-tertiary)` overrides the resting colour with
// the resting colour, which is the same silent no-op in a different disguise.
function stateOverrides(stateSelector) {
  const overrides = [];
  for (const rule of RULES) {
    for (const selector of rule.selectors) {
      if (!selector.includes(stateSelector)) continue;
      const part = glyphPart(selector);
      if (!part) continue;
      for (const [property, value] of inkDeclarations(rule.body)) {
        overrides.push({ part, property, value });
      }
    }
  }
  return overrides;
}

// --- the invariant ----------------------------------------------------------

const STATES = [
  {
    what: "an active project",
    selector: ".thread-group-header-project.is-active",
  },
  {
    what: "a selected workspace",
    selector: ".thread-group.is-selected-workspace",
  },
];

// The invariant below is "every resting stroke moves". That is vacuously true if
// there are no resting strokes — so if the icon rule ever stops declaring a
// colour of its own (leaving the mark to inherit `--text-primary` from the
// header), the loop would iterate nothing and the test would go green while
// guarding nothing at all. Asserted separately so that failure names itself
// instead of hiding as a pass.
test("the icon declares a resting colour for the state rules to move", () => {
  const resting = restingInk();
  for (const theme of THEMES) {
    const strokes = [...resting].flatMap(([part, ink]) =>
      [...ink]
        .filter(([, value]) => THEME_RESTING_COLOURS(theme).has(paint(value, theme)))
        .map(([property]) => `${part}{${property}}`)
    );
    assert.ok(
      strokes.length,
      `${theme.name}: nothing paints the icon at the resting colour, so the repaint `
        + "check below has nothing to check — either the icon lost its own colour, or "
        + "the resting token moved and this guard stopped watching the real one"
    );
  }
});

test("selecting a group repaints every stroke of its icon, in both themes", () => {
  const resting = restingInk();

  for (const state of STATES) {
    const overrides = stateOverrides(state.selector);
    assert.ok(
      overrides.length,
      `${state.selector} does not recolour the icon at all`
    );

    for (const theme of THEMES) {
      for (const [part, ink] of resting) {
        for (const [property, value] of ink) {
          const restColour = paint(value, theme);
          // Only strokes that sit at the resting colour need moving. A mask fill
          // painted with the surface token is meant to stay put.
          const isResting = THEME_RESTING_COLOURS(theme).has(restColour);
          if (!isResting) continue;

          const covering = overrides.filter(
            (override) =>
              override.property === property &&
              (override.part === part ||
                (INHERITS.has(property) && part.startsWith(override.part)))
          );

          assert.ok(
            covering.length,
            `${theme.name}: ${state.what} leaves \`${property}\` on \`${part}\` at `
              + `${restColour}. The state rule must override ${property} on that part — `
              + (INHERITS.has(property)
                ? "it inherits, so an ancestor icon rule would also do."
                : `${property} does NOT inherit, so recolouring another property `
                  + "(or another part) leaves this stroke grey while the rest turns accent.")
          );

          // Overriding is necessary but not sufficient: the override has to MOVE the
          // colour. Naming the property while resolving back to the resting value
          // repaints grey over grey, and a guard that stopped at "the property is
          // mentioned" would call that handled.
          for (const override of covering) {
            assert.notEqual(
              paint(override.value, theme),
              restColour,
              `${theme.name}: ${state.what} sets \`${property}\` on \`${override.part}\` to `
                + `${restColour} — the same colour it already had, so selecting the group `
                + "changes nothing on screen"
            );
          }
        }
      }
    }
  }
});

// The resting colour, resolved per theme, so the check above does not have to
// hardcode a hex that the palette is free to change.
function THEME_RESTING_COLOURS(theme) {
  return new Set([paint("var(--text-tertiary)", theme)]);
}
