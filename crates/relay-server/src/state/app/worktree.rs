//! Task worktree provisioning.
//!
//! A Task team runs in its own `git worktree` so its writes can never collide
//! with the user's own session in the same repo (`has_working_thread_in_cwd`
//! keys on the exact cwd string, so a distinct tree is a distinct lock domain).
//!
//! This is the FIRST write-side git in the relay — everything else is
//! `rev-parse` / `diff` / `worktree list` plus `git apply`. Every argument here
//! is a literal or a validated ref; nothing is composed from user text without
//! passing `git check-ref-format`. There is no `-f` and no `branch -D` anywhere
//! in this module, by policy: the branch is the deliverable. The repository's own
//! hooks are suppressed (`core.hooksPath`) because `worktree add` checks out, and
//! `post-checkout` would otherwise run as the relay user.
//!
//! The `/.sealwire/` exclude written into the git COMMON dir does double duty: it
//! keeps the task worktrees out of the main tree's `git status`, AND — because a
//! common-dir exclude applies to every working tree — it keeps the TL's
//! plan/design/report out of the deliverable, since the MR gate commits with
//! `git add -A`.
//!
//! Layout: `<main worktree>/.sealwire/worktrees/<slug>` on branch `task/<slug>`.
//! Nesting inside the repo is deliberate — it makes the new path prefix-contained
//! by whatever `allowed_roots` entry already admitted the repo (so no root ever
//! has to be widened), and it lets `enclosing_repo_root` degrade a deleted
//! worktree to its repo instead of to nothing. See `markdown/task-team-design.md`
//! §4.

// Later bricks (the TeamRun driver and its HTTP surface) consume these; keep the
// provisioning layer ahead of its wiring without dead-code warnings, mirroring
// `state/workflow.rs` and `state/task_list.rs`.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use super::*;

/// Directory nested in the repo that holds this relay's task worktrees.
const SEALWIRE_DIR: &str = ".sealwire";
const WORKTREES_SUBDIR: &str = "worktrees";

/// Absolute override for where task worktrees are created. Escaping the repo is
/// allowed only insofar as the caller's path guard still admits the result.
const TASK_WORKTREE_ROOT_ENV: &str = "SEALWIRE_TASK_WORKTREE_ROOT";

/// `git -c` override that points hook lookup at a location that cannot hold any,
/// so a repository's own hooks never execute as the relay user.
///
/// Shared with the driver's commit path: `--no-verify` is NOT enough there, since
/// it skips only `pre-commit` and `commit-msg` while `prepare-commit-msg` and
/// `post-commit` still run.
pub(crate) const NO_HOOKS: &str = "core.hooksPath=/dev/null";

const TASK_BRANCH_PREFIX: &str = "task/";
const MAX_SLUG_BYTES: usize = 40;
/// Collision suffixes tried before giving up (`-2` … `-50`).
const MAX_SLUG_ATTEMPTS: u32 = 50;

/// A provisioned task worktree: a fresh checkout on a fresh branch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TaskWorktree {
    /// The worktree directory, already `normalize_cwd`-ed. This exact string is
    /// what every team thread is started with — `has_working_thread_in_cwd`
    /// compares cwds by string equality, so it must not be re-derived later.
    pub(crate) path: String,
    /// `task/<slug>`, validated by `git check-ref-format`.
    pub(crate) branch: String,
    /// The FULLY QUALIFIED ref the task forked from (`refs/heads/main`), and the
    /// MR view's diff base.
    ///
    /// Fully qualified is load-bearing, not tidiness: this value is persisted and
    /// later evaluated by `merge_base_with` *inside the task worktree*, where a
    /// relative expression means something else entirely. A stored `HEAD` would
    /// resolve to the task's own tip and silently hide every commit the team made
    /// from the MR diff.
    pub(crate) target_ref: String,
    /// The commit `target_ref` pointed at when the worktree was created.
    pub(crate) base_commit: String,
    /// The repo's main worktree — where branch/worktree commands must run.
    pub(crate) repo_main_worktree: String,
    /// Whether the source tree had uncommitted work when the task forked. Not a
    /// refusal: `worktree add` checks out the target cleanly and never touches
    /// the source index. It does mean that work is ABSENT here, which the TL
    /// intake prompt has to say out loud.
    pub(crate) source_dirty: bool,
}

