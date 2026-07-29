import { test } from "node:test";
import assert from "node:assert/strict";

import { canApplyPatch } from "./file-change-actions.js";

// Undo/Reapply pipes the stored diff straight to `git apply`. Claude's worker writes
// ABSOLUTE paths into the patch header (`a//Users/...`), which git refuses as
// `invalid path` — so the control can never succeed on a Claude thread. Offering a
// button that is guaranteed to fail is worse than not offering it.


// Unknown/absent provider must not silently disable a working control; only the
// provider known to be broken is excluded.

// Lint-style guard against the drift that made this necessary: the two surfaces each
// computed `enableFileChangeActions` independently (local from view_only/review/workflow,
// remote from canWrite), so a rule added to one silently missed the other. Every site
// that decides this flag must go through the shared predicate.
// Lint-style guard: the Undo control renders from two places (the expanded turnDiff and
// the collapsed diff-group chip), and a rule added to one has already silently missed
// the other. Both must run the patch through canApplyPatch.
test("every render site of the Undo control checks the patch", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const source = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "transcript-react.js"),
    "utf8"
  );

  const sites = [...source.matchAll(/turnDiffUndoAction\(|const undoEntry\b/g)];
  assert.ok(sites.length >= 2, `expected both Undo render sites; found ${sites.length}`);

  const guarded = [...source.matchAll(/canApplyPatch\(/g)];
  assert.ok(
    guarded.length >= 2,
    `only ${guarded.length} site(s) check canApplyPatch — a patch git cannot apply ` +
      `would still offer Undo from the unguarded one`
  );
});

// Provider is the wrong question now that Claude emits repo-relative headers: new
// threads apply fine, only diffs stored BEFORE that fix carry an absolute header. So
// judge the patch itself, per entry, and old sessions degrade on their own.
test("a patch with a repo-relative header can be applied", () => {
  assert.equal(
    canApplyPatch({ diff: "diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n" }),
    true
  );
});

test("a patch with an absolute header cannot be applied", () => {
  assert.equal(
    canApplyPatch({
      diff: "diff --git a//Users/me/repo/app.js b//Users/me/repo/app.js\n",
    }),
    false,
    "git refuses an absolute path outright, so the control would always fail"
  );
});

test("an absolute header inside file_changes is caught too", () => {
  assert.equal(
    canApplyPatch({
      diff: null,
      file_changes: [{ path: "/Users/me/repo/app.js", diff: "--- a//Users/me/repo/app.js\n" }],
    }),
    false
  );
});

// EVERY snapshot drops diff bodies, not just large ones — so in the normal collapsed
// view there is no patch to inspect and the client must use the relay's verdict, which
// was computed while the diff was still present.
test("the relay's verdict wins over inspecting a stripped body", () => {
  assert.equal(
    canApplyPatch({ diff: null, file_changes: [], file_changes_omitted: true, can_apply: false }),
    false,
    "a stripped entry the relay judged unappliable must not offer Undo"
  );
  assert.equal(
    canApplyPatch({ diff: null, file_changes: [], file_changes_omitted: true, can_apply: true }),
    true
  );
});

// No verdict and nothing to inspect: the authoritative read/detail paths carry the real
// diff and are judged directly, so this is the genuinely-unknown case. Keep the control
// rather than removing it on no evidence — the relay still rejects a bad patch visibly.
test("no verdict and no body stays enabled rather than guessing", () => {
  assert.equal(canApplyPatch({ diff: null, file_changes: [] }), true);
  assert.equal(canApplyPatch(null), true);
});
