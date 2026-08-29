// app.js kicks itself off with a bare `void boot();` in the MIDDLE of the module. Every
// statement in boot()'s prologue — everything before its first `await` — therefore runs
// synchronously at that point, while the rest of the module is still being evaluated.
//
// Any module-level `let`/`const` declared BELOW that line is in its temporal dead zone at
// that moment. Touching one is not a lint error and not a test failure anywhere else; it
// is a blank app and a `ReferenceError: Cannot access 'X' before initialization` in the
// console, from a minified name that maps back to nothing obvious.
//
// This happened for real: a render function was called as boot()'s first statement while
// the two `let` root handles it assigns to were declared ~1500 lines further down.
//
// The guard is textual on purpose. A runtime reproduction would need a DOM, the whole
// import graph and a relay to talk to, and would fail for a dozen reasons that are not
// this one.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function bootKickoffIndex(source) {
  const match = /^void boot\(\);$/m.exec(source);
  assert.ok(match, "app.js should still start itself with a top-level `void boot();`");
  return match.index;
}

// boot()'s synchronous prologue: from its opening brace to the first `await`. Statements
// after that first suspension run in a later microtask, by which point the module has
// finished evaluating and every declaration is live.
function bootPrologue(source) {
  const start = source.indexOf("async function boot() {");
  assert.ok(start >= 0, "app.js should still define `async function boot()`");
  const firstAwait = source.indexOf("await", start);
  assert.ok(firstAwait > start, "boot() should still await something");
  return source.slice(start, firstAwait);
}

// Module-level bindings only: `let x` / `const x` starting at column 0.
function moduleBindingsAfter(source, index) {
  const names = new Map();
  const re = /^(?:let|const)\s+([A-Za-z_$][\w$]*)/gm;
  let match;
  while ((match = re.exec(source))) {
    if (match.index > index && !names.has(match[1])) {
      names.set(match[1], match.index);
    }
  }
  return names;
}

// Identifiers named anywhere in the prologue, including inside the functions it calls is
// NOT covered — see the note in the assertion below.
function identifiersIn(chunk) {
  return new Set(chunk.match(/[A-Za-z_$][\w$]*/g) || []);
}

test("boot()'s synchronous prologue touches nothing declared below `void boot();`", () => {
  const kickoff = bootKickoffIndex(SOURCE);
  const prologue = bootPrologue(SOURCE);
  const late = moduleBindingsAfter(SOURCE, kickoff);
  const used = identifiersIn(prologue);

  const offenders = [...late.keys()].filter((name) => used.has(name));
  assert.deepEqual(
    offenders,
    [],
    `these are declared after \`void boot();\` but referenced in boot()'s synchronous `
      + `prologue, so they are in their temporal dead zone when it runs: `
      + `${offenders.join(", ")}. Move the declaration above \`void boot();\`, or move the `
      + `use after boot()'s first await.`
  );
});

// The direct-reference check above is exact but shallow: calling a hoisted function that
// itself closes over a late `let` fails the same way and reads identically in the console.
// That is the shape the real bug took, so it gets its own assertion — the render helpers
// that own a React root are the ones boot() paints with.
test("React root handles are declared before `void boot();`", () => {
  const kickoff = bootKickoffIndex(SOURCE);
  const late = moduleBindingsAfter(SOURCE, kickoff);
  const roots = [...late.keys()].filter((name) => /Root(Handle|Element)$/.test(name));

  assert.deepEqual(
    roots,
    [],
    `these React root handles are declared after \`void boot();\`: ${roots.join(", ")}. `
      + `A render function boot() calls in its prologue assigns to one of these, and a `
      + `\`let\` cannot be assigned before its declaration is evaluated.`
  );
});
