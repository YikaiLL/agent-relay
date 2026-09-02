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
        starting_proposal_id: None,
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
    // Deliberately UNCLASSIFIED (`kind: None`): this test is only about the
    // Silent-vs-Failed classification a plain provider failure gets, decoupled
    // from the halt-the-run behavior a `usage_limit` kind now also triggers
    // (see `a_dev_turn_that_hits_a_usage_limit_halts_the_run_before_any_review`
    // in this same file) — conflating the two would make this assert on
    // whichever one happened to change most recently.
    providers
        .get("codex")
        .unwrap()
        .fail_completed_turn_with
        .lock()
        .await
        .replace(("the provider had an internal error".to_string(), None));
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
                reason.contains("the provider had an internal error"),
                "the failed turn's reason must say why: {reason}"
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

/// The role map is keyed BY the thread id, so a promotion that skipped it
/// strands the role on a dead thread and the live seat bills under none.
#[tokio::test]
async fn a_promoted_run_owned_seat_keeps_the_role_it_was_started_as() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app
        .start_team_run(team_input(&root))
        .await
        .expect("the team should start");

    {
        let mut relay = app.relay.write().await;
        relay.update_team_run(&run_id, |run| {
            run.record_run_thread("claude-pending-mr-dev");
            run.record_run_thread_role("claude-pending-mr-dev", relay_api::team::TeamRole::Dev);
        });
        relay.promote_background_thread("claude-pending-mr-dev", "sess-mr-dev");
    }

    let relay = app.relay.read().await;
    let run = relay.team_run(&run_id).cloned().expect("the run is live");
    assert!(
        run.run_owned_thread_ids
            .iter()
            .any(|id| id == "sess-mr-dev"),
        "the id itself has always followed the promotion"
    );
    assert_eq!(
        run.run_owned_thread_roles
            .get("sess-mr-dev")
            .map(String::as_str),
        Some("dev"),
        "the role is keyed by thread id, so it has to be re-keyed with it"
    );
    assert!(
        !run.run_owned_thread_roles
            .contains_key("claude-pending-mr-dev"),
        "the dead id must not linger as a second entry"
    );
    assert_eq!(
        relay.thread_attribution("sess-mr-dev").role.as_deref(),
        Some("dev"),
        "spend after a promotion must still name the seat that made it"
    );
}

/// This seat WRITES, so a drain that missed it would leave files changing after
/// the run's locks were released.
#[tokio::test]
async fn the_mr_revision_dev_is_rekeyed_and_drained_like_every_other_seat() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app
        .start_team_run(team_input(&root))
        .await
        .expect("the team should start");

    {
        let mut relay = app.relay.write().await;
        relay.update_team_run(&run_id, |run| {
            run.mr_dev_thread_id = Some("claude-pending-mr".to_string());
        });
        relay.promote_background_thread("claude-pending-mr", "sess-mr");
    }

    let run = app
        .relay
        .read()
        .await
        .team_run(&run_id)
        .cloned()
        .expect("the run is live");
    assert_eq!(
        run.mr_dev_thread_id.as_deref(),
        Some("sess-mr"),
        "a seat still holding a promoted-away id reads as idle while it is working"
    );
    assert_eq!(
        run.thread_in_slot(crate::state::TeamThreadSlot::MrDev)
            .as_deref(),
        Some("sess-mr"),
        "the slot re-resolves rather than handing back what it captured"
    );
    assert!(
        run.owned_thread_ids().iter().any(|id| id == "sess-mr"),
        "the seat that writes must be in the set the drain walks"
    );
}

/// A replan supersedes only what never finished, so without the stamp a
/// reopened run's old and new implementers are indistinguishable.
#[test]
fn a_replan_stamps_the_cycle_that_planned_each_sub_task() {
    let mut run = crate::state::TeamRun::new(
        "run-1".to_string(),
        Default::default(),
        "/tmp/wt".to_string(),
        "device-1".to_string(),
    );
    run.replan_sub_tasks(vec![crate::state::SubTask {
        id: "a".to_string(),
        title: "first".to_string(),
        ..Default::default()
    }]);
    run.sub_tasks[0].status = crate::state::SubTaskStatus::Done;
    run.sub_tasks[0].dev_thread_id = Some("dev-old".to_string());

    run.reopened_count = 1;
    run.replan_sub_tasks(vec![crate::state::SubTask {
        id: "b".to_string(),
        title: "second".to_string(),
        ..Default::default()
    }]);

    assert_eq!(
        run.sub_tasks.len(),
        2,
        "a finished sub-task survives the replan that follows a reopen"
    );
    assert_eq!(run.sub_tasks[0].cycle, 0);
    assert_eq!(
        run.sub_tasks[1].cycle, 1,
        "the new plan belongs to the cycle that asked for it"
    );
}

