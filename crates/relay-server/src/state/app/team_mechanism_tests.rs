// Public task-team mechanism tests.
//
// These pin relay-owned behavior only: thread-id promotion, git safety,
// workspace/path isolation, public views, and lifecycle authorization. The
// workflow scenarios and prompt-shaped assertions live in the private crate.

async fn init_team_repo() -> (TempDir, String) {
    let dir = TempDir::new().expect("tmpdir");
    let path = dir.path().canonicalize().expect("canonicalize");
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "T"],
    ] {
        let out = tokio::process::Command::new("git")
            .args(&args)
            .current_dir(&path)
            .output()
            .await
            .expect("git");
        assert!(out.status.success(), "git {args:?} failed");
    }
    std::fs::write(path.join("seed.txt"), "line1\n").unwrap();
    for args in [vec!["add", "-A"], vec!["commit", "-q", "-m", "seed"]] {
        let out = tokio::process::Command::new("git")
            .args(&args)
            .current_dir(&path)
            .output()
            .await
            .expect("git");
        assert!(out.status.success(), "git {args:?} failed");
    }
    let display = path.to_string_lossy().into_owned();
    (dir, display)
}

fn team_input(cwd: &str) -> crate::state::app::team::TeamStartRequest {
    crate::state::app::team::TeamStartRequest {
        spec: crate::state::TaskSpec {
            title: "Add a parser".to_string(),
            context: "The loader needs one.".to_string(),
            acceptance_criteria: "Parses all three encodings.".to_string(),
            agreed_scope: "Parser only; no loader refactor.".to_string(),
            quality_rules: "No unwrap in library code.".to_string(),
        },
        origin_cwd: cwd.to_string(),
        target_branch: None,
        device_id: "device-1".to_string(),
        tl_model: String::new(),
        dev_model: String::new(),
        reviewer_model: String::new(),
        tl_effort: String::new(),
        dev_effort: String::new(),
        reviewer_effort: String::new(),
        dev_agents: None,
        tl_provider: "codex".to_string(),
        dev_provider: "codex".to_string(),
        reviewer_provider: "codex".to_string(),
    }
}

struct ReturningTeamDriver;
struct PanickingTeamDriver;
struct BlockingTeamDriver;

#[async_trait::async_trait]
impl relay_api::TeamDriver for ReturningTeamDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, _port: std::sync::Arc<dyn relay_api::TeamPort>, _run_id: String) {}
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for PanickingTeamDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, _port: std::sync::Arc<dyn relay_api::TeamPort>, _run_id: String) {
        panic!("intentional test-driver panic");
    }
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for BlockingTeamDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, port: std::sync::Arc<dyn relay_api::TeamPort>, run_id: String) {
        port.block_run(&run_id, "intentional test block".to_string())
            .await;
    }
}

async fn wait_for_team_status(
    app: &AppState,
    run_id: &str,
    expected: crate::state::TeamRunStatus,
) -> crate::state::TeamRun {
    for _ in 0..600 {
        if let Some(run) = app.relay.read().await.team_run(run_id).cloned() {
            if run.status == expected {
                return run;
            }
        }
        sleep(Duration::from_millis(5)).await;
    }
    panic!("task {run_id} never reached {expected:?}");
}

#[tokio::test]
async fn the_public_host_reconciles_a_private_driver_that_returns_without_settling() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let app = app.with_team_driver(std::sync::Arc::new(ReturningTeamDriver));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Interrupted).await;

    assert!(
        run.error.as_deref().unwrap_or_default().contains("driver"),
        "the public crash net should explain the reconciliation: {:?}",
        run.error
    );
    for _ in 0..200 {
        if let Some(ticket) = app.claim_team_drive(&run_id) {
            drop(ticket);
            return;
        }
        sleep(Duration::from_millis(5)).await;
    }
    panic!("the returned driver kept its public drive ticket");
}

#[tokio::test]
async fn the_public_host_reconciles_a_private_driver_that_panics() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let app = app.with_team_driver(std::sync::Arc::new(PanickingTeamDriver));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Interrupted).await;
    assert!(
        run.error.as_deref().unwrap_or_default().contains("driver"),
        "the host-owned Drop guard must reconcile an unwind: {:?}",
        run.error
    );
}

