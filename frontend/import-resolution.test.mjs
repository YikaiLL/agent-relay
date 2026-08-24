// Every named import in the frontend must actually be exported by the module it
// names.
//
// This exists because one wasn't, for two commits and counting: `render-session.js`
// imported `workspaceTitle` from `./dom.js` after that export was deleted (the element
// moved into a React sub-root, so the import-time `querySelector` could only ever have
// captured null). The binding was unused, so nothing broke — the bundler downgraded it
// to a warning nobody read, and `npm test` printed that warning on every run while
// reporting a pass.
//
// It is not harmless in general. Under native ESM a missing named export is a
// LINK-TIME error: the module graph fails to load, and the failure names a file that
// is fine. The bundler is what makes this survivable, which is exactly why it needs a
// test rather than a habit.
//
// Deliberately syntactic and conservative: it reads exports rather than executing
// anything (these modules touch `document` at import time), and a module it cannot
// fully understand is REPORTED, not skipped — a scanner that silently gives up is the
// same failure one level up.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(ROOT);

// `scripts/` too: the e2e harness imports frontend modules by relative path, and a
// stale one there costs a browser suite twenty minutes in instead of a millisecond.
const SCAN_ROOTS = [ROOT, path.join(REPO, "scripts")];

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
      out.push(full);
    }
  }
  return out;
}

// Comments only. An earlier version of this helper also stripped string literals and
// was then used to decide whether an import "really" existed — but an import PATH is a
// string literal, so every real import looked like it had been stripped away and the
// scan silently covered nothing. It reported a clean pass over a tree containing the
// very defect it was written for.
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// Comments AND strings, for reading exports — there no string literal carries meaning.
function stripped(source) {
  return withoutComments(source)
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""');
}

function importsWithPaths(raw) {
  const clean = withoutComments(raw);
  const result = [];
  const pattern = /(^|\n)\s*import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const match of clean.matchAll(pattern)) {
    const names = match[2]
      .split(",")
      .map((one) => one.trim())
      .filter(Boolean)
      .map((one) => one.split(/\s+as\s+/)[0].trim())
      .filter((one) => one && one !== "type");
    result.push({ names, from: match[3] });
  }
  return result;
}

function exportedNames(source) {
  const clean = stripped(source);
  const names = new Set();
  let opaque = false;

  for (const match of clean.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  for (const match of clean.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const pieces = trimmed.split(/\s+as\s+/);
      names.add((pieces[1] || pieces[0]).trim());
    }
  }
  // `export * from "./x"` re-exports names this scanner cannot see without following
  // the chain. Rather than pass such a module by accident, mark it and say so.
  if (/export\s*\*/.test(clean)) {
    opaque = true;
  }
  return { names, opaque };
}

const FILES = SCAN_ROOTS.flatMap((dir) => sourceFiles(dir));

test("the frontend and scripts trees have sources to scan at all", () => {
  assert.ok(FILES.length > 50, `expected a real tree, found ${FILES.length} files`);
  // Per root, not just in total: a mistyped root would still clear the bar above
  // on the strength of the other one, and cover nothing.
  for (const dir of SCAN_ROOTS) {
    assert.ok(
      sourceFiles(dir).length > 10,
      `expected sources under ${path.relative(REPO, dir)}, found ${sourceFiles(dir).length}`
    );
  }
});

test("every named import resolves to a real export", () => {
  const broken = [];
  const unverifiable = [];

  for (const file of FILES) {
    const raw = fs.readFileSync(file, "utf8");
    for (const spec of importsWithPaths(raw)) {
      if (!spec.from.startsWith(".")) continue;

      const target = path.resolve(path.dirname(file), spec.from);
      if (!fs.existsSync(target)) {
        broken.push(`${path.relative(REPO, file)} imports from "${spec.from}", which does not exist`);
        continue;
      }

      const { names, opaque } = exportedNames(fs.readFileSync(target, "utf8"));
      if (opaque) {
        unverifiable.push(`${path.relative(REPO, target)} uses \`export *\``);
        continue;
      }
      for (const name of spec.names) {
        if (!names.has(name)) {
          broken.push(
            `${path.relative(REPO, file)} imports { ${name} } from "${spec.from}", `
              + "which does not export it"
          );
        }
      }
    }
  }

  // Reported, not swallowed: if a module ever starts re-exporting, this test quietly
  // stops covering its consumers, and that should be a visible decision.
  assert.deepEqual(
    unverifiable,
    [],
    `these modules cannot be checked by a syntactic scan: ${unverifiable.join("; ")}`
  );
  assert.deepEqual(broken, [], `unresolved named imports:\n  ${broken.join("\n  ")}`);
});