/// The driver names the session it wants; only the relay can say whether it is
/// still reachable.
#[tokio::test]
async fn a_recorded_seat_is_reused_when_reachable_and_replaced_when_not() {
    use relay_api::TeamPort as _;

    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app
        .start_team_run(team_input(&root))
        .await
        .expect("the team should start");

    let started = app
        .resume_or_start_thread(&run_id, relay_api::team::TeamRole::Dev, &[])
        .await
        .expect("a seat starts when nothing is offered");

    assert_eq!(
        app.resume_or_start_thread(&run_id, relay_api::team::TeamRole::Dev, &[started.clone()])
            .await
            .expect("the offered seat is still reachable"),
        started,
        "a routable session must be handed straight back, not duplicated"
    );

    assert_eq!(
        app.resume_or_start_thread(
            &run_id,
            relay_api::team::TeamRole::Dev,
            &["sess-that-never-existed".to_string(), started.clone()]
        )
        .await
        .expect("the list is walked in order"),
        started,
        "a dead first choice must fall through to a live second, not past it"
    );

    let replaced = app
        .resume_or_start_thread(
            &run_id,
            relay_api::team::TeamRole::Dev,
            &["sess-that-never-existed".to_string()],
        )
        .await
        .expect("an unroutable seat is replaced rather than fatal");
    assert_ne!(
        replaced, "sess-that-never-existed",
        "a session the relay cannot route to must not be sent a turn"
    );
    assert_ne!(replaced, started, "and it must be a genuinely new seat");
}

/// The thread cache outlives the session behind it: archive one and the route
/// still resolves, so a route-only check returns a seat whose turn will fail.
#[tokio::test]
async fn a_seat_whose_session_is_gone_is_not_reused_just_because_it_still_routes() {
    use relay_api::TeamPort as _;

    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app
        .start_team_run(team_input(&root))
        .await
        .expect("the team should start");

    let seat = app
        .resume_or_start_thread(&run_id, relay_api::team::TeamRole::Dev, &[])
        .await
        .expect("a seat starts");

    // Take the session out from under it, leaving the relay's cache untouched.
    providers
        .get("codex")
        .unwrap()
        .archive_thread(&seat)
        .await
        .expect("the provider drops the session");

    assert!(
        app.find_thread_provider(&seat).await.is_ok(),
        "the route still resolves — which is exactly why it is not enough"
    );

    let replacement = app
        .resume_or_start_thread(&run_id, relay_api::team::TeamRole::Dev, &[seat.clone()])
        .await
        .expect("a seat is still produced");
    assert_ne!(
        replacement, seat,
        "the session is gone, so reusing it would fail the run on its first turn"
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

/// Drives one TL turn, but first loses the seat's runtime and moves the session
/// mirror to another chat's model — what a relay restart mid-run looks like.
struct RestartedTlTurnDriver {
    relay: std::sync::Arc<RwLock<RelayState>>,
    thread: std::sync::Arc<Mutex<Option<String>>>,
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for RestartedTlTurnDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, port: std::sync::Arc<dyn relay_api::TeamPort>, run_id: String) {
        let thread = port
            .start_thread(&run_id, relay_api::team::TeamRole::Tl)
            .await
            .expect("tl seat thread");
        let slot = port.record_run_thread(&run_id, &thread).await;
        {
            let mut relay = self.relay.write().await;
            // Runtimes are process-local; the remembered settings are persisted. So a
            // restart mid-run loses one and keeps the other.
            relay.runtimes.remove(&thread);
            // Meanwhile the user is chatting in another provider's session, which is
            // all `RelayState.model` ever holds: the last thing anyone used.
            relay.model = "cursor-auto".to_string();
            relay.reasoning_effort = "none".to_string();
            // Any background event for the seat rebuilds its runtime before the turn.
            relay.bg_set_thread_status(&thread, "idle".to_string(), Vec::new(), 0);
        }
        let _ = port
            .turn(
                &run_id,
                slot,
                relay_api::team::TeamRole::Tl,
                "plan the work",
            )
            .await;
        *self.thread.lock().await = Some(thread);
        port.settle_run(
            &run_id,
            crate::state::TeamRunStatus::Failed,
            "test driver done",
        )
        .await;
    }
}

#[tokio::test]
async fn a_tl_turn_after_a_lost_runtime_still_runs_on_the_seats_model() {
    // The seat is configured `opus[1m]` and every turn before the restart ran on it.
    // Then the rebuilt runtime took its model from the session mirror — the user's
    // Cursor chat — and the TL's next turn went out as a model Claude cannot resolve,
    // which reads as "There's an issue with the selected model" and fails the run.
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex", "claude_code"]).await;
    let claude = providers.get("claude_code").unwrap().clone();
    let observed = std::sync::Arc::new(Mutex::new(None));
    let relay = app.relay.clone();
    let app = app.with_team_driver(std::sync::Arc::new(RestartedTlTurnDriver {
        relay,
        thread: observed.clone(),
    }));

    let mut input = team_input(&root);
    input.tl_provider = "claude_code".to_string();
    input.tl_model = "opus[1m]".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Failed).await;

    let thread = observed
        .lock()
        .await
        .clone()
        .expect("the driver ran a tl turn");
    let turn_models = claude.turn_models.lock().await.clone();
    let sent = turn_models
        .iter()
        .filter(|(id, _, _)| id == &thread)
        .last()
        .map(|(_, model, _)| model.clone())
        .expect("the tl seat should have run a turn");
    assert_eq!(
        sent, "opus[1m]",
        "a TL turn must run on the seat's own model, never on whatever the user last \
chatted with: {turn_models:?}"
    );
}