/// Create a task worktree for `slug_seed`, branching from `target_branch`
/// (default: the main worktree's current branch).
///
/// `path_guard` is called with the final absolute path immediately before the
/// git command, and is where device/allowed-root scope is enforced. It is a
/// parameter rather than an internal check so this module never has to reach
/// into `RelayState`, while the security decision still happens inside the
/// provisioning boundary rather than being left to each caller to remember.
pub(crate) async fn provision_task_worktree(
    origin: &LiveWorkspace,
    slug_seed: &str,
    target_branch: Option<&str>,
    path_guard: &dyn Fn(&str) -> Result<(), String>,
) -> Result<TaskWorktree, String> {
    if !git_flag(origin, "--is-inside-work-tree").await {
        return Err(format!("{} is not a git repository", origin.as_str()));
    }
    if git_flag(origin, "--is-bare-repository").await {
        return Err(format!(
            "{} is a bare repository; a task needs a working tree",
            origin.as_str()
        ));
    }

    // Branch and worktree bookkeeping belong to the repository, so they must run
    // in the MAIN worktree even when the request arrived from a linked one.
    let main = repo_main_worktree(origin).await?;

    if !git_ok(&main, &["rev-parse", "--verify", "HEAD"]).await {
        return Err(format!(
            "{} has no commits yet; commit once before starting a task",
            main.as_str()
        ));
    }

    let target_ref =
        resolve_target_ref(&main, non_empty(target_branch.map(str::to_string))).await?;
    let target_commit_ref = format!("{target_ref}^{{commit}}");
    let base_commit = git_line(
        &main,
        &["rev-parse", "--verify", "--quiet", &target_commit_ref],
    )
    .await
    .ok_or_else(|| format!("cannot resolve branch {target_ref} in {}", main.as_str()))?;

    // Uncommitted work in the source tree is absent from the fresh checkout. That
    // is worth telling the TL about, but it is never a reason to refuse.
    let source_dirty = !git_line(&main, &["status", "--porcelain"])
        .await
        .unwrap_or_default()
        .is_empty();

    let base_dir = resolve_worktrees_base(
        main.as_str(),
        std::env::var(TASK_WORKTREE_ROOT_ENV).ok().as_deref(),
    );
    let (branch, planned) = choose_free_slot(&main, &base_dir, &task_slug(slug_seed)).await?;

    // The scope check runs on the final path and BEFORE any mutation, so a
    // refusal leaves the repository exactly as it was.
    path_guard(&planned)?;

    ensure_sealwire_excluded(&main).await;

    create_worktree(&main, &branch, &planned, &target_ref).await?;

    Ok(TaskWorktree {
        path: planned,
        branch,
        target_ref,
        base_commit,
        repo_main_worktree: main.as_str().to_string(),
        source_dirty,
    })
}

/// Remove a task worktree's directory, leaving its branch and commits alone.
///
/// Never `--force`: a dirty tree means unreviewed agent work, and silently
/// discarding it is worse than making the user look.
pub(crate) async fn remove_task_worktree(
    main: &LiveWorkspace,
    worktree_path: &str,
) -> Result<(), String> {
    let output = run_git_capture(main, &["worktree", "remove", worktree_path]).await?;
    if !output.status.success() {
        return Err(format!(
            "failed to remove task worktree {worktree_path}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    // Drop the now-stale administrative entry so the tree stops being listed.
    let _ = run_git_capture(main, &["worktree", "prune"]).await;
    Ok(())
}

/// Slugify a task title into a branch-safe segment.
///
/// Deliberately reductive: ASCII alphanumerics survive, everything else becomes a
/// separator. That drops every character git rejects (`..`, `@{`, `~`, `^`, `:`,
/// control bytes) and every character that would need quoting in a path, without
/// having to enumerate git's rules — which `git check-ref-format` then verifies
/// for real.
pub(crate) fn task_slug(seed: &str) -> String {
    let mut slug = String::new();
    let mut pending_separator = false;
    for ch in seed.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_separator && !slug.is_empty() {
                slug.push('-');
            }
            pending_separator = false;
            slug.push(ch.to_ascii_lowercase());
        } else {
            pending_separator = true;
        }
    }

    slug.truncate(MAX_SLUG_BYTES);
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        return "task".to_string();
    }
    slug
}

/// Where task worktrees live for a given main worktree, honoring an explicit
/// override. Split out from the env read so it can be tested without touching
/// process-global state.
fn resolve_worktrees_base(main_path: &str, override_root: Option<&str>) -> PathBuf {
    if let Some(root) = override_root.map(str::trim).filter(|root| !root.is_empty()) {
        return PathBuf::from(root);
    }
    Path::new(main_path)
        .join(SEALWIRE_DIR)
        .join(WORKTREES_SUBDIR)
}