#[tokio::test]
async fn the_public_host_preserves_a_deliberately_blocked_driver_return() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let app = app.with_team_driver(std::sync::Arc::new(BlockingTeamDriver));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Blocked).await;
    sleep(Duration::from_millis(50)).await;
    let still_blocked = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert_eq!(still_blocked.status, crate::state::TeamRunStatus::Blocked);
    assert_eq!(still_blocked.error, run.error);
}

#[tokio::test]
async fn missing_workspace_is_not_flattened_into_an_absent_commit_or_merge_base() {
    let (_repo, root) = init_team_repo().await;
    let (app, _) = build_review_app(&root, &["codex"]).await;
    let app = app.with_team_driver(std::sync::Arc::new(ReturningTeamDriver));
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Interrupted).await;
    std::fs::remove_dir_all(&run.cwd).expect("remove temporary task worktree");

    for result in [
        relay_api::TeamPort::checkpoint_commit(&app, &run_id)
            .await
            .map(|_| ()),
        relay_api::TeamPort::merge_base(&app, &run_id, &run.target_ref)
            .await
            .map(|_| ()),
    ] {
        match result {
            Err(relay_api::TeamPortError::Blocked(message)) => {
                assert!(message.contains(&run.cwd), "{message}");
            }
            other => panic!("missing workspace must stay typed as Blocked, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn a_claude_style_pending_promotion_keeps_every_team_seat_addressable() {
    // The failure this pins: Claude mints a synthetic `claude-pending-*` id and
    // only swaps in the real session id once the first turn starts. Every team
    // seat is background-started, so any of them can be promoted mid-turn. A
    // driver still holding the pending id finds no runtime, reads that as "not
    // working", and treats a running turn as finished — losing that agent's
    // output entirely. No fake provider models this, so it has to be asserted
    // on the record directly.
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .complete_turns
        .store(false, Ordering::Relaxed);
    let run_id = app
        .start_team_run(team_input(&root))
        .await
        .expect("the team should start");

    // Put a pending id in every seat the driver can address.
    {
        let mut relay = app.relay.write().await;
        relay.update_team_run(&run_id, |run| {
            run.tl_thread_id = "claude-pending-1".to_string();
            run.run_owned_thread_ids = vec!["claude-pending-1".to_string()];
            run.sub_tasks = vec![crate::state::SubTask {
                id: "s1".to_string(),
                dev_thread_id: Some("claude-pending-1".to_string()),
                reviewer_thread_id: Some("claude-pending-1".to_string()),
                owned_thread_ids: vec!["claude-pending-1".to_string()],
                ..crate::state::SubTask::default()
            }];
        });
        relay.promote_background_thread("claude-pending-1", "sess-real");
    }

    let run = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert_eq!(
        run.tl_thread_id, "sess-real",
        "the TL seat must follow the promotion"
    );
    assert_eq!(
        run.thread_in_slot(crate::state::TeamThreadSlot::Tl)
            .as_deref(),
        Some("sess-real")
    );
    assert_eq!(
        run.thread_in_slot(crate::state::TeamThreadSlot::SubTaskDev(0))
            .as_deref(),
        Some("sess-real"),
    );
    assert_eq!(
        run.thread_in_slot(crate::state::TeamThreadSlot::SubTaskReviewer(0))
            .as_deref(),
        Some("sess-real"),
    );
    assert_eq!(
        run.thread_in_slot(crate::state::TeamThreadSlot::RunOwned(0))
            .as_deref(),
        Some("sess-real"),
        "design/MR reviewers live here and were previously unreachable",
    );
    assert!(
        !run.owned_thread_ids()
            .iter()
            .any(|id| id.starts_with("claude-pending-")),
        "no seat may still name a dead pending id: {:?}",
        run.owned_thread_ids()
    );
}

#[tokio::test]
async fn commit_failures_propagate_instead_of_being_swallowed() {
    // The shape being pinned: "nothing to commit" is success, but a git
    // failure must NOT be mistaken for it. Swallowing one means the MR gate
    // reviews an uncommitted tree, head_commit points at the old HEAD, and the
    // run reports Done with the work still sitting in the working tree.
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let workspace = TrustedWorkspace::granted_for_test(&root).expect("workspace");
    let path = std::path::Path::new(&root);

    assert_eq!(
        app.commit_worktree(&workspace, "noop").await,
        Ok(false),
        "a clean tree is a no-op, not a failure"
    );

    std::fs::write(path.join("work.txt"), "first\n").unwrap();
    assert_eq!(
        app.commit_worktree(&workspace, "work").await,
        Ok(true),
        "a real change commits"
    );

    // A locked index is the deterministic stand-in for any git failure: the
    // old code turned a non-zero exit here into "nothing staged" and carried on.
    std::fs::write(path.join(".git").join("index.lock"), "").unwrap();
    std::fs::write(path.join("work2.txt"), "second\n").unwrap();
    let error = app
        .commit_worktree(&workspace, "blocked")
        .await
        .expect_err("a git failure must surface");
    assert!(
        error.contains("git add") || error.contains("git commit"),
        "the error should name the failing command: {error}"
    );
    std::fs::remove_file(path.join(".git").join("index.lock")).unwrap();
}

#[tokio::test]
async fn committing_never_executes_repository_hooks() {
    // `--no-verify` is NOT enough: it skips `pre-commit` and `commit-msg`, but
    // `prepare-commit-msg` and `post-commit` still run, which would reopen the
    // arbitrary-code surface provisioning already closes.
    let (_repo, root) = init_team_repo().await;
    let path = std::path::Path::new(&root);
    let hooks = path.join(".git").join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    for name in ["post-commit", "prepare-commit-msg"] {
        let sentinel = path.join(format!("{name}-RAN"));
        let hook = hooks.join(name);
        std::fs::write(
            &hook,
            format!("#!/bin/sh\ntouch {}\n", sentinel.to_string_lossy()),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let workspace = TrustedWorkspace::granted_for_test(&root).expect("workspace");
    std::fs::write(path.join("work.txt"), "x\n").unwrap();
    assert_eq!(app.commit_worktree(&workspace, "work").await, Ok(true));

    for name in ["post-commit", "prepare-commit-msg"] {
        assert!(
            !path.join(format!("{name}-RAN")).exists(),
            "{name} must not run for an agent-authored commit"
        );
    }
}

#[tokio::test]
async fn a_task_cannot_fork_from_a_worktree_outside_the_allowed_roots() {
    // Guarding only the DESTINATION is not enough. Provisioning reads and
    // MUTATES the origin's repository — it writes info/exclude in the common
    // git dir and creates a branch there.
    //
    // The two checks only come apart when the destination is in scope while
    // the origin is not, which is exactly what a linked worktree outside the
    // allowed roots produces: the task worktree still lands under the MAIN
    // worktree (in scope), so a destination-only guard would wave it through.
    let (_repo, root) = init_team_repo().await;
    let outside = TempDir::new().expect("tmpdir");
    let linked = outside.path().canonicalize().unwrap().join("linked");
    let out = tokio::process::Command::new("git")
        .args([
            "worktree",
            "add",
            "-q",
            "--no-track",
            "-b",
            "side",
            linked.to_str().unwrap(),
            "main",
        ])
        .current_dir(&root)
        .output()
        .await
        .expect("git");
    assert!(out.status.success(), "worktree add failed");

    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    // Only the main repository is in scope; the linked worktree is not.
    app.relay.write().await.allowed_roots = vec![root.clone()];

    let mut input = team_input(&root);
    input.origin_cwd = linked.to_string_lossy().into_owned();
    let error = app
        .start_team_run(input)
        .await
        .expect_err("an out-of-scope origin must be refused even when the destination is fine");
    assert!(
        error.contains("allowed roots"),
        "the error should name the scope: {error}"
    );
    assert!(
        !std::path::Path::new(&root).join(".sealwire").exists(),
        "nothing may be created from a repository we refused to touch"
    );
}

#[tokio::test]
async fn an_enormous_change_set_is_bounded_and_says_what_it_dropped() {
    // Tracked output is capped globally, but each untracked file adds up to
    // 64 KiB and nothing bounds the file COUNT. One generated directory would
    // otherwise build a prompt big enough to exhaust the model's context.
    let (_repo, root) = init_team_repo().await;
    let (_app, _providers) = build_review_app(&root, &["codex"]).await;
    let path = std::path::Path::new(&root);
    let blob = "x".repeat(40 * 1024);
    for index in 0..40 {
        std::fs::write(path.join(format!("generated_{index}.txt")), &blob).unwrap();
    }

    let workspace = TrustedWorkspace::granted_for_test(&root).expect("workspace");
    let response = collect_workspace_diff_against(&workspace, None)
        .await
        .expect("diff");
    let rendered = crate::state::app::team::render_review_diff(&response);

    assert!(
        rendered.len() < 400 * 1024,
        "the rendered prompt must stay bounded, got {} bytes",
        rendered.len()
    );
    assert!(
        rendered.contains("omitted"),
        "a reviewer must be told it was not shown everything"
    );
    assert!(
        rendered.contains("unreviewed"),
        "and told what that means: {}",
        &rendered[rendered.len().saturating_sub(200)..]
    );
}

#[tokio::test]
async fn the_sub_task_view_names_its_developer_and_reviewer_threads() {
    // A team diagram whose Dev and Reviewer nodes open a transcript needs
    // those thread ids, and only the team lead's is on the run view. They are
    // identity rather than TL-authored instruction, so exposing them leaves
    // the "briefs are deliberately absent" decision intact.
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;

    let mut run = crate::state::TeamRun::new(
        "team-view-1".to_string(),
        crate::state::TaskSpec::default(),
        root.clone(),
        "device-1".to_string(),
    );
    run.tl_thread_id = "tl-1".to_string();
    run.sub_tasks = vec![
        crate::state::SubTask {
            id: "s1".to_string(),
            title: "Write the parser".to_string(),
            brief: "Never leaves the backend.".to_string(),
            dev_thread_id: Some("dev-1".to_string()),
            reviewer_thread_id: Some("rev-1".to_string()),
            ..Default::default()
        },
        // Not yet started: nobody is seated, and the view must say so rather
        // than inventing an id the UI would then try to open.
        crate::state::SubTask {
            id: "s2".to_string(),
            title: "Wire the loader".to_string(),
            ..Default::default()
        },
    ];
    app.relay.write().await.insert_team_run(run);

    let teams = app.teams().await;
    let view = teams
        .teams
        .iter()
        .find(|team| team.team_run_id == "team-view-1")
        .expect("the task should be listed");

    assert_eq!(
        view.sub_tasks[0].dev_thread_id.as_deref(),
        Some("dev-1"),
        "the Dev node has nothing to open without this"
    );
    assert_eq!(
        view.sub_tasks[0].reviewer_thread_id.as_deref(),
        Some("rev-1"),
        "nor does the Reviewer node"
    );
    assert_eq!(view.sub_tasks[1].dev_thread_id, None);
    assert_eq!(view.sub_tasks[1].reviewer_thread_id, None);
}

#[tokio::test]
async fn a_session_already_living_in_the_worktree_cannot_be_resumed_into_it() {
    // The outer guard only knows a thread's id, so a session the team does not
    // own — restored, or created before the task started — slipped through and
    // became the active thread inside a worktree three agents are editing.
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .complete_turns
        .store(false, Ordering::Relaxed);

    let outsider = start_parent(&app, &root, "codex").await;
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    let cwd = app
        .relay
        .read()
        .await
        .team_run(&run_id)
        .map(|run| run.cwd.clone())
        .expect("cwd");

    // Point the outsider at a subdirectory of the task worktree, the way a
    // restored session rooted there would look.
    let subdir = std::path::Path::new(&cwd).join("src");
    std::fs::create_dir_all(&subdir).expect("subdir");
    let subdir = subdir.to_string_lossy().into_owned();
    {
        let mut relay = app.relay.write().await;
        relay.ensure_runtime_for_thread(&outsider.id).current_cwd = subdir.clone();
        if let Some(thread) = relay.threads.iter_mut().find(|item| item.id == outsider.id) {
            thread.cwd = subdir.clone();
        }
    }
    // The guard reads the cwd the PROVIDER reports, which is the one the thread
    // will actually run in — so the double has to report it too, or the test
    // would be checking relay bookkeeping rather than where work lands.
    {
        let mut threads = providers.get("codex").unwrap().threads.lock().await;
        if let Some(thread) = threads.get_mut(&outsider.id) {
            thread.cwd = subdir.clone();
        }
    }

    let error = app
        .resume_session(ResumeSessionInput {
            device_id: Some("device-1".to_string()),
            thread_id: outsider.id.clone(),
            approval_policy: None,
            sandbox: None,
            effort: None,
            provider: None,
        })
        .await
        .expect_err("a session living in the task's worktree must not be resumed into it");
    assert!(error.contains("belongs to a running task"), "{error}");
}

/// Tasks run concurrently. Each still gets its own worktree and branch, which
/// is what kept them apart when only one could run.
#[tokio::test]
async fn a_second_task_starts_alongside_a_live_one_on_its_own_worktree() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .complete_turns
        .store(false, Ordering::Relaxed);

    let first = app
        .start_team_run(team_input(&root))
        .await
        .expect("the first task should start");
    let second = app
        .start_team_run(team_input(&root))
        .await
        .expect("a second task runs alongside the first");
    assert_ne!(first, second);

    let relay = app.relay.read().await;
    let first_run = relay.team_run(&first).expect("first").clone();
    let second_run = relay.team_run(&second).expect("second").clone();
    assert_ne!(
        first_run.cwd, second_run.cwd,
        "two live tasks sharing a worktree would write over each other"
    );
    assert_ne!(first_run.branch, second_run.branch);
}

#[tokio::test]
async fn whole_run_stops_refuse_a_device_outside_the_tasks_path_scope() {
    // Stops are authorized by the task's WORKTREE path scope, the same way
    // starting one is. A device that could never have started this task must
    // not be able to reach into its worktree and drain its turns.
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .complete_turns
        .store(false, Ordering::Relaxed);
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");

    let elsewhere = TempDir::new().expect("tmpdir");
    app.relay.write().await.allowed_roots = vec![elsewhere.path().to_string_lossy().into_owned()];

    for error in [
        app.pause_team_run(Some(run_id.clone()), Some("device-1".to_string()))
            .await
            .expect_err("pause must be authorized"),
        app.force_stop_team_run(Some(run_id.clone()), Some("device-1".to_string()))
            .await
            .expect_err("force stop must be authorized"),
        app.cancel_team_run(Some(run_id.clone()), Some("device-1".to_string()))
            .await
            .expect_err("cancel must be authorized"),
    ] {
        assert!(
            error.contains("allowed roots"),
            "the refusal should name the scope: {error}"
        );
    }

    let error = app
        .pause_team_run(Some(run_id.clone()), None)
        .await
        .expect_err("an unidentified caller cannot stop a task");
    assert!(error.contains("device_id"), "{error}");

    let run = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert!(
        !run.pause_requested && run.status != crate::state::TeamRunStatus::Blocked,
        "a refused stop must leave the run untouched: {:?}",
        run.status
    );
}

#[tokio::test]
async fn only_a_paused_task_can_be_resumed() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .complete_turns
        .store(false, Ordering::Relaxed);
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");

    for status in [
        crate::state::TeamRunStatus::Running,
        crate::state::TeamRunStatus::Blocked,
        crate::state::TeamRunStatus::Cancelled,
    ] {
        app.relay.write().await.update_team_run(&run_id, |run| {
            // Reach past the guards: this is about what Resume refuses, not
            // about how a run got there.
            run.status = status;
        });
        let error = app
            .resume_team_run(Some(run_id.clone()), Some("device-1".to_string()))
            .await
            .expect_err("only a paused task is resumable");
        assert!(
            error.contains("only a paused task can be resumed"),
            "{status:?}: {error}"
        );
        assert_eq!(
            app.relay
                .read()
                .await
                .team_run(&run_id)
                .map(|run| run.status),
            Some(status),
            "a refused resume must leave the status alone"
        );
    }
}

/// Drives exactly one Dev-seat turn, the way the private driver does, and records
/// the id it sent to plus the outcome it got back.
struct OneDevTurnDriver {
    observed: std::sync::Arc<Mutex<Option<(String, relay_api::team::TeamTurnOutcome)>>>,
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for OneDevTurnDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, port: std::sync::Arc<dyn relay_api::TeamPort>, run_id: String) {
        let thread = port
            .start_thread(&run_id, relay_api::team::TeamRole::Dev)
            .await
            .expect("dev seat thread");
        let slot = port.record_run_thread(&run_id, &thread).await;
        let outcome = port
            .turn(
                &run_id,
                slot,
                relay_api::team::TeamRole::Dev,
                "write the parser",
            )
            .await;
        *self.observed.lock().await = Some((thread, outcome));
        port.settle_run(
            &run_id,
            crate::state::TeamRunStatus::Failed,
            "test driver done",
        )
        .await;
    }
}

#[tokio::test]
async fn a_dev_seat_start_that_fails_after_promotion_stops_the_session_it_really_started() {
    // The worst instance of the deferred-start orphan, because a Dev seat is
    // WRITE-CAPABLE: `team_thread_settings` gives a non-reviewer Claude seat
    // ("bypass", default_sandbox) — full write access with no approval prompts.
    //
    // A clean seat is a `claude-pending-…` placeholder until its FIRST turn creates
    // the SDK session, and that promotion happens inside `start_turn`. On a start
    // that fails only AFTER the session was created, the id the driver sent to has
    // no runtime left — so `observe_turn_liveness` saw nothing, skipped the stop
    // entirely, and the run settled and released its cwd lock while a bypass-mode
    // agent kept editing the task worktree.
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex", "claude_code"]).await;
    let claude = providers.get("claude_code").unwrap().clone();
    claude.deferred_start.store(true, Ordering::Relaxed);
    claude
        .fail_turn_after_promotion
        .store(true, Ordering::Relaxed);
    let observed = std::sync::Arc::new(Mutex::new(None));
    let app = app.with_team_driver(std::sync::Arc::new(OneDevTurnDriver {
        observed: observed.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "claude_code".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Failed).await;

    let (sent_to, outcome) = observed
        .lock()
        .await
        .clone()
        .expect("the driver ran a dev turn");
    assert!(
        sent_to.starts_with("claude-pending-"),
        "the seat starts as a placeholder: {sent_to}"
    );
    assert!(
        matches!(outcome, relay_api::team::TeamTurnOutcome::Failed(_)),
        "the lost start response surfaces as a failed turn: {outcome:?}"
    );

    let promoted = {
        let relay = app.relay.read().await;
        relay
            .runtimes
            .keys()
            .find(|id| id.starts_with("claude_code-session-"))
            .cloned()
            .expect("the seat was promoted to a real session id")
    };
    let interrupts = claude.interrupts.lock().await.clone();
    assert!(
        interrupts.iter().any(|id| id == &promoted),
        "the write-capable session that actually started must be interrupted, not \
abandoned (interrupted: {interrupts:?})"
    );
    assert!(
        !app.relay
            .read()
            .await
            .runtime_for_thread(&promoted)
            .is_some_and(|runtime| runtime.is_working()),
        "no seat may still be writing the worktree once the run has settled"
    );
}

/// The root-cause regression this whole task exists to fix: a Dev turn that
/// STARTS, RUNS, and ends with a FAILED provider terminal must be reported
/// `Failed`, not `Silent`. The failure lands as a transcript `Error` entry,
/// never an `AgentText` one, so `latest_assistant_entry` cannot see it —
/// `team_turn` (state/app/team.rs) must instead read the bridge's own
/// `last_turn_failure` record (state/relay/runtime.rs), which claude.rs and
/// codex/rpc.rs write at the same point they already write that Error entry.
#[tokio::test]
async fn a_dev_turn_that_ends_failed_is_reported_failed_not_silent() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .fail_completed_turn_with
        .lock()
        .await
        .replace((
            "Usage limit reached".to_string(),
            Some("usage_limit".to_string()),
        ));
    let observed = std::sync::Arc::new(Mutex::new(None));
    let app = app.with_team_driver(std::sync::Arc::new(OneDevTurnDriver {
        observed: observed.clone(),
    }));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Failed).await;

    let (_sent_to, outcome) = observed
        .lock()
        .await
        .clone()
        .expect("the driver ran a dev turn");
    match outcome {
        relay_api::team::TeamTurnOutcome::Failed(reason) => {
            assert!(
                reason.contains("Usage limit reached"),
                "the failed turn's reason must say the limit was hit: {reason}"
            );
        }
        other => panic!(
            "a turn that started, ran, and ended with a FAILED terminal must not read as \
{other:?}"
        ),
    }
}

/// A run-owned thread — the design reviewer, the MR-gate reviewer, or the dev
/// that addresses MR findings — must bill under the seat it was started as.
#[tokio::test]
async fn a_run_owned_thread_attributes_to_the_seat_it_was_started_as() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app
        .start_team_run(team_input(&root))
        .await
        .expect("the team should start");

    {
        let mut relay = app.relay.write().await;
        relay.update_team_run(&run_id, |run| {
            run.record_run_thread("mr-reviewer-1");
            run.record_run_thread_role("mr-reviewer-1", relay_api::team::TeamRole::Reviewer);
        });
    }

    let relay = app.relay.read().await;
    let attribution = relay.thread_attribution("mr-reviewer-1");
    assert_eq!(
        attribution.team_run_id.as_deref(),
        Some(run_id.as_str()),
        "the run is known"
    );
    assert_eq!(
        attribution.role.as_deref(),
        Some("reviewer"),
        "a run-owned seat that billed under no role at all is spend nobody can \
trace: 38% of one real run landed in that bucket"
    );
}