/// Replays the private driver's dev-then-review sequence for one sub-task, far
/// enough to exercise the provider-halt and reviewer-gate mechanisms this
/// sub-task adds. Round bookkeeping (`rounds_used`/`Escalated`) is normally the
/// PRIVATE driver's job; this fakes just enough of it (a NEEDS_CHANGES verdict
/// every round) to prove the new gate does not interfere with a review loop
/// that legitimately reaches `Escalated`.
struct DevThenReviewDriver {
    /// Set right after the dev turn, before the first reviewer attempt — models
    /// a stop landing in exactly the window the driver would otherwise use to
    /// start reviewing, ahead of its own next boundary check.
    request_stop_before_review: bool,
    /// How many reviewer turns to attempt. Zero skips reviewing (and starting
    /// the reviewer thread) entirely — the sane thing a real driver does after
    /// a dev turn that did not land.
    reviewer_rounds: u32,
    dev_outcome: std::sync::Arc<Mutex<Option<relay_api::team::TeamTurnOutcome>>>,
    reviewer_outcomes: std::sync::Arc<Mutex<Vec<relay_api::team::TeamTurnOutcome>>>,
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for DevThenReviewDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, port: std::sync::Arc<dyn relay_api::TeamPort>, run_id: String) {
        let dev_thread = port
            .start_thread(&run_id, relay_api::team::TeamRole::Dev)
            .await
            .expect("dev seat thread");
        port.update_run(
            &run_id,
            Box::new(move |run| {
                run.sub_tasks.push(crate::state::SubTask {
                    id: "st-1".to_string(),
                    dev_thread_id: Some(dev_thread),
                    ..Default::default()
                });
            }),
        )
        .await;

        let dev_outcome = port
            .turn(
                &run_id,
                relay_api::team::TeamThreadSlot::SubTaskDev(0),
                relay_api::team::TeamRole::Dev,
                "write the parser",
            )
            .await;
        *self.dev_outcome.lock().await = Some(dev_outcome);

        if self.reviewer_rounds > 0 {
            if self.request_stop_before_review {
                // The flags a user's stop sets, without the full drain — the
                // `PausePending` race window the reviewer gate exists for.
                port.update_run(&run_id, Box::new(|run| run.request_stop("device-stop")))
                    .await;
            }

            let reviewer_thread = port
                .start_thread(&run_id, relay_api::team::TeamRole::Reviewer)
                .await
                .expect("reviewer seat thread");
            port.update_run(
                &run_id,
                Box::new(move |run| {
                    if let Some(task) = run.sub_tasks.get_mut(0) {
                        task.reviewer_thread_id = Some(reviewer_thread);
                    }
                }),
            )
            .await;

            for _ in 0..self.reviewer_rounds {
                let outcome = port
                    .turn(
                        &run_id,
                        relay_api::team::TeamThreadSlot::SubTaskReviewer(0),
                        relay_api::team::TeamRole::Reviewer,
                        "review it",
                    )
                    .await;
                let refused = matches!(outcome, relay_api::team::TeamTurnOutcome::Failed(_));
                self.reviewer_outcomes.lock().await.push(outcome);
                if refused {
                    break;
                }
                // A NEEDS_CHANGES verdict every round, exactly the shape that
                // reaches `Escalated` once the round budget runs out.
                port.update_run(
                    &run_id,
                    Box::new(|run| {
                        if let Some(task) = run.sub_tasks.get_mut(0) {
                            task.rounds_used += 1;
                            if task.rounds_used >= relay_api::team::MAX_SUBTASK_REVIEW_ROUNDS {
                                task.status = relay_api::team::SubTaskStatus::Escalated;
                            }
                        }
                    }),
                )
                .await;
            }
        }

        // Wrap up like `OneDevTurnDriver` does. A no-op when this run already
        // settled itself (the provider halt, or a gate refusal) — every
        // `TeamRun` mutator refuses once `is_settled_without_driver()` is true —
        // and otherwise leaves a clean terminal instead of falling to the crash
        // net's `Interrupted`.
        port.settle_run(
            &run_id,
            crate::state::TeamRunStatus::Failed,
            "test driver done",
        )
        .await;
    }
}

