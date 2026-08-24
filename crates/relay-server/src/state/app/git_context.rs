//! Read-only git context for a CALLER-SUPPLIED workspace path — the first git probe
//! in the relay whose cwd comes from the request rather than from relay-owned state.

use super::worktree::{git_flag, git_line};
use super::*;

/// Fixed and content-free: the underlying scope error echoes the normalized path and
/// names the allowed roots, rebuilding the oracle the scope check exists to deny.
pub(crate) const WORKSPACE_GIT_CONTEXT_OUT_OF_SCOPE: &str =
    "that directory is outside the paths this relay will inspect";

impl AppState {
    /// Never errors for an in-scope path: not-a-repo, bare repo and missing directory
    /// all answer `is_repo: false`, so the response cannot be read as a probe either.
    pub async fn workspace_git_context(
        &self,
        device_id: Option<String>,
        cwd: String,
    ) -> Result<WorkspaceGitContextView, String> {
        // Normalize FIRST: checking one spelling and spawning in another is how a
        // scope check gets bypassed by a `..` segment or a symlinked prefix.
        let cwd = normalize_cwd(&cwd);
        if cwd.is_empty() {
            // Otherwise git runs in the relay process's own cwd and reports its
            // source checkout's branch.
            return Err("a workspace path is required".to_string());
        }

        {
            let relay = self.relay.read().await;
            let device_scope = device_id
                .as_deref()
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            ensure_path_within_device_scope(&cwd, &device_scope, &relay.allowed_roots)
                .map_err(|_| WORKSPACE_GIT_CONTEXT_OUT_OF_SCOPE.to_string())?;
        }

        // Only past this line may a subprocess exist: the git helpers take a
        // `LiveWorkspace`, and this is the one place that builds one from caller input.
        let Some(workspace) = LiveWorkspace::from_path(&cwd) else {
            return Ok(WorkspaceGitContextView {
                cwd,
                ..WorkspaceGitContextView::default()
            });
        };
        Ok(collect_git_context(cwd, &workspace).await)
    }
}

/// Three cheap git commands: runs on every picker move and every workspace resolve.
pub(super) async fn collect_git_context(
    cwd: String,
    workspace: &LiveWorkspace,
) -> WorkspaceGitContextView {
    let mut view = WorkspaceGitContextView {
        cwd,
        ..WorkspaceGitContextView::default()
    };

    // Also answers false for a bare repo and for a path inside `.git`, both of which
    // have no working tree to describe.
    if !git_flag(workspace, "--is-inside-work-tree").await {
        return view;
    }
    view.is_repo = true;

    match git_line(workspace, &["rev-parse", "--abbrev-ref", "HEAD"]).await {
        // git refuses to let a branch BE named `HEAD`, so this reading is unambiguous.
        Some(head) if head == "HEAD" => view.detached = true,
        Some(head) if !head.is_empty() => {
            // Stripped anyway, so this agrees with `parse_worktree_records`.
            view.branch = Some(
                head.strip_prefix("refs/heads/")
                    .unwrap_or(&head)
                    .to_string(),
            );
        }
        // Fails on a repo with no commits: not detached, just nothing to name.
        _ => {}
    }

    view.dirty = has_uncommitted_changes(workspace).await.unwrap_or(false);
    view
}

