import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSuggestionGroups,
  buildWorktreeGroups,
  looksLikePath,
  workspaceRootStatus,
  worktreeCountLabel,
} from "./shared/workspace-picker-model.js";

const ROOTS = [
  { path: "/git/agent-relay", branch: "main", is_main: true, changed_files: 0 },
  {
    path: "/git/agent-relay-askuser-detail",
    branch: "fix/ask-user-large-detail",
    is_main: false,
    changed_files: 2,
  },
  {
    path: "/git/agent-relay-instance-lock",
    branch: "feat/relay-instance-lock",
    is_main: false,
    changed_files: 0,
  },
];

test("a measured tree reports clean or a pluralized change count", () => {
  assert.deepEqual(workspaceRootStatus({ changed_files: 0 }), {
    tone: "clean",
    text: "clean",
  });
  assert.deepEqual(workspaceRootStatus({ changed_files: 1 }), {
    tone: "changes",
    text: "1 file changed",
  });
  assert.deepEqual(workspaceRootStatus({ changed_files: 5 }), {
    tone: "changes",
    text: "5 files changed",
  });
});

// The whole point of the field being optional: an unmeasured tree must not be
// advertised as clean, because "clean" is the answer that stops someone looking.
test("an unmeasured tree reports no status at all rather than clean", () => {
  assert.equal(workspaceRootStatus({}), null);
  assert.equal(workspaceRootStatus({ changed_files: null }), null);
  assert.equal(workspaceRootStatus({ changed_files: "3" }), null);
  assert.equal(workspaceRootStatus({ changed_files: -1 }), null);
});

test("a capped count says so instead of claiming an exact number", () => {
  assert.deepEqual(workspaceRootStatus({ changed_files: 999, changed_files_capped: true }), {
    tone: "changes",
    text: "999+ files changed",
  });
  // Plural even at one, because "1+ file changed" would misread as exactly one.
  assert.deepEqual(workspaceRootStatus({ changed_files: 1, changed_files_capped: true }), {
    tone: "changes",
    text: "1+ files changed",
  });
});

test("worktree counts pluralize", () => {
  assert.equal(worktreeCountLabel(1), "1 worktree");
  assert.equal(worktreeCountLabel(9), "9 worktrees");
  assert.equal(worktreeCountLabel(0), "0 worktrees");
});

test("roots group under the repo named by the main worktree's directory", () => {
  const { groups, total } = buildWorktreeGroups({ roots: ROOTS });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].repo, "agent-relay");
  assert.equal(groups[0].countLabel, "3 worktrees");
  assert.equal(total, 3);
});

// git lists the main worktree first and linked ones in registration order. Sorting by
// branch or dirtiness would move rows under the cursor exactly when someone clicks.
test("row order follows the relay's order untouched", () => {
  const { groups } = buildWorktreeGroups({ roots: ROOTS });
  assert.deepEqual(
    groups[0].rows.map((row) => row.branch),
    ["main", "fix/ask-user-large-detail", "feat/relay-instance-lock"]
  );
});

test("a row carries branch, directory name, main flag and status", () => {
  const { groups } = buildWorktreeGroups({ roots: ROOTS });
  const [main, detail] = groups[0].rows;
  assert.equal(main.branch, "main");
  assert.equal(main.dirName, "agent-relay");
  assert.equal(main.isMain, true);
  assert.deepEqual(main.status, { tone: "clean", text: "clean" });
  assert.equal(detail.isMain, false);
  assert.deepEqual(detail.status, { tone: "changes", text: "2 files changed" });
});

test("a detached worktree still gets a primary line", () => {
  const { groups } = buildWorktreeGroups({
    roots: [{ path: "/git/repo", branch: null, is_main: true }],
  });
  assert.equal(groups[0].rows[0].branch, "detached");
  assert.equal(groups[0].rows[0].detached, true);
});

test("the selected tree and the session's own tree are marked independently", () => {
  const { groups } = buildWorktreeGroups({
    roots: ROOTS,
    selectedPath: "/git/agent-relay-askuser-detail",
    sessionPath: "/git/agent-relay",
  });
  const rows = groups[0].rows;
  assert.deepEqual(
    rows.map((row) => [row.isSelected, row.isSession]),
    [
      [false, true],
      [true, false],
      [false, false],
    ]
  );
});

test("filtering matches branch, directory name and repo, case-insensitively", () => {
  const byBranch = buildWorktreeGroups({ roots: ROOTS, query: "ASK-USER" });
  assert.equal(byBranch.matched, 1);
  assert.equal(byBranch.groups[0].rows[0].branch, "fix/ask-user-large-detail");

  const byDir = buildWorktreeGroups({ roots: ROOTS, query: "instance-lock" });
  assert.equal(byDir.matched, 1);

  const byRepo = buildWorktreeGroups({ roots: ROOTS, query: "agent-relay" });
  assert.equal(byRepo.matched, 3, "the repo name is shared by every row");
});

// A header reading "3 worktrees" above one visible row reads as a rendering bug.
test("a filtered group header counts what survived the filter", () => {
  const { groups, total, matched } = buildWorktreeGroups({
    roots: ROOTS,
    query: "ask-user",
  });
  assert.equal(groups[0].countLabel, "1 worktree");
  assert.equal(total, 3, "total still reports the unfiltered size");
  assert.equal(matched, 1);
});