/// Canonicalize the requested fork point to a fully qualified BRANCH ref.
///
/// Refuses anything that is not a branch. Tags and revision expressions are not
/// stable things to fork from, and — more concretely — the result is persisted and
/// re-evaluated later inside the task worktree. `HEAD` is accepted but resolved
/// HERE, in the main worktree, precisely so it can never be re-interpreted there.
async fn resolve_target_ref(
    main: &LiveWorkspace,
    requested: Option<String>,
) -> Result<String, String> {
    let requested = requested.unwrap_or_else(|| "HEAD".to_string());
    // `--symbolic-full-name` prints nothing (and still exits 0) for a revision
    // expression like `HEAD~1`, so an empty answer is a rejection, not a success.
    let resolved = git_line(
        main,
        &[
            "rev-parse",
            "--symbolic-full-name",
            "--verify",
            "--quiet",
            &requested,
        ],
    )
    .await
    .filter(|name| !name.is_empty())
    .ok_or_else(|| {
        format!(
            "cannot resolve branch {requested} in {}; a task forks from a branch",
            main.as_str()
        )
    })?;

    if resolved.starts_with("refs/heads/") || resolved.starts_with("refs/remotes/") {
        return Ok(resolved);
    }
    Err(format!(
        "{requested} is not a branch (it resolves to {resolved}); a task must fork from a branch"
    ))
}

/// The repository's main worktree. `list_worktree_records` already handles both
/// porcelain encodings and marks the first record as main.
async fn repo_main_worktree(origin: &LiveWorkspace) -> Result<LiveWorkspace, String> {
    let record = list_worktree_records(origin)
        .await
        .into_iter()
        .find(|record| record.is_main && !record.bare && !record.prunable)
        .ok_or_else(|| {
            format!(
                "could not locate the main worktree of the repository containing {}",
                origin.as_str()
            )
        })?;
    LiveWorkspace::from_path(&record.path).ok_or_else(|| {
        format!(
            "the repository's main worktree {} no longer exists",
            record.path
        )
    })
}

/// Find a slug whose branch and directory are both free.
///
/// An existing `task/<slug>` is never reused: it would put this team's commits on
/// top of work someone else owns.
async fn choose_free_slot(
    main: &LiveWorkspace,
    base_dir: &Path,
    base_slug: &str,
) -> Result<(String, String), String> {
    for attempt in 1..=MAX_SLUG_ATTEMPTS {
        let slug = if attempt == 1 {
            base_slug.to_string()
        } else {
            format!("{base_slug}-{attempt}")
        };
        let branch = format!("{TASK_BRANCH_PREFIX}{slug}");

        if !git_ok(main, &["check-ref-format", "--branch", &branch]).await {
            return Err(format!("{branch} is not a valid git branch name"));
        }
        let existing_ref = format!("refs/heads/{branch}");
        if git_ok(main, &["rev-parse", "--verify", "--quiet", &existing_ref]).await {
            continue;
        }

        let path = base_dir.join(&slug);
        if path.exists() {
            continue;
        }
        return Ok((branch, normalize_cwd(&path.to_string_lossy())));
    }
    Err(format!(
        "could not find a free task branch after {MAX_SLUG_ATTEMPTS} attempts starting from {TASK_BRANCH_PREFIX}{base_slug}"
    ))
}

/// `git worktree add`, with the three flags that matter.
///
/// `-b` is not optional: the target branch is normally already checked out in the
/// main worktree, and `worktree add <dir> <target>` refuses that outright.
/// Branching AT the target sidesteps it. `--no-track` leaves the branch with no
/// upstream — nothing in this feature ever pushes.
///
/// `core.hooksPath` is aimed at a location that cannot contain hooks because
/// `worktree add` CHECKS THE NEW TREE OUT, which fires the repository's
/// `post-checkout` hook. That hook would run as the RELAY user, before any agent
/// exists and outside whatever sandbox the agents get — the same arbitrary-code
/// surface `--no-verify` closes on the commit side. Suppressing it does not
/// affect the checkout itself.
async fn create_worktree(
    main: &LiveWorkspace,
    branch: &str,
    path: &str,
    target: &str,
) -> Result<(), String> {
    let output = run_git_capture(
        main,
        &[
            "-c",
            NO_HOOKS,
            "worktree",
            "add",
            "--no-track",
            "-b",
            branch,
            path,
            target,
        ],
    )
    .await?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if stderr.contains("no-track") {
        // Ancient git: the flag is the only thing it objected to.
        let retry = run_git_capture(
            main,
            &[
                "-c", NO_HOOKS, "worktree", "add", "-b", branch, path, target,
            ],
        )
        .await?;
        if retry.status.success() {
            return Ok(());
        }
        return Err(format!(
            "failed to create task worktree at {path}: {}",
            String::from_utf8_lossy(&retry.stderr).trim()
        ));
    }
    Err(format!(
        "failed to create task worktree at {path}: {}",
        stderr.trim()
    ))
}