/// Reads at most ONE BYTE of `git status`: the question is a boolean but the output is
/// O(changes), and `--porcelain` runs to megabytes on a tree full of build artifacts.
async fn has_uncommitted_changes(workspace: &LiveWorkspace) -> Option<bool> {
    use tokio::io::AsyncReadExt;

    let mut child = Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=normal"])
        .current_dir(workspace.as_str())
        .stdout(Stdio::piped())
        // Null, not piped: nothing reads stderr here, and an unread pipe is a place for
        // git to block forever once it fills.
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        // The early return below abandons a still-running git; without this a dropped
        // future would leak the process rather than reap it.
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;

    let mut first = [0_u8; 1];
    if stdout.read(&mut first).await.ok()? > 0 {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Some(true);
    }

    // EOF having written nothing: clean — but only if git actually succeeded. Closing
    // the read end first so the child can never block on a write while we wait for it.
    drop(stdout);
    match child.wait().await {
        Ok(status) if status.success() => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn git(dir: &std::path::Path, args: &[&str]) {
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
    }

    /// A repo with one commit on `main`. Canonicalized because git reports resolved
    /// paths (macOS `/var` → `/private/var`) and so do the relay's scope checks.
    async fn init_repo(dir: &std::path::Path) -> String {
        let path = dir.canonicalize().expect("canonicalize");
        git(&path, &["init", "-q", "-b", "main"]).await;
        git(&path, &["config", "user.email", "test@example.com"]).await;
        git(&path, &["config", "user.name", "Test"]).await;
        std::fs::write(path.join("seed.txt"), "line1\n").expect("seed");
        git(&path, &["add", "seed.txt"]).await;
        git(&path, &["commit", "-q", "-m", "seed"]).await;
        path.to_string_lossy().to_string()
    }

    async fn build_app(cwd: &str, allowed_roots: Vec<String>) -> AppState {
        let (change_tx, _rx) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        if !allowed_roots.is_empty() {
            relay.write().await.allowed_roots =
                normalize_allowed_roots(allowed_roots).expect("allowed roots should normalize");
        }
        AppState::from_parts(relay, HashMap::new(), change_tx)
    }

    async fn pair_device(app: &AppState, device_id: &str, path_scope: Vec<String>) {
        let path_scope = normalize_allowed_roots(path_scope).expect("scope should normalize");
        app.relay.write().await.paired_devices.insert(
            device_id.to_string(),
            crate::state::relay::PairedDevice {
                device_id: device_id.to_string(),
                label: device_id.to_string(),
                payload_secret: "test-payload-secret".to_string(),
                device_verify_key: "test-verify-key".to_string(),
                created_at: 1,
                last_seen_at: Some(1),
                last_peer_id: Some("peer-test".to_string()),
                broker_join_ticket_expires_at: None,
                path_scope,
            },
        );
    }

    // Neutral everywhere else, so it cannot be mistaken for a clean unnamed branch.
    #[tokio::test]
    async fn a_non_repo_directory_reports_no_repo() {
        let dir = TempDir::new().expect("tmp");
        let cwd = dir.path().canonicalize().expect("canonicalize");
        let app = build_app(&cwd.to_string_lossy(), Vec::new()).await;

        let context = app
            .workspace_git_context(None, cwd.to_string_lossy().to_string())
            .await
            .expect("a plain directory is a legitimate answer, not an error");

        assert!(!context.is_repo);
        assert_eq!(context.branch, None);
        assert!(!context.detached);
        assert!(!context.dirty);
    }

    #[tokio::test]
    async fn a_clean_repo_reports_its_branch_and_no_changes() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        let app = build_app(&cwd, Vec::new()).await;

        let context = app
            .workspace_git_context(None, cwd.clone())
            .await
            .expect("context");

        assert!(context.is_repo);
        assert_eq!(context.branch.as_deref(), Some("main"));
        assert!(!context.detached);
        assert!(!context.dirty, "nothing has been touched yet");
    }

    // Stripped exactly the way `list_worktrees_in` strips it, or the chip and the
    // diff panel's root picker disagree about what this tree is called.
    #[tokio::test]
    async fn a_branch_name_is_reported_short_not_as_a_ref() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        git(
            std::path::Path::new(&cwd),
            &["checkout", "-q", "-b", "feat/alpha"],
        )
        .await;
        let app = build_app(&cwd, Vec::new()).await;

        let context = app
            .workspace_git_context(None, cwd.clone())
            .await
            .expect("context");

        assert_eq!(context.branch.as_deref(), Some("feat/alpha"));
    }

    #[tokio::test]
    async fn a_modified_tracked_file_makes_the_workspace_dirty() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        std::fs::write(
            std::path::Path::new(&cwd).join("seed.txt"),
            "line1\nline2\n",
        )
        .expect("write");
        let app = build_app(&cwd, Vec::new()).await;

        let context = app
            .workspace_git_context(None, cwd.clone())
            .await
            .expect("context");

        assert!(context.is_repo);
        assert_eq!(context.branch.as_deref(), Some("main"));
        assert!(context.dirty);
    }

    // Pins `--untracked-files=normal`: in git's `no` mode a tree of brand-new files
    // reads as clean.
    #[tokio::test]
    async fn an_untracked_file_makes_the_workspace_dirty() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        std::fs::write(std::path::Path::new(&cwd).join("brand-new.txt"), "hello\n").expect("write");
        let app = build_app(&cwd, Vec::new()).await;

        let context = app
            .workspace_git_context(None, cwd.clone())
            .await
            .expect("context");

        assert!(
            context.dirty,
            "an untracked file is a change the user must be told about"
        );
    }

    // `rev-parse --abbrev-ref HEAD` literally prints "HEAD" for a detached checkout.
    #[tokio::test]
    async fn a_detached_head_is_not_a_branch_named_head() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        git(std::path::Path::new(&cwd), &["checkout", "-q", "--detach"]).await;
        let app = build_app(&cwd, Vec::new()).await;

        let context = app
            .workspace_git_context(None, cwd.clone())
            .await
            .expect("context");

        assert!(context.is_repo);
        assert!(context.detached);
        assert_eq!(
            context.branch, None,
            "a detached HEAD has no branch; `HEAD` is not one"
        );
    }

    // A raw ENOENT reaching the UI is not an answer anyone can act on, and the
    // directory legitimately may not exist yet.
    #[tokio::test]
    async fn a_missing_directory_in_scope_reports_no_repo_rather_than_erroring() {
        let dir = TempDir::new().expect("tmp");
        let root = dir.path().canonicalize().expect("canonicalize");
        let missing = root.join("not-created-yet");
        let app = build_app(
            &root.to_string_lossy(),
            vec![root.to_string_lossy().to_string()],
        )
        .await;

        let context = app
            .workspace_git_context(None, missing.to_string_lossy().to_string())
            .await
            .expect("a missing directory must not become a raw git spawn error");

        assert!(!context.is_repo);
        assert_eq!(context.branch, None);
        assert!(!context.dirty);
    }

    // THE security test: the refusal must be identical whatever is at the path, or the
    // message itself becomes the oracle the scope check exists to deny.
    #[tokio::test]
    async fn an_out_of_scope_path_is_refused_without_revealing_what_is_there() {
        let allowed_dir = TempDir::new().expect("tmp");
        let outside_dir = TempDir::new().expect("tmp");
        let allowed = init_repo(allowed_dir.path()).await;
        let outside_root = outside_dir.path().canonicalize().expect("canonicalize");

        // Three very different things, all out of scope: a real (dirty) repo, a plain
        // directory, and a path that is not there at all.
        let secret_repo = outside_root.join("secret-repo");
        std::fs::create_dir_all(&secret_repo).expect("mkdir");
        let secret_repo = init_repo(&secret_repo).await;
        std::fs::write(
            std::path::Path::new(&secret_repo).join("seed.txt"),
            "line1\nSECRET\n",
        )
        .expect("write");
        let plain_dir = outside_root.join("plain");
        std::fs::create_dir_all(&plain_dir).expect("mkdir");
        let missing = outside_root.join("nothing-here");

        let app = build_app(&allowed, Vec::new()).await;
        pair_device(&app, "device-narrow", vec![allowed.clone()]).await;

        // In scope: still works, so the test cannot pass by refusing everything.
        app.workspace_git_context(Some("device-narrow".to_string()), allowed.clone())
            .await
            .expect("the device's own workspace must still answer");

        let mut refusals = Vec::new();
        for probe in [
            secret_repo.clone(),
            plain_dir.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
        ] {
            let error = app
                .workspace_git_context(Some("device-narrow".to_string()), probe.clone())
                .await
                .expect_err(&format!("{probe} is out of scope and must be refused"));
            assert!(
                !error.contains(&probe),
                "the refusal must not echo the probed path back: {error}"
            );
            assert!(
                !error.contains("secret-repo") && !error.contains("main"),
                "the refusal must not describe what is at the path: {error}"
            );
            refusals.push(error);
        }

        assert_eq!(
            refusals[0], refusals[1],
            "a repo and a plain directory must be indistinguishable when out of scope"
        );
        assert_eq!(
            refusals[1], refusals[2],
            "an existing and a missing path must be indistinguishable when out of scope"
        );
    }

    // Without this, `device_id: None` — every local HTTP call — would skip the check.
    #[tokio::test]
    async fn the_relay_allowed_roots_bind_a_caller_with_no_device_id() {
        let allowed_dir = TempDir::new().expect("tmp");
        let outside_dir = TempDir::new().expect("tmp");
        let allowed = init_repo(allowed_dir.path()).await;
        let outside = init_repo(outside_dir.path()).await;

        let app = build_app(&allowed, vec![allowed.clone()]).await;

        app.workspace_git_context(None, allowed.clone())
            .await
            .expect("a path inside the relay's roots must answer");
        app.workspace_git_context(None, outside)
            .await
            .expect_err("a path outside the relay's roots must be refused");
    }

    // Answering would probe the relay process's own cwd: wrong, and a disclosure.
    #[tokio::test]
    async fn an_empty_path_is_refused() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        let app = build_app(&cwd, Vec::new()).await;

        app.workspace_git_context(None, "   ".to_string())
            .await
            .expect_err("an empty path must be refused, not resolved against the relay's cwd");
    }
}
