import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Reviewing a thread or opening Changes runs git in the workspace, and the relay
// refuses to do that until the repository has been GRANTED. Starting an agent in a
// directory is a deliberate local action but not permission for ambient git probes,
// so a fixture that skips the grant does not get an error at the call site — the
// review job lands in `failed` ("is not a granted workspace, so it cannot be diffed")
// and `/api/workspace/diff` answers `unavailable: true`.
//
// Both are TERMINAL, so the symptom is always some downstream assertion timing out on
// a state that will never arrive, pointing nowhere near the missing grant. Three
// separate specs were bitten by this before it was worth a test:
//
//   review-recap-modes-e2e.mjs  exercised the trust refusal instead of the recap modes
//   cwd-drift-e2e.mjs           "Changes must open on the worktree; got " (empty)
//   browser-local-search-filter-e2e.mjs
//                               "the reviewed parent never showed a Reviewing dot"
//
// The grant is one line. Finding out it was missing costs an afternoon.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const NEEDS_TRUST = ["/api/session/review", "/api/workspace/diff"];
const GRANTS_TRUST = "/api/workspace/trust";

function e2eScripts() {
  return readdirSync(join(repoRoot, "scripts"))
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
    .map((name) => ({ name, source: readFileSync(join(repoRoot, "scripts", name), "utf8") }));
}

test("an e2e that reviews or diffs a workspace grants trust to it first", () => {
  const offenders = e2eScripts()
    .filter(({ source }) => NEEDS_TRUST.some((route) => source.includes(route)))
    .filter(({ source }) => !source.includes(GRANTS_TRUST))
    .map(({ name }) => name);

  assert.deepEqual(
    offenders,
    [],
    "these fixtures review or diff a workspace without granting it first, so the work "
      + `lands in a terminal failure and the spec fails somewhere else entirely:\n  ${offenders.join("\n  ")}\n`
      + `Add \`${GRANTS_TRUST}\` for the workspace before the review/diff, the way `
      + "review-recap-modes-e2e.mjs does."
  );
});
