import test from "node:test";
import assert from "node:assert/strict";

import {
  abbreviateHomePath,
  gitContextLabel,
  workspaceOriginNote,
  workspaceRootLabel,
} from "./workspace-chip-model.js";

// What the chip READS; the submitted value is never touched.

test("a home-relative path collapses to a tilde", () => {
  assert.equal(abbreviateHomePath("/Users/luchi/git/agent-relay"), "~/git/agent-relay");
  assert.equal(abbreviateHomePath("/home/luchi/git/agent-relay"), "~/git/agent-relay");
});

test("the home directory itself is just a tilde", () => {
  assert.equal(abbreviateHomePath("/Users/luchi"), "~");
  assert.equal(abbreviateHomePath("/Users/luchi/"), "~");
});

test("paths outside a home directory are left alone", () => {
  assert.equal(abbreviateHomePath("/var/tmp/build"), "/var/tmp/build");
  assert.equal(abbreviateHomePath("/Users"), "/Users");
});

test("a path that merely starts with the word Users is not mistaken for a home", () => {
  // A sloppy startsWith turns this into "~omething/x" — wrong, and plausible.
  assert.equal(abbreviateHomePath("/Usersomething/x"), "/Usersomething/x");
});

test("a non-string is passed through as an empty string rather than crashing the chip", () => {
  assert.equal(abbreviateHomePath(null), "");
  assert.equal(abbreviateHomePath(undefined), "");
});

test("a clean repo reads as branch plus clean", () => {
  assert.equal(
    gitContextLabel({ is_repo: true, branch: "main", dirty: false }),
    "main · clean"
  );
});

test("a dirty repo says so", () => {
  assert.equal(
    gitContextLabel({ is_repo: true, branch: "main", dirty: true }),
    "main · changes"
  );
});

test("a detached head is named as such, never as a branch called HEAD", () => {
  assert.equal(
    gitContextLabel({ is_repo: true, branch: null, detached: true, dirty: false }),
    "detached · clean"
  );
});

test("a repo with no branch and no detached flag shows only its state", () => {
  // A freshly `git init`ed repo with no commits: rev-parse cannot name a branch.
  assert.equal(gitContextLabel({ is_repo: true, branch: null, dirty: false }), "clean");
});

test("a directory that is not a repo has no chip at all", () => {
  // Rendering "not a repo" would be noise on the majority of the dialog's life,
  // and the chip's whole job is to warn.
  assert.equal(gitContextLabel({ is_repo: false }), null);
  assert.equal(gitContextLabel(null), null);
});

// Distinct origin kinds: rendering them the same is how a substitute is read as the session's own.

const RESOLVED = {
  cwd: "/repo/wt",
  origin: { kind: "proven" },
  roots: [],
  birth_cwd: "/repo/main",
  birth_cwd_exists: true,
};

test("the ordinary case — the session's own tree, still there — says nothing", () => {
  assert.equal(workspaceOriginNote({ ...RESOLVED, origin: { kind: "birth" } }), null);
  assert.equal(workspaceOriginNote(null), null);
});

test("a pin reads as the user's own choice, and an inference does not", () => {
  const pinned = workspaceOriginNote({ ...RESOLVED, origin: { kind: "pinned" } });
  assert.equal(pinned.tone, "info");
  assert.match(pinned.text, /Pinned by you/);

  const proven = workspaceOriginNote(RESOLVED);
  assert.equal(proven.tone, "info");
  assert.match(proven.text, /Detected/);
  assert.doesNotMatch(proven.text, /Pinned/, "an inference must not claim the user chose it");
});

test("a substituted tree warns, and names both the one that vanished and the one shown", () => {
  const note = workspaceOriginNote({
    ...RESOLVED,
    cwd: "/Users/x/repo",
    origin: { kind: "substituted", gone: "/Users/x/repo/.claude/worktrees/wt-gone" },
  });
  assert.equal(note.tone, "warn");
  assert.match(note.text, /wt-gone/);
  assert.match(note.text, /no longer exists/);
  assert.match(note.text, /showing repo instead/);
});

// fallback_from on the diff must warn even before the resolved workspace lands.
test("a fallback_from off the diff warns even with no resolved workspace", () => {
  const note = workspaceOriginNote(null, "/Users/x/repo/.claude/worktrees/wt-gone");
  assert.equal(note.tone, "warn");
  assert.match(note.text, /wt-gone no longer exists/);
});

// Birth can vanish while pin/writes still point somewhere real — not `substituted`.
test("a vanished birth directory is reported even when the resolved tree is fine", () => {
  const note = workspaceOriginNote({
    ...RESOLVED,
    origin: { kind: "pinned" },
    birth_cwd: "/Users/x/repo/.claude/worktrees/wt-gone",
    birth_cwd_exists: false,
  });
  assert.equal(note.tone, "warn");
  assert.match(note.text, /started in/);
  assert.match(note.text, /~\/repo\/\.claude\/worktrees\/wt-gone/);
});

test("root labels lead with the branch and mark the linked worktrees", () => {
  assert.equal(
    workspaceRootLabel({ path: "/repo", branch: "main", is_main: true }),
    "main · repo"
  );
  assert.equal(
    workspaceRootLabel({ path: "/repo/wt", branch: "feature", is_main: false }),
    "feature · wt (worktree)"
  );
  // A detached checkout must never render as a branch called HEAD.
  assert.equal(
    workspaceRootLabel({ path: "/repo/wt", branch: null, is_main: false }),
    "detached · wt (worktree)"
  );
});