/// A standalone review is reviewing too. Billing it under no role at all puts it
/// in the same bucket as an ordinary chat session, where nobody can find it.
#[tokio::test]
async fn a_standalone_reviewer_thread_bills_under_reviewer_with_no_run() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;

    {
        let mut relay = app.relay.write().await;
        relay.register_reviewer_thread("solo-reviewer-1".to_string(), "parent-1".to_string());
    }

    let relay = app.relay.read().await;
    let attribution = relay.thread_attribution("solo-reviewer-1");
    assert_eq!(
        attribution.role.as_deref(),
        Some("reviewer"),
        "a review outside a run is still a review"
    );
    assert_eq!(
        attribution.team_run_id, None,
        "and `team_run_id` is what tells it apart from a run's reviewer"
    );
}

/// `role` alone cannot tell the three review prompts apart — design review, the
/// per-sub-task review, and the MR gate all bill as `reviewer`. The run's phase
/// at the time the turn STARTED is what names the prompt, and it must be stamped
/// then: the TL seat is one long session that crosses every phase, so reading
/// the run's phase when the `done` event lands would label a digest turn with
/// whatever phase the driver had already advanced to.
#[tokio::test]
async fn a_team_turn_stamps_the_phase_it_ran_in_not_the_phase_it_ended_in() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app
        .start_team_run(team_input(&root))
        .await
        .expect("the team should start");

    {
        let mut relay = app.relay.write().await;
        relay.update_team_run(&run_id, |run| {
            run.phase = relay_api::team::TeamPhase::DesignReview;
            run.record_run_thread("design-reviewer-1");
            run.record_run_thread_role("design-reviewer-1", relay_api::team::TeamRole::Reviewer);
        });
        // What `team_turn` records before driving the seat.
        relay.note_team_turn_phase(
            "design-reviewer-1",
            relay_api::team::TeamPhase::DesignReview,
        );
        // The driver moves on while the reviewer's `done` is still in flight.
        relay.update_team_run(&run_id, |run| {
            run.phase = relay_api::team::TeamPhase::MrGate;
        });
    }

    let relay = app.relay.read().await;
    let attribution = relay.thread_attribution("design-reviewer-1");
    assert_eq!(attribution.role.as_deref(), Some("reviewer"));
    assert_eq!(
        attribution.phase.as_deref(),
        Some("design_review"),
        "the design reviewer's spend must not be filed under the MR gate: they \
are different prompts and the whole point is to price them apart"
    );
}
