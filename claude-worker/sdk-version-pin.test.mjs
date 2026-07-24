import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Guard: the Claude Code SDK must be pinned to an EXACT version, not a range.
//
// sealwire is a published CLI with NO published lockfile, so consumers doing
// `npm install sealwire` resolve this dependency's RANGE fresh against the
// registry. A caret (`^0.3.210`) therefore lets an untested — and, as we hit in
// production, sometimes broken — newer patch (0.3.218 with a truncated native
// binary) install on user machines. Pinning gives ship-what-you-test.
// ─────────────────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const SDK = "@anthropic-ai/claude-agent-sdk";
const EXACT = /^\d+\.\d+\.\d+$/; // no ^, ~, ranges, x, *, ||

function sdkDep(pkgPath) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return pkg.dependencies?.[SDK];
}

// The lockfile's root dependency spec must match the pinned manifest — a stale
// `^0.3.210` there would let `npm install` (with the manifest pin) still record
// a range, and undercuts the guarantee.
function lockfileRootSpec(lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  return lock.packages?.[""]?.dependencies?.[SDK];
}

test("root package.json pins the SDK to an exact version", () => {
  const version = sdkDep(join(here, "..", "package.json"));
  assert.ok(version, `${SDK} must be a dependency of the published package`);
  assert.match(
    version,
    EXACT,
    `expected an exact version, got "${version}" — a caret/tilde lets a broken newer patch install on user machines`,
  );
});

test("claude-worker/package.json pins the SDK to an exact version", () => {
  const version = sdkDep(join(here, "package.json"));
  assert.ok(version, `${SDK} must be a dependency of claude-worker`);
  assert.match(version, EXACT, `expected an exact version, got "${version}"`);
});

test("root and claude-worker pin the SAME SDK version", () => {
  const root = sdkDep(join(here, "..", "package.json"));
  const worker = sdkDep(join(here, "package.json"));
  assert.equal(root, worker, "root and claude-worker must pin the same SDK version");
});

test("both lockfiles record the SDK spec exactly (no stale range)", () => {
  const manifest = sdkDep(join(here, "..", "package.json"));
  for (const lock of ["../package-lock.json", "package-lock.json"]) {
    const spec = lockfileRootSpec(join(here, lock));
    assert.ok(spec, `${lock} must record ${SDK}`);
    assert.match(spec, EXACT, `${lock} still records a range: "${spec}"`);
    assert.equal(spec, manifest, `${lock} spec must match the manifest pin`);
  }
});