#[tokio::test]
async fn a_dev_turn_that_hits_a_usage_limit_halts_the_run_before_any_review() {
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

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 0,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    match dev_outcome.lock().await.clone() {
        Some(relay_api::team::TeamTurnOutcome::Failed(reason)) => {
            assert!(
                reason.contains("Usage limit reached"),
                "the dev turn's own reason should say so: {reason}"
            );
        }
        other => panic!("the dev turn should have failed on the provider limit: {other:?}"),
    }
    assert!(
        run.pause_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("Usage limit reached")),
        "pause_reason must name the limit, got {:?}",
        run.pause_reason
    );
    assert_eq!(
        run.pause_kind,
        Some(relay_api::team::TeamPauseKind::Provider)
    );
    assert!(
        reviewer_outcomes.lock().await.is_empty(),
        "the reviewer thread must never be given a turn after a provider halt"
    );
    assert_eq!(run.sub_tasks[0].rounds_used, 0);
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
}

/// A kind from a worker NEWER than this build. It must decode to "no kind" and
/// take the ordinary-failure path: every kind that halts settles the run
/// `Paused` — resumable, and read by the user as "waiting for quota" — so an
/// unrecognised one must never reach that path on the strength of being unknown.
#[tokio::test]
async fn an_unrecognised_failure_kind_fails_the_turn_without_pausing_the_run() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .fail_completed_turn_with
        .lock()
        .await
        .replace((
            "The provider rejected the request".to_string(),
            Some("bad_request_v2".to_string()),
        ));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 0,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    // Reaching `Failed` at all is the assertion: a halt would settle `Paused`
    // first, and every later mutator — this one included — is then a no-op.
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Failed).await;

    match dev_outcome.lock().await.clone() {
        Some(relay_api::team::TeamTurnOutcome::Failed(reason)) => {
            assert!(
                reason.contains("The provider rejected the request"),
                "the turn still fails, and still says why: {reason}"
            );
        }
        other => panic!("an unclassified failure is still a failed turn: {other:?}"),
    }
    assert_eq!(
        run.pause_kind, None,
        "an unknown kind must not be read as a provider limit"
    );
}

/// The same policy as the usage-limit halt, reached from Codex's OTHER session
/// limit. Ending a session-budget failure terminally throws away the branch,
/// the worktree and every finished sub-task; paused, they are all still there
/// when the budget is raised.
#[tokio::test]
async fn a_dev_turn_that_exhausts_the_session_budget_halts_the_run_before_any_review() {
    // Asserted, not assumed: the harness below speaks the Claude worker's wire
    // string, so without this the test would ride the usage-limit path and
    // prove nothing about Codex's session-budget variant.
    let kind = crate::codex::codex_error_info_kind(&serde_json::json!("sessionBudgetExceeded"))
        .expect("a session budget is a session limit and must be classified");
    assert!(
        kind.halts_the_run(),
        "a classified session limit must pause the run rather than end it"
    );

    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .fail_completed_turn_with
        .lock()
        .await
        .replace((
            "Session budget exhausted".to_string(),
            Some("usage_limit".to_string()),
        ));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 0,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    match dev_outcome.lock().await.clone() {
        Some(relay_api::team::TeamTurnOutcome::Failed(reason)) => {
            assert!(
                reason.contains("Session budget exhausted"),
                "the dev turn's own reason should say so: {reason}"
            );
        }
        other => panic!("the dev turn should have failed on the session budget: {other:?}"),
    }
    assert!(
        run.pause_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("Session budget exhausted")),
        "pause_reason must name the limit, got {:?}",
        run.pause_reason
    );
    assert_eq!(
        run.pause_kind,
        Some(relay_api::team::TeamPauseKind::Provider)
    );
    assert!(
        reviewer_outcomes.lock().await.is_empty(),
        "the reviewer thread must never be given a turn after a provider halt"
    );
    assert_eq!(
        run.sub_tasks[0].rounds_used, 0,
        "a paused run has spent no review budget"
    );
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
}

