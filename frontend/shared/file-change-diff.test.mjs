// The key that decides whether two spellings of a path are the same file.
//
// Its one job is to be EQUIVALENT to the producer: the Claude worker writes the patch
// header with `patchHeaderPath` (claude-worker/file-diff.mjs), which is `path.relative`
// plus "keep it absolute when the file escapes the root". Anywhere the key's arithmetic
// diverges from `path.relative`'s, the same file keys twice and the transcript draws an
// empty card beside the real one — so these tests check the key against node's `path`
// directly rather than against hand-written expectations.
import test from "node:test";
import assert from "node:assert/strict";
import nodePath from "node:path";

import { fileChangePathKey, getFileChanges } from "./file-change-diff.js";

// What the worker would put in the patch header for this (root, file) pair.
function workerHeaderPath(root, filePath, platform = nodePath.posix) {
  if (!root || !platform.isAbsolute(filePath)) {
    return filePath;
  }
  const relative = platform.relative(root, filePath);
  if (!relative || relative.startsWith("..") || platform.isAbsolute(relative)) {
    return filePath;
  }
  return relative;
}

function toolFor(absolutePath, headerPath) {
  const diff = [
    `diff --git a/${headerPath} b/${headerPath}`,
    `--- a/${headerPath}`,
    `+++ b/${headerPath}`,
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  return {
    item_type: "fileChange",
    // The detail-fetch shape: the body lives on `tool.diff`, the change keeps the path.
    diff,
    file_changes: [{ path: absolutePath, change_type: "modify", diff: "" }],
  };
}

const POSIX_CASES = [
  { label: "plain path inside the root", root: "/repo", file: "/repo/a.js" },
  { label: "nested path inside the root", root: "/repo", file: "/repo/src/deep/a.js" },
  // path.relative resolves these; a raw prefix-slice does not.
  { label: "root is /", root: "/", file: "/a.js" },
  { label: "path with a .. segment", root: "/repo", file: "/repo/sub/../a.js" },
  { label: "path with a . segment", root: "/repo", file: "/repo/./a.js" },
  { label: "duplicate separators", root: "/repo", file: "/repo//src///a.js" },
  { label: "trailing separator on the root", root: "/repo/", file: "/repo/a.js" },
];

for (const { label, root, file } of POSIX_CASES) {
  test(`fileChangePathKey matches the worker's header path — ${label}`, () => {
    const header = workerHeaderPath(root, file);
    assert.equal(
      fileChangePathKey(file, root),
      fileChangePathKey(header, root),
      `${file} under ${root} must key the same as its patch header ${header}`
    );
  });
}

test("fileChangePathKey keys a file outside the root the same from both spellings", () => {
  // The worker leaves the header ABSOLUTE here (`../other/x.js` is not appliable), so both
  // sides arrive absolute and must still collapse to one file.
  const root = "/repo";
  const file = "/other/x.js";
  assert.equal(workerHeaderPath(root, file), file);
  assert.equal(fileChangePathKey(file, root), fileChangePathKey(file, root));
  assert.equal(fileChangePathKey(file, root), "/other/x.js");
});

test("fileChangePathKey keeps same-named files in different directories apart", () => {
  // The guard on the whole approach: without the root these are indistinguishable, and a
  // suffix match would merge them. `deep/x.js` and a root-level `x.js` are two files.
  assert.notEqual(fileChangePathKey("/repo/deep/x.js", "/repo"), fileChangePathKey("x.js", "/repo"));
});

test("fileChangePathKey stays case-sensitive for POSIX paths", () => {
  // path.posix.relative is case-sensitive, so `A.js` and `a.js` are two files.
  assert.notEqual(fileChangePathKey("/repo/A.js", "/repo"), fileChangePathKey("a.js", "/repo"));
});

test("fileChangePathKey compares Windows paths case-insensitively, like path.win32.relative", () => {
  const root = "C:\\Repo";
  const file = "c:\\repo\\A.js";
  assert.equal(workerHeaderPath(root, file, nodePath.win32), "A.js");
  assert.equal(fileChangePathKey(file, root), fileChangePathKey("A.js", root));
});

test("fileChangePathKey falls back to the path itself with no root", () => {
  assert.equal(fileChangePathKey("/repo/a.js", ""), "/repo/a.js");
  assert.equal(fileChangePathKey("a.js", ""), "a.js");
  assert.equal(fileChangePathKey("", "/repo"), "");
});

// The merge is the reason the key exists: one file, one change, body attached.
for (const { label, root, file } of POSIX_CASES) {
  test(`getFileChanges returns one change for one edited file — ${label}`, () => {
    const changes = getFileChanges(toolFor(file, workerHeaderPath(root, file)), {
      currentCwd: root,
    });
    assert.equal(changes.length, 1, `expected one change, got ${JSON.stringify(changes)}`);
    assert.match(changes[0].diff, /\+new/, "the merged change must carry the diff body");
  });
}

test("getFileChanges keeps two genuinely different files apart", () => {
  const diff = [
    "diff --git a/x.js b/x.js",
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  const changes = getFileChanges(
    {
      item_type: "turnDiff",
      diff,
      file_changes: [{ path: "/repo/deep/x.js", change_type: "modify", diff: "" }],
    },
    { currentCwd: "/repo" }
  );
  assert.equal(changes.length, 2);
});