/// Keep the nested worktree directory out of the main tree's `git status`.
///
/// Best-effort: failing to write an exclude is a cosmetic problem, not a reason to
/// refuse a task. `--git-common-dir` rather than `--git-dir` is load-bearing — in
/// a linked worktree the latter points at `.git/worktrees/<name>`, whose
/// `info/exclude` git never reads.
async fn ensure_sealwire_excluded(main: &LiveWorkspace) {
    let Some(common) = git_line(main, &["rev-parse", "--git-common-dir"]).await else {
        return;
    };
    if common.is_empty() {
        return;
    }
    let common_dir = if Path::new(&common).is_absolute() {
        PathBuf::from(&common)
    } else {
        Path::new(main.as_str()).join(&common)
    };

    let info_dir = common_dir.join("info");
    let exclude_path = info_dir.join("exclude");
    let entry = format!("/{SEALWIRE_DIR}/");

    // Read-then-write is the dangerous shape here, in two independent ways, and
    // both are closed below rather than mitigated:
    //
    //  - Following a symlink would let a pre-planted `info/exclude` redirect this
    //    write anywhere the relay user can reach. `symlink_metadata` + a regular-
    //    file requirement is the same hardening `persistence.rs` applies to the
    //    state file.
    //  - Degrading a failed read to an empty buffer would TRUNCATE whatever we
    //    could not read. An exclude file is not required to be UTF-8, so this
    //    works in raw bytes and refuses to write at all when the read fails.
    // The parent matters as much as the leaf: a symlinked `info` directory
    // redirects `info/exclude` just as effectively, and `create_dir_all` would
    // happily follow it.
    match tokio::fs::symlink_metadata(&info_dir).await {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => return,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return,
    }

    let existing: Vec<u8> = match tokio::fs::symlink_metadata(&exclude_path).await {
        Ok(metadata) if metadata.file_type().is_file() => {
            match tokio::fs::read(&exclude_path).await {
                Ok(bytes) => bytes,
                Err(_) => return,
            }
        }
        // A symlink, directory, or device is not ours to rewrite.
        Ok(_) => return,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(_) => return,
    };

    if existing
        .split(|byte| *byte == b'\n')
        .any(|line| trim_ascii(line) == entry.as_bytes())
    {
        return;
    }

    if tokio::fs::create_dir_all(&info_dir).await.is_err() {
        return;
    }
    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with(b"\n") {
        updated.push(b'\n');
    }
    updated.extend_from_slice(entry.as_bytes());
    updated.push(b'\n');
    // Residual race: the path could be swapped between the check and this write.
    // It stays best-effort because the alternative (O_NOFOLLOW + rename dance) is
    // a lot of machinery for a cosmetic `git status` nicety, and the check already
    // removes the pre-planted case this is actually exposed to.
    let _ = tokio::fs::write(&exclude_path, updated).await;
}

/// ASCII-trim a raw line. Hand-rolled rather than `[u8]::trim_ascii` to avoid
/// depending on a newer toolchain than the rest of the workspace needs.
fn trim_ascii(line: &[u8]) -> &[u8] {
    let start = line
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(line.len());
    let end = line
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map_or(start, |index| index + 1);
    &line[start..end]
}

/// Whether a `git rev-parse --is-*` predicate answered `true`.
async fn git_flag(workspace: &LiveWorkspace, flag: &str) -> bool {
    git_line(workspace, &["rev-parse", flag])
        .await
        .is_some_and(|value| value == "true")
}

/// Whether a git command exited zero. Used for existence probes, where the exit
/// code IS the answer and the output is noise.
async fn git_ok(workspace: &LiveWorkspace, args: &[&str]) -> bool {
    run_git_capture(workspace, args)
        .await
        .is_ok_and(|output| output.status.success())
}