/// `Replied` proves the agent SPOKE, not that it worked. A dev that answers
/// "I couldn't do this" and spends nothing must not open the reviewer gate —
/// otherwise a reviewer runs against an unchanged branch, burns both rounds and
/// escalates, which is the false failure this whole feature exists to stop.
#[tokio::test]
async fn a_dev_turn_that_replies_but_bills_nothing_leaves_the_gate_shut() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    // The provider reports a figure, and that figure is zero.
    providers
        .get("codex")
        .unwrap()
        .report_turn_usage
        .lock()
        .await
        .replace((0, None));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 1,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    // A gate refusal settles the run `Paused` at a boundary, the same terminal
    // `a_reviewer_turn_is_refused_without_a_landed_dev_turn` waits for.
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    assert!(
        matches!(
            dev_outcome.lock().await.clone(),
            Some(relay_api::team::TeamTurnOutcome::Replied(_))
        ),
        "the premise: the dev DID reply, it just did no work"
    );
    assert_eq!(
        run.sub_tasks[0].dev_turns_landed, 0,
        "a turn that billed nothing has not landed"
    );
    match reviewer_outcomes.lock().await.first() {
        Some(relay_api::team::TeamTurnOutcome::Failed(reason)) => assert!(
            reason.contains("no landed dev turn"),
            "the reviewer must be refused by the gate: {reason}"
        ),
        other => panic!("the reviewer must not run against an unchanged branch: {other:?}"),
    }
    assert_eq!(
        run.sub_tasks[0].rounds_used, 0,
        "no review budget was spent"
    );
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
}

/// The other half: real spend opens the gate, so ordinary work still reviews.
#[tokio::test]
async fn a_dev_turn_that_bills_tokens_opens_the_reviewer_gate() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    providers
        .get("codex")
        .unwrap()
        .report_turn_usage
        .lock()
        .await
        .replace((1_200, None));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 1,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Failed).await;

    assert_eq!(
        run.sub_tasks[0].dev_turns_landed, 1,
        "a turn that billed tokens has landed"
    );
    assert!(
        !matches!(
            reviewer_outcomes.lock().await.first(),
            Some(relay_api::team::TeamTurnOutcome::Failed(reason)) if reason.contains("no landed dev turn")
        ),
        "the gate must not refuse a dev turn that really spent"
    );
}

/// The FALLBACK, pinned so it can never become a silent one. Not every path
/// reports usage; requiring a figure would refuse every reviewer turn forever
/// on such a provider and deadlock the run. No figure means the old `Replied`
/// rule stands.
#[tokio::test]
async fn a_dev_turn_with_no_usage_figure_at_all_still_counts_as_landed() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    // Deliberately NOT setting `report_turn_usage`: nothing is reported.
    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 1,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));
    let _ = &providers;

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Failed).await;

    assert_eq!(
        run.sub_tasks[0].dev_turns_landed, 1,
        "with no figure to judge by, a reply still lands"
    );
}

/// The record is never cleared, so a reader that checked mere presence would let
/// an EARLIER turn's figure decide this one. A leftover zero must not shut the
/// gate on a turn that reported nothing of its own.
#[tokio::test]
async fn a_spend_figure_from_another_turn_does_not_shut_the_gate() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    // Zero tokens, billed against a turn id this run never dispatched.
    providers
        .get("codex")
        .unwrap()
        .report_turn_usage
        .lock()
        .await
        .replace((0, Some("turn-from-an-earlier-life".to_string())));

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 1,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let mut input = team_input(&root);
    input.dev_provider = "codex".to_string();
    let run_id = app.start_team_run(input).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Failed).await;

    assert_eq!(
        run.sub_tasks[0].dev_turns_landed, 1,
        "a figure for a different turn is not this turn's evidence"
    );
}

