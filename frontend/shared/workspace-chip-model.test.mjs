import test from "node:test";
import assert from "node:assert/strict";

import { abbreviateHomePath, gitContextLabel } from "./workspace-chip-model.js";

// Display-only transforms for the workspace chip. Everything here is about what
// the chip READS; the value the dialog submits is never touched, because a path
// the relay has to resolve must stay exactly what the user chose.

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
  // `/Usersomething/...` shares a prefix with `/Users/` but is not one. A sloppy
  // startsWith would turn it into "~omething/x" — wrong, and wrong in a way that
  // looks like a real path.
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
