import { test } from "node:test";
import assert from "node:assert/strict";

import { canApplyFileChanges } from "./file-change-actions.js";

// Undo/Reapply pipes the stored diff straight to `git apply`. Claude's worker writes
// ABSOLUTE paths into the patch header (`a//Users/...`), which git refuses as
// `invalid path` — so the control can never succeed on a Claude thread. Offering a
// button that is guaranteed to fail is worse than not offering it.
test("Claude threads cannot apply file changes", () => {
  assert.equal(canApplyFileChanges({ provider: "claude_code" }), false);
});

test("Codex threads can apply file changes", () => {
  assert.equal(canApplyFileChanges({ provider: "codex" }), true);
});

// Unknown/absent provider must not silently disable a working control; only the
// provider known to be broken is excluded.
test("an unknown or missing provider stays enabled", () => {
  assert.equal(canApplyFileChanges({ provider: "" }), true);
  assert.equal(canApplyFileChanges({}), true);
  assert.equal(canApplyFileChanges(null), true);
});

// Lint-style guard against the drift that made this necessary: the two surfaces each
// computed `enableFileChangeActions` independently (local from view_only/review/workflow,
// remote from canWrite), so a rule added to one silently missed the other. Every site
// that decides this flag must go through the shared predicate.
test("every surface that enables file-change actions consults the shared predicate", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));

  const sites = [
    join(here, "../local/render-session.js"),
    join(here, "../remote/react-app.js"),
  ];

  for (const site of sites) {
    const source = await readFile(site, "utf8");
    if (!source.includes("enableFileChangeActions")) {
      throw new Error(
        `${site} no longer sets enableFileChangeActions — update this guard to match ` +
          `wherever that decision moved, rather than deleting it.`
      );
    }
    // Check the ASSIGNMENT, not the file: the import alone would satisfy a whole-file
    // substring match even after the call site drops the guard.
    const at = source.indexOf("enableFileChangeActions");
    const assignment = source.slice(at, at + 400);
    assert.ok(
      assignment.includes("canApplyFileChanges"),
      `${site} decides enableFileChangeActions without canApplyFileChanges, so a ` +
        `provider whose diffs cannot be applied would still render Undo/Reapply there`
    );
  }
});