#[tokio::test]
async fn a_reviewer_turn_is_refused_without_a_landed_dev_turn() {
    let (_repo, root) = init_team_repo().await;
    let (app, providers) = build_review_app(&root, &["codex"]).await;
    // The dev turn completes (active turn clears, thread goes idle) but emits no
    // assistant message at all — the `Silent` shape, not a failure. This must
    // NOT count as landed, or the gate this test exists to pin would never fire
    // for the very case the brief calls out.
    providers
        .get("codex")
        .unwrap()
        .emit_assistant
        .store(false, std::sync::atomic::Ordering::Relaxed);

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: 1,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    assert!(
        matches!(
            dev_outcome.lock().await.clone(),
            Some(relay_api::team::TeamTurnOutcome::Silent)
        ),
        "the dev turn must land nothing (Silent) — not fail — to exercise the \
zero-landed gate rather than the provider-halt one"
    );
    assert_eq!(
        run.sub_tasks[0].dev_turns_landed, 0,
        "a Silent dev turn must not count as landed"
    );
    let reviewer_outcomes = reviewer_outcomes.lock().await.clone();
    assert_eq!(reviewer_outcomes.len(), 1);
    assert!(
        matches!(
            reviewer_outcomes[0],
            relay_api::team::TeamTurnOutcome::Failed(_)
        ),
        "a reviewer turn with nothing landed to review must be refused: {:?}",
        reviewer_outcomes[0]
    );
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated,
        "a refused reviewer turn must never escalate the sub-task"
    );
}

#[tokio::test]
async fn a_stop_mid_run_refuses_the_next_reviewer_turn() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: true,
        reviewer_rounds: 1,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    assert!(
        matches!(
            dev_outcome.lock().await.clone(),
            Some(relay_api::team::TeamTurnOutcome::Replied(_))
        ),
        "the dev turn itself must land normally; only the reviewer turn after \
the stop is refused"
    );
    assert_eq!(
        run.sub_tasks[0].dev_turns_landed, 1,
        "the refusal must be attributable to the stop, not to a missing dev turn"
    );
    let reviewer_outcomes = reviewer_outcomes.lock().await.clone();
    assert_eq!(reviewer_outcomes.len(), 1);
    assert!(
        matches!(
            reviewer_outcomes[0],
            relay_api::team::TeamTurnOutcome::Failed(_)
        ),
        "a reviewer turn requested while stopping must be refused: {:?}",
        reviewer_outcomes[0]
    );
    assert_eq!(
        run.sub_tasks[0].rounds_used, 0,
        "a refused round must never be counted against the review budget"
    );
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
}

/// Drives a landed Dev turn, then waits to be released before attempting the
/// Reviewer turn — giving a test full control over exactly when that second
/// turn starts, so it can arrange a stop to land in the specific window
/// between the reviewer gate's early check and the drive gate.
struct RaceWindowDriver {
    dev_outcome: std::sync::Arc<Mutex<Option<relay_api::team::TeamTurnOutcome>>>,
    reviewer_outcome: std::sync::Arc<Mutex<Option<relay_api::team::TeamTurnOutcome>>>,
    dev_landed: std::sync::Arc<tokio::sync::Notify>,
    proceed_to_reviewer: std::sync::Arc<tokio::sync::Notify>,
}

#[async_trait::async_trait]
impl relay_api::TeamDriver for RaceWindowDriver {
    fn orchestrator_system_prompt(&self) -> String {
        "test driver".to_string()
    }

    async fn drive(&self, port: std::sync::Arc<dyn relay_api::TeamPort>, run_id: String) {
        let dev_thread = port
            .start_thread(&run_id, relay_api::team::TeamRole::Dev)
            .await
            .expect("dev seat thread");
        port.update_run(
            &run_id,
            Box::new(move |run| {
                run.sub_tasks.push(crate::state::SubTask {
                    id: "st-1".to_string(),
                    dev_thread_id: Some(dev_thread),
                    ..Default::default()
                });
            }),
        )
        .await;
        let dev_outcome = port
            .turn(
                &run_id,
                relay_api::team::TeamThreadSlot::SubTaskDev(0),
                relay_api::team::TeamRole::Dev,
                "write the parser",
            )
            .await;
        *self.dev_outcome.lock().await = Some(dev_outcome);
        // The dev turn's own `dev_turns_landed` bump has already happened by
        // now — it runs before `team_turn` returns, and this await only
        // resolves once that call has returned.
        self.dev_landed.notify_one();
        self.proceed_to_reviewer.notified().await;

        let reviewer_thread = port
            .start_thread(&run_id, relay_api::team::TeamRole::Reviewer)
            .await
            .expect("reviewer seat thread");
        port.update_run(
            &run_id,
            Box::new(move |run| {
                if let Some(task) = run.sub_tasks.get_mut(0) {
                    task.reviewer_thread_id = Some(reviewer_thread);
                }
            }),
        )
        .await;
        let reviewer_outcome = port
            .turn(
                &run_id,
                relay_api::team::TeamThreadSlot::SubTaskReviewer(0),
                relay_api::team::TeamRole::Reviewer,
                "review it",
            )
            .await;
        *self.reviewer_outcome.lock().await = Some(reviewer_outcome);
        port.settle_run(
            &run_id,
            crate::state::TeamRunStatus::Failed,
            "test driver done",
        )
        .await;
    }
}