/// A git command's trimmed stdout, or `None` when it failed.
async fn git_line(workspace: &LiveWorkspace, args: &[&str]) -> Option<String> {
    let output = run_git_capture(workspace, args).await.ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use tokio::process::Command;

    async fn run_in(dir: &Path, args: &[&str]) -> std::process::Output {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .await
            .expect("git should run");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }

    /// A repo with one commit on `main`. The path is canonicalized because git
    /// reports resolved paths (macOS `/var` -> `/private/var`) and half these
    /// assertions compare against what git prints.
    async fn init_repo() -> (TempDir, String) {
        let dir = TempDir::new().expect("tmpdir");
        let path = dir.path().canonicalize().expect("canonicalize");
        run_in(&path, &["init", "-q", "-b", "main"]).await;
        run_in(&path, &["config", "user.email", "test@example.com"]).await;
        run_in(&path, &["config", "user.name", "Test"]).await;
        std::fs::write(path.join("seed.txt"), "line1\n").unwrap();
        run_in(&path, &["add", "seed.txt"]).await;
        run_in(&path, &["commit", "-q", "-m", "seed"]).await;
        let display = path.to_string_lossy().into_owned();
        (dir, display)
    }

    fn workspace(path: &str) -> LiveWorkspace {
        LiveWorkspace::from_path(path).expect("workspace should exist")
    }

    fn allow_all() -> impl Fn(&str) -> Result<(), String> {
        |_: &str| Ok(())
    }

    #[tokio::test]
    async fn provisioning_creates_a_task_branch_worktree_under_the_main_worktree() {
        let (_repo, root) = init_repo().await;
        let main = workspace(&root);

        let created = provision_task_worktree(&main, "Add Dark Mode!", None, &allow_all())
            .await
            .expect("provisioning should succeed");

        assert_eq!(created.branch, "task/add-dark-mode");
        assert_eq!(created.target_ref, "refs/heads/main");
        assert_eq!(created.repo_main_worktree, root);
        assert!(!created.source_dirty, "the seeded repo is clean");

        let expected = Path::new(&root)
            .join(SEALWIRE_DIR)
            .join(WORKTREES_SUBDIR)
            .join("add-dark-mode");
        assert_eq!(
            created.path,
            expected.to_string_lossy(),
            "worktree must land under the main worktree's .sealwire dir"
        );
        assert!(Path::new(&created.path).is_dir(), "directory should exist");
        assert!(
            Path::new(&created.path).join("seed.txt").is_file(),
            "the target branch's content should be checked out"
        );

        // git itself must know about it, or `list_worktrees` can't show it and
        // `registering_repo_main_worktree` can't recover it later.
        let listed = run_in(Path::new(&root), &["worktree", "list", "--porcelain"]).await;
        let listed = String::from_utf8_lossy(&listed.stdout).into_owned();
        assert!(
            listed.contains(&created.path),
            "git worktree list should include {}, got:\n{listed}",
            created.path
        );

        // The source tree is untouched: still on its own branch, still clean.
        let head = run_in(Path::new(&root), &["symbolic-ref", "--short", "HEAD"]).await;
        assert_eq!(
            String::from_utf8_lossy(&head.stdout).trim(),
            "main",
            "provisioning must not move the source worktree's HEAD"
        );
    }

    #[tokio::test]
    async fn provisioning_branches_from_the_target_without_checking_it_out_twice() {
        let (_repo, root) = init_repo().await;
        let main = workspace(&root);

        // `main` is checked out in the source worktree. `git worktree add <dir> main`
        // would fail with "already checked out"; the `-b` form must sidestep that.
        let created = provision_task_worktree(&main, "hotfix", Some("main"), &allow_all())
            .await
            .expect("branching from a checked-out target must work");

        assert_eq!(created.branch, "task/hotfix");
        assert_eq!(created.target_ref, "refs/heads/main");

        let base = run_in(Path::new(&root), &["rev-parse", "main"]).await;
        assert_eq!(
            created.base_commit,
            String::from_utf8_lossy(&base.stdout).trim(),
            "base_commit must be the target's tip at fork time"
        );
    }

    #[tokio::test]
    async fn provisioning_suffixes_the_slug_when_the_branch_already_exists() {
        let (_repo, root) = init_repo().await;
        let main = workspace(&root);

        let first = provision_task_worktree(&main, "same name", None, &allow_all())
            .await
            .expect("first provisioning");
        let second = provision_task_worktree(&main, "same name", None, &allow_all())
            .await
            .expect("second provisioning should pick a fresh slug, not reuse the branch");

        assert_eq!(first.branch, "task/same-name");
        assert_eq!(
            second.branch, "task/same-name-2",
            "an existing branch must never be reused — it would put team commits on someone else's work"
        );
        assert_ne!(first.path, second.path);
        assert!(Path::new(&first.path).is_dir());
        assert!(Path::new(&second.path).is_dir());
    }

    #[tokio::test]
    async fn provisioning_refuses_a_directory_that_is_not_a_git_repository() {
        let dir = TempDir::new().expect("tmpdir");
        let path = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let plain = workspace(&path);

        let error = provision_task_worktree(&plain, "anything", None, &allow_all())
            .await
            .expect_err("a non-repo must be refused");
        assert!(
            error.contains("not a git repository"),
            "error should name the cause, got: {error}"
        );
    }

    #[tokio::test]
    async fn provisioning_refuses_a_repository_with_no_commits() {
        let dir = TempDir::new().expect("tmpdir");
        let path = dir.path().canonicalize().unwrap();
        run_in(&path, &["init", "-q", "-b", "main"]).await;
        let empty = workspace(&path.to_string_lossy());

        let error = provision_task_worktree(&empty, "anything", None, &allow_all())
            .await
            .expect_err("a repo with no commits has nothing to branch from");
        assert!(
            error.contains("no commits"),
            "error should name the cause, got: {error}"
        );
    }

    #[tokio::test]
    async fn provisioning_refuses_an_unknown_target_branch() {
        let (_repo, root) = init_repo().await;
        let main = workspace(&root);

        let error = provision_task_worktree(&main, "x", Some("no-such-branch"), &allow_all())
            .await
            .expect_err("an unresolvable target must be refused, not silently defaulted");
        assert!(
            error.contains("no-such-branch"),
            "error should name the missing ref, got: {error}"
        );
    }

    #[tokio::test]
    async fn provisioning_refuses_when_the_path_guard_rejects_the_planned_path() {
        let (_repo, root) = init_repo().await;
        let main = workspace(&root);

        let guard = |_: &str| Err("outside this device's scope".to_string());
        let error = provision_task_worktree(&main, "scoped", None, &guard)
            .await
            .expect_err("the guard must be able to refuse");
        assert!(
            error.contains("outside this device's scope"),
            "got: {error}"
        );

        // And nothing may have been created before the refusal.
        let branches = run_in(Path::new(&root), &["branch", "--list"]).await;
        let branches = String::from_utf8_lossy(&branches.stdout).into_owned();
        assert!(
            !branches.contains("task/scoped"),
            "the guard must run BEFORE any git mutation, got branches:\n{branches}"
        );
        assert!(
            !Path::new(&root).join(SEALWIRE_DIR).exists(),
            "no directory should be created when the guard refuses"
        );
    }

    #[tokio::test]
    async fn provisioning_records_a_dirty_source_tree_without_refusing() {
        let (_repo, root) = init_repo().await;
        std::fs::write(Path::new(&root).join("seed.txt"), "dirty\n").unwrap();
        let main = workspace(&root);

        let created = provision_task_worktree(&main, "dirty source", None, &allow_all())
            .await
            .expect("a dirty source tree is not a refusal");

        assert!(
            created.source_dirty,
            "the run must be able to tell the TL that uncommitted work was left behind"
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&created.path).join("seed.txt")).unwrap(),
            "line1\n",
            "the new worktree checks out the target, not the source's uncommitted edit"
        );
    }

    #[tokio::test]
    async fn provisioning_from_a_linked_worktree_still_lands_under_the_main_worktree() {
        let (_repo, root) = init_repo().await;
        // Inside its own TempDir, never a sibling of the repo: `<repo>/..` is the
        // shared system temp dir, so a leaked directory there collides with every
        // later run of this test.
        let elsewhere = TempDir::new().expect("tmpdir");
        let linked = elsewhere.path().canonicalize().unwrap().join("linked-wt");
        run_in(
            Path::new(&root),
            &[
                "worktree",
                "add",
                "-q",
                "--no-track",
                "-b",
                "side",
                linked.to_str().unwrap(),
                "main",
            ],
        )
        .await;
        let linked = linked.canonicalize().expect("linked worktree exists");
        let from_linked = workspace(&linked.to_string_lossy());

        let created = provision_task_worktree(&from_linked, "from linked", None, &allow_all())
            .await
            .expect("provisioning from a linked worktree should work");

        assert_eq!(
            created.repo_main_worktree, root,
            "worktree/branch commands must run in the MAIN worktree"
        );
        assert!(
            created.path.starts_with(&root),
            "the task worktree belongs under the main worktree, got {}",
            created.path
        );
    }

    #[tokio::test]
    async fn provisioning_excludes_the_sealwire_directory_from_the_repo() {
        let (_repo, root) = init_repo().await;
        let main = workspace(&root);

        provision_task_worktree(&main, "excluded", None, &allow_all())
            .await
            .expect("provisioning");

        // Nesting the worktree in the repo would otherwise leave it untracked and
        // pollute `git status` for anyone working in the main tree.
        let status = run_in(Path::new(&root), &["status", "--porcelain"]).await;
        let status = String::from_utf8_lossy(&status.stdout).into_owned();
        assert!(
            !status.contains(SEALWIRE_DIR),
            "the task worktree dir must be excluded, got status:\n{status}"
        );
    }

    #[tokio::test]
    async fn the_teams_own_scaffolding_stays_out_of_the_deliverable_commits() {
        // The exclude lives in the git COMMON dir, so `/.sealwire/` applies inside
        // the task worktree too. That is what keeps the TL's plan/design/report
        // out of the branch the user is asked to merge — the MR gate commits with
        // `git add -A`, which would otherwise sweep all of it in.
        let (_repo, root) = init_repo().await;
        let main = workspace(&root);
        let created = provision_task_worktree(&main, "scaffolding", None, &allow_all())
            .await
            .expect("provisioning");
        let worktree = Path::new(&created.path);

        std::fs::create_dir_all(worktree.join(SEALWIRE_DIR)).unwrap();
        std::fs::write(worktree.join(SEALWIRE_DIR).join("PLAN.md"), "# plan\n").unwrap();
        std::fs::write(worktree.join("feature.rs"), "real code\n").unwrap();

        run_in(worktree, &["add", "-A"]).await;
        run_in(worktree, &["commit", "-q", "-m", "team work"]).await;

        let listed = run_in(worktree, &["show", "--name-only", "--format=", "HEAD"]).await;
        let listed = String::from_utf8_lossy(&listed.stdout).into_owned();
        assert!(
            listed.contains("feature.rs"),
            "the actual work must be committed, got:\n{listed}"
        );
        assert!(
            !listed.contains(SEALWIRE_DIR),
            "relay scaffolding must never land in the user's branch, got:\n{listed}"
        );
    }

    #[tokio::test]
    async fn removing_a_task_worktree_keeps_its_branch() {
        let (_repo, root) = init_repo().await;
        let main = workspace(&root);
        let created = provision_task_worktree(&main, "removable", None, &allow_all())
            .await
            .expect("provisioning");

        remove_task_worktree(&main, &created.path)
            .await
            .expect("a clean worktree should remove cleanly");

        assert!(
            !Path::new(&created.path).exists(),
            "directory should be gone"
        );
        let branches = run_in(Path::new(&root), &["branch", "--list"]).await;
        assert!(
            String::from_utf8_lossy(&branches.stdout).contains("task/removable"),
            "the branch is the deliverable and must survive worktree removal"
        );
    }

    #[tokio::test]
    async fn removing_a_dirty_task_worktree_refuses_rather_than_discarding_work() {
        let (_repo, root) = init_repo().await;
        let main = workspace(&root);
        let created = provision_task_worktree(&main, "dirty removal", None, &allow_all())
            .await
            .expect("provisioning");
        std::fs::write(Path::new(&created.path).join("seed.txt"), "agent work\n").unwrap();

        remove_task_worktree(&main, &created.path)
            .await
            .expect_err("unreviewed agent work must not be silently discarded");
        assert!(
            Path::new(&created.path).is_dir(),
            "the worktree should still be there after a refused removal"
        );
    }

    #[tokio::test]
    async fn provisioning_never_executes_repository_hooks() {
        // `git worktree add` invokes `post-checkout`. The repository's own hooks
        // would then run as the RELAY user, before any agent starts and outside
        // whatever sandbox the agents get — the same threat this module already
        // guards against with `--no-verify` on commit.
        let (_repo, root) = init_repo().await;
        let hooks = Path::new(&root).join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let sentinel = Path::new(&root).join("HOOK_RAN");
        let hook = hooks.join("post-checkout");
        std::fs::write(
            &hook,
            format!("#!/bin/sh\ntouch {}\n", sentinel.to_string_lossy()),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let main = workspace(&root);
        let created = provision_task_worktree(&main, "hooked", None, &allow_all())
            .await
            .expect("provisioning");

        assert!(
            !sentinel.exists(),
            "a repository hook must not run during provisioning"
        );
        assert!(
            Path::new(&created.path).join("seed.txt").is_file(),
            "suppressing hooks must not stop the worktree being populated"
        );
    }

    #[tokio::test]
    async fn exclusion_hygiene_refuses_to_follow_a_symlinked_exclude() {
        let (_repo, root) = init_repo().await;
        let outside = TempDir::new().expect("tmpdir");
        let victim = outside.path().canonicalize().unwrap().join("victim.txt");
        std::fs::write(&victim, "important\n").unwrap();

        let info = Path::new(&root).join(".git").join("info");
        std::fs::create_dir_all(&info).unwrap();
        // `git init` seeds a real exclude file; replace it with the hostile link.
        let _ = std::fs::remove_file(info.join("exclude"));
        std::os::unix::fs::symlink(&victim, info.join("exclude")).unwrap();

        let main = workspace(&root);
        provision_task_worktree(&main, "symlinked", None, &allow_all())
            .await
            .expect("a hostile exclude must not fail provisioning, only be left alone");

        assert_eq!(
            std::fs::read_to_string(&victim).unwrap(),
            "important\n",
            "a pre-planted symlink must not redirect this write outside the repo"
        );
    }

    #[tokio::test]
    async fn exclusion_hygiene_refuses_a_symlinked_info_directory() {
        // The parent redirects the write just as effectively as the leaf, and
        // `create_dir_all` would happily follow it.
        let (_repo, root) = init_repo().await;
        let outside = TempDir::new().expect("tmpdir");
        let victim_dir = outside.path().canonicalize().unwrap().join("victim");
        std::fs::create_dir_all(&victim_dir).unwrap();

        let git_dir = Path::new(&root).join(".git");
        let info = git_dir.join("info");
        let _ = std::fs::remove_dir_all(&info);
        std::os::unix::fs::symlink(&victim_dir, &info).unwrap();

        let main = workspace(&root);
        provision_task_worktree(&main, "symlinked-parent", None, &allow_all())
            .await
            .expect("a hostile info dir must not fail provisioning, only be left alone");

        assert!(
            !victim_dir.join("exclude").exists(),
            "a symlinked info directory must not redirect the write outside the repo"
        );
    }

    #[tokio::test]
    async fn exclusion_hygiene_never_truncates_an_unreadable_exclude() {
        // The dangerous shape is read-then-write where the read silently degrades
        // to empty: an exclude file is not required to be UTF-8, and answering an
        // unreadable file with an empty buffer would truncate it.
        let (_repo, root) = init_repo().await;
        let info = Path::new(&root).join(".git").join("info");
        std::fs::create_dir_all(&info).unwrap();
        let exclude = info.join("exclude");
        let original: Vec<u8> = vec![b'#', b' ', 0xff, 0xfe, b'\n', b'b', b'u', b'i', b'l', b'd'];
        std::fs::write(&exclude, &original).unwrap();

        let main = workspace(&root);
        provision_task_worktree(&main, "nonutf8", None, &allow_all())
            .await
            .expect("provisioning");

        let after = std::fs::read(&exclude).unwrap();
        assert!(
            after.starts_with(&original),
            "existing exclude bytes must be preserved verbatim, got {after:?}"
        );
        assert!(
            String::from_utf8_lossy(&after).contains("/.sealwire/"),
            "and the entry should still be appended"
        );
    }

    #[tokio::test]
    async fn provisioning_canonicalizes_the_target_to_a_branch_ref() {
        let (_repo, root) = init_repo().await;
        let main = workspace(&root);

        // `HEAD` is the dangerous one: it is persisted and later evaluated INSIDE
        // the task worktree, where it means the task's own tip — a merge base
        // against which hides every commit the team made.
        let created = provision_task_worktree(&main, "canonical", Some("HEAD"), &allow_all())
            .await
            .expect("HEAD resolves to a branch in the main worktree");
        assert_eq!(created.target_ref, "refs/heads/main");

        let named = provision_task_worktree(&main, "named", Some("main"), &allow_all())
            .await
            .expect("a plain branch name works");
        assert_eq!(named.target_ref, "refs/heads/main");
    }

    #[tokio::test]
    async fn provisioning_refuses_a_target_that_is_not_a_branch() {
        let (_repo, root) = init_repo().await;
        run_in(Path::new(&root), &["tag", "v1"]).await;
        let main = workspace(&root);

        for target in ["v1", "HEAD~0^{commit}"] {
            let error = provision_task_worktree(&main, "x", Some(target), &allow_all())
                .await
                .expect_err("only a branch is a stable thing to fork from");
            assert!(
                error.contains(target),
                "error should name the rejected target, got: {error}"
            );
        }
    }

    #[test]
    fn slugs_are_branch_safe() {
        assert_eq!(task_slug("Add Dark Mode!"), "add-dark-mode");
        assert_eq!(task_slug("  spaced   out  "), "spaced-out");
        assert_eq!(task_slug("UPPER_snake.case"), "upper-snake-case");
        assert_eq!(
            task_slug("重构解析器"),
            "task",
            "non-ASCII collapses to the fallback"
        );
        assert_eq!(task_slug(""), "task");
        assert_eq!(task_slug("---"), "task");
        assert_eq!(task_slug("a".repeat(200).as_str()).len(), MAX_SLUG_BYTES);
        // git refuses these outright; the slugger must never produce them.
        assert_eq!(task_slug("..").len(), 4, "`..` must not survive into a ref");
        assert!(!task_slug("feature.lock").ends_with(".lock"));
        assert!(!task_slug("at@{brace}").contains("@{"));
    }

    #[test]
    fn the_worktrees_base_defaults_into_the_repo_and_honors_an_override() {
        assert_eq!(
            resolve_worktrees_base("/repo", None),
            PathBuf::from("/repo")
                .join(SEALWIRE_DIR)
                .join(WORKTREES_SUBDIR)
        );
        assert_eq!(
            resolve_worktrees_base("/repo", Some("/elsewhere/trees")),
            PathBuf::from("/elsewhere/trees"),
            "an explicit override replaces the default entirely"
        );
        assert_eq!(
            resolve_worktrees_base("/repo", Some("   ")),
            PathBuf::from("/repo")
                .join(SEALWIRE_DIR)
                .join(WORKTREES_SUBDIR),
            "a blank override is treated as absent, matching the env conventions elsewhere"
        );
    }
}