test("a filter matching nothing yields no groups rather than an empty one", () => {
  const { groups, matched } = buildWorktreeGroups({ roots: ROOTS, query: "zzz" });
  assert.deepEqual(groups, []);
  assert.equal(matched, 0);
});

test("malformed roots are dropped instead of rendering blank rows", () => {
  const { groups, total } = buildWorktreeGroups({
    roots: [null, { branch: "x" }, { path: "", branch: "y" }, ROOTS[0]],
  });
  assert.equal(total, 1);
  assert.equal(groups[0].rows[0].branch, "main");
});

test("no roots yields no groups", () => {
  const { groups, total, matched } = buildWorktreeGroups({ roots: [] });
  assert.deepEqual(groups, []);
  assert.equal(total, 0);
  assert.equal(matched, 0);
});

test("the main worktree is badged as the repo's checkout", () => {
  const { groups } = buildWorktreeGroups({ roots: ROOTS });
  assert.deepEqual(groups[0].rows[0].badges, ["checkout"]);
  assert.deepEqual(groups[0].rows[1].badges, []);
});

// The "Follow session" button was removed; this badge is the only remaining way to
// find the row that puts the panel back to following the session.
test("the session's own tree is badged so it stays findable", () => {
  const { groups } = buildWorktreeGroups({
    roots: ROOTS,
    sessionPath: "/git/agent-relay-askuser-detail",
  });
  assert.deepEqual(groups[0].rows[1].badges, ["session"]);
  // A session sitting on main carries both facts, and neither may displace the other.
  const onMain = buildWorktreeGroups({ roots: ROOTS, sessionPath: "/git/agent-relay" });
  assert.deepEqual(onMain.groups[0].rows[0].badges, ["checkout", "session"]);
});

// --- the dialogs' plain path list ------------------------------------------------

const SUGGESTIONS = [
  { cwd: "/Users/dev/git/project", label: "Current session" },
  { cwd: "/tmp/scratch", label: "Allowed root" },
];

test("path suggestions render through the same row shape as worktrees", () => {
  const { groups, total } = buildSuggestionGroups({ suggestions: SUGGESTIONS });
  assert.equal(total, 2);
  const [first] = groups[0].rows;
  assert.equal(first.primary, "~/git/project", "home-abbreviated for width");
  assert.equal(first.secondary, "Current session");
  assert.equal(first.status, null);
  assert.deepEqual(first.badges, []);
});

// `normalize_cwd` works on real paths; the tilde is display only.
test("a suggestion commits its raw path, not the abbreviated one", () => {
  const { groups } = buildSuggestionGroups({ suggestions: SUGGESTIONS });
  assert.equal(groups[0].rows[0].path, "/Users/dev/git/project");
});

// "repository" is not a thing arbitrary directories have in common.
test("the suggestion list has no group header", () => {
  const { groups } = buildSuggestionGroups({ suggestions: SUGGESTIONS });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, null);
  assert.equal(groups[0].subtitle, null);
});

test("suggestions filter on both path and provenance label", () => {
  assert.equal(buildSuggestionGroups({ suggestions: SUGGESTIONS, query: "scratch" }).matched, 1);
  assert.equal(buildSuggestionGroups({ suggestions: SUGGESTIONS, query: "allowed" }).matched, 1);
  assert.equal(buildSuggestionGroups({ suggestions: SUGGESTIONS, query: "zz" }).matched, 0);
});

test("the selected suggestion is marked", () => {
  const { groups } = buildSuggestionGroups({
    suggestions: SUGGESTIONS,
    selectedPath: "/tmp/scratch",
  });
  assert.deepEqual(
    groups[0].rows.map((row) => row.isSelected),
    [false, true]
  );
});

// The one input both filters and accepts a brand-new path. A leading `/` or `~` is
// what tells the two apart — an e2e harness and the launch dialogs depend on it.
test("only path-shaped text is treated as a path to commit", () => {
  assert.equal(looksLikePath("/tmp/brand-new"), true);
  assert.equal(looksLikePath("~/git/thing"), true);
  assert.equal(looksLikePath("  /tmp/padded  "), true);
  assert.equal(looksLikePath("askuser"), false);
  assert.equal(looksLikePath("fix/ask-user-large-detail"), false, "a branch name is a filter");
  assert.equal(looksLikePath(""), false);
  assert.equal(looksLikePath(null), false);
});

// `normalize_cwd` absolutizes these and the old picker took any non-empty text, so
// `./repo` used to work. Losing it would silently turn Enter into a no-op.
test("relative paths are committable, not filters", () => {
  assert.equal(looksLikePath("./repo"), true);
  assert.equal(looksLikePath("../repo"), true);
  assert.equal(looksLikePath("../../git/other"), true);
  assert.equal(looksLikePath("  ./repo  "), true);
});

// `.claude` and `..foo` name no directory — a leading dot is an ordinary way to start
// filtering for a dotfile folder, and treating it as a path would break that.
test("a dotted filter word is not a relative path", () => {
  assert.equal(looksLikePath(".claude"), false);
  assert.equal(looksLikePath("..foo"), false);
  assert.equal(looksLikePath(".hidden/thing"), false);
});

// `.` and `..` are exactly the directories they look like, the backend resolves both,
// and neither is a useful thing to filter by.
test("bare . and .. are paths", () => {
  assert.equal(looksLikePath("."), true);
  assert.equal(looksLikePath(".."), true);
  assert.equal(looksLikePath("  ..  "), true);
});