/// [P1 fix] The early reviewer-gate check (before any thread is resolved) is
/// NOT sufficient by itself: `team_turn` still has to resolve the thread,
/// write the phase note, and reach `team_drive_gate` before it can dispatch —
/// and a stop's `request_stop` sets its flags without ever taking that gate,
/// so it can land in exactly that window. This pins that the gate is
/// REPEATED once `team_drive_gate` is held, using the existing pre-gate latch
/// (`hold_team_turn_barrier`) to land the stop deterministically rather than
/// racing real wall-clock timing.
#[tokio::test]
async fn a_stop_landing_between_the_reviewer_gates_early_check_and_the_drive_gate_is_still_caught()
{
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcome = std::sync::Arc::new(Mutex::new(None));
    let dev_landed = std::sync::Arc::new(tokio::sync::Notify::new());
    let proceed_to_reviewer = std::sync::Arc::new(tokio::sync::Notify::new());
    let app = app.with_team_driver(std::sync::Arc::new(RaceWindowDriver {
        dev_outcome: dev_outcome.clone(),
        reviewer_outcome: reviewer_outcome.clone(),
        dev_landed: dev_landed.clone(),
        proceed_to_reviewer: proceed_to_reviewer.clone(),
    }));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    // The dev turn has landed (and bumped `dev_turns_landed`) by the time this
    // resolves; the driver is now parked before even starting the reviewer
    // thread, so `team_turn_barrier` is uncontended.
    dev_landed.notified().await;

    let before = app.team_turn_arrivals();
    let latch = app.hold_team_turn_barrier().await;
    // Release the driver NOW, while we hold the latch: its reviewer turn's
    // early check runs and PASSES (dev_turns_landed is 1, nothing pausing
    // yet), then it parks on the latch we are holding — never reaching
    // `team_drive_gate` until we say so.
    proceed_to_reviewer.notify_one();

    for _ in 0..2_000 {
        if app.team_turn_arrivals() > before {
            break;
        }
        sleep(Duration::from_millis(5)).await;
    }
    assert!(
        app.team_turn_arrivals() > before,
        "the reviewer turn should have reached the pre-gate latch by now"
    );

    // The stop lands in exactly the window the early check cannot see: past
    // its own check (already passed), not yet holding the drive gate.
    app.relay
        .write()
        .await
        .update_team_run(&run_id, |run| run.request_stop("device-stop"));
    drop(latch);

    let run = wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Paused).await;

    assert!(
        matches!(
            dev_outcome.lock().await.clone(),
            Some(relay_api::team::TeamTurnOutcome::Replied(_))
        ),
        "the dev turn itself must land normally"
    );
    match reviewer_outcome.lock().await.clone() {
        Some(relay_api::team::TeamTurnOutcome::Failed(_)) => {}
        other => panic!(
            "a stop landing between the reviewer turn's early check and the \
drive gate must still refuse it, not merely a stop that lands before the \
early check runs at all: {other:?}"
        ),
    }
    assert_eq!(
        run.sub_tasks[0].rounds_used, 0,
        "a refused round must never be counted against the review budget"
    );
    assert_ne!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
}

/// Regression: the new gate must not weaken the ordinary path. A dev turn that
/// lands, followed by a reviewer that rejects it twice, must still reach
/// `Escalated` exactly as it did before this sub-task.
#[tokio::test]
async fn a_landed_dev_turn_and_two_reviewer_rejections_still_escalate() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;

    let dev_outcome = std::sync::Arc::new(Mutex::new(None));
    let reviewer_outcomes = std::sync::Arc::new(Mutex::new(Vec::new()));
    let app = app.with_team_driver(std::sync::Arc::new(DevThenReviewDriver {
        request_stop_before_review: false,
        reviewer_rounds: crate::state::MAX_SUBTASK_REVIEW_ROUNDS,
        dev_outcome: dev_outcome.clone(),
        reviewer_outcomes: reviewer_outcomes.clone(),
    }));

    let run_id = app.start_team_run(team_input(&root)).await.expect("start");
    wait_for_team_status(&app, &run_id, crate::state::TeamRunStatus::Failed).await;

    let reviewer_outcomes = reviewer_outcomes.lock().await.clone();
    assert_eq!(
        reviewer_outcomes.len(),
        crate::state::MAX_SUBTASK_REVIEW_ROUNDS as usize,
        "both review rounds must actually run: {reviewer_outcomes:?}"
    );
    for outcome in &reviewer_outcomes {
        assert!(
            !matches!(outcome, relay_api::team::TeamTurnOutcome::Failed(_)),
            "a landed dev turn must not have its reviewer refused: {outcome:?}"
        );
    }
    let relay = app.relay.read().await;
    let run = relay
        .team_run(&run_id)
        .cloned()
        .expect("run still recorded");
    assert_eq!(
        run.sub_tasks[0].rounds_used,
        crate::state::MAX_SUBTASK_REVIEW_ROUNDS
    );
    assert_eq!(
        run.sub_tasks[0].status,
        crate::state::SubTaskStatus::Escalated
    );
}

#[tokio::test]
async fn a_finished_task_can_be_marked_cancelled_or_done() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");

    app.relay.write().await.update_team_run(&run_id, |run| {
        run.status = crate::state::TeamRunStatus::Escalated;
        run.phase = relay_api::team::TeamPhase::Finished;
        run.error = Some("ran out of rounds".into());
    });

    let error = app
        .cancel_team_run(Some(run_id.clone()), Some("device-1".to_string()))
        .await
        .expect_err("cancel must refuse a terminal run");
    assert!(
        error.contains("already finished"),
        "the old cancel path must stay strict: {error}"
    );

    let status = app
        .mark_team_run(
            Some(run_id.clone()),
            Some("device-1".to_string()),
            crate::state::TeamRunStatus::Cancelled,
        )
        .await
        .expect("mark cancelled");
    assert_eq!(status, crate::state::TeamRunStatus::Cancelled);

    let status = app
        .mark_team_run(
            Some(run_id.clone()),
            Some("device-1".to_string()),
            crate::state::TeamRunStatus::Done,
        )
        .await
        .expect("mark done");
    assert_eq!(status, crate::state::TeamRunStatus::Done);
    let run = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert!(run.error.is_none(), "done clears the error");
}

#[tokio::test]
async fn a_blocked_task_cannot_be_marked_while_a_turn_is_unconfirmed() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");

    app.relay.write().await.update_team_run(&run_id, |run| {
        run.status = crate::state::TeamRunStatus::Blocked;
        run.in_flight_thread = Some("thread-mid-start".to_string());
        run.error = Some("drain unconfirmed".into());
    });

    let error = app
        .mark_team_run(
            Some(run_id.clone()),
            Some("device-1".to_string()),
            crate::state::TeamRunStatus::Cancelled,
        )
        .await
        .expect_err("mark must refuse an unconfirmed blocked run");
    assert!(
        error.contains("did not confirm stopping"),
        "the refusal must name the drain failure: {error}"
    );
    let run = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::Blocked);
}

#[tokio::test]
async fn mark_quiescent_refuses_when_the_run_is_no_longer_paused_or_terminal() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");

    app.relay.write().await.update_team_run(&run_id, |run| {
        run.status = crate::state::TeamRunStatus::Running;
    });

    let error = app
        .mark_quiescent_team_run(&run_id, crate::state::TeamRunStatus::Cancelled)
        .await
        .expect_err("mark must not relabel a live run without stopping it");
    assert!(
        error.contains("no longer be marked"),
        "the refusal must name the race loser: {error}"
    );
    let run = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::Running);
}

#[tokio::test]
async fn mark_refuses_a_run_that_is_being_resolved() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");

    app.relay.write().await.update_team_run(&run_id, |run| {
        run.status = crate::state::TeamRunStatus::Resolving;
    });

    let error = app
        .mark_team_run(
            Some(run_id.clone()),
            Some("device-1".to_string()),
            crate::state::TeamRunStatus::Cancelled,
        )
        .await
        .expect_err("mark must refuse a recovery in flight");
    assert!(
        error.contains("being resolved"),
        "the refusal must name the recovery owner: {error}"
    );
    let run = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::Resolving);
}

#[tokio::test]
async fn reopen_rollback_does_not_clobber_a_concurrent_mark() {
    let (_repo, root) = init_team_repo().await;
    let (app, _providers) = build_review_app(&root, &["codex"]).await;
    let run_id = app.start_team_run(team_input(&root)).await.expect("start");

    app.relay.write().await.update_team_run(&run_id, |run| {
        run.status = crate::state::TeamRunStatus::Escalated;
    });
    let restore = app
        .relay
        .read()
        .await
        .team_run(&run_id)
        .cloned()
        .expect("run");

    app.relay.write().await.update_team_run(&run_id, |run| {
        run.status = crate::state::TeamRunStatus::Cancelled;
    });

    app.rollback_reopen_provision(&run_id, &restore).await;

    let run = app.relay.read().await.team_run(&run_id).cloned().unwrap();
    assert_eq!(run.status, crate::state::TeamRunStatus::Cancelled);
}
