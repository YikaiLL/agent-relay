//! Line-comment HTTP entry points: scope authorization, grouped reads, mutations.

use std::collections::{HashMap, HashSet};

use relay_api::{
    CommentSide, LineAnchor, ReviewAuthorKind, ReviewComment, ReviewCommentStatus,
    ReviewCommentView, WINDOW_CONTEXT_LINES,
};

use crate::protocol::{
    CommentHandBackInput, CommentResolveInput, CreateCommentInput, ListCommentsResponse,
    SendMessageInput,
};
use crate::usage::review_comments::{
    anchor_file_key, anchor_readable, relocate_comments_grouped, AnchorFileContent, AnchorFileKey,
};

use super::review::random_suffix;
use super::team_diff::validate_repo_relative_path;
use super::thread_workspace::ThreadWorkspaceError;
use super::*;

pub(crate) const LINE_COMMENTS_LOCKED_MESSAGE: &str =
    "line comments are not available in this build; install a release that includes them";

pub(crate) const TEAM_RUN_HAND_BACK_UNAVAILABLE: &str =
    "hand-back is only supported for thread-scoped comments; a finished task run cannot accept \
     handed-back line comments yet";

impl AppState {
    pub async fn list_review_comments(
        &self,
        scope: String,
        device_id: Option<String>,
    ) -> Result<ListCommentsResponse, String> {
        self.authorize_comment_scope(&scope, device_id.clone())
            .await?;
        let comments = self
            .review_comment_views_for_scope(&scope, device_id.as_deref())
            .await?;
        let (can_hand_back, hand_back_unavailable_reason) = comment_hand_back_list_meta(&scope);
        Ok(ListCommentsResponse {
            scope,
            comments,
            can_hand_back,
            hand_back_unavailable_reason,
        })
    }

    pub async fn create_review_comment(
        &self,
        input: CreateCommentInput,
    ) -> Result<ReviewComment, String> {
        if !self.review_anchors.can_anchor() {
            return Err(LINE_COMMENTS_LOCKED_MESSAGE.to_string());
        }
        self.authorize_comment_scope(&input.scope, input.device_id.clone())
            .await?;

        let body =
            non_empty(Some(input.body)).ok_or_else(|| "comment body is required".to_string())?;
        validate_repo_relative_path(&input.anchor.path)?;
        let side = CommentSide::parse(input.anchor.side.trim())
            .ok_or_else(|| format!("side must be 'old' or 'new', not '{}'", input.anchor.side))?;
        if input.anchor.line == 0 {
            return Err("line must be a positive 1-based line number".to_string());
        }
        if matches!(side, CommentSide::Old) && non_empty(input.anchor.base_commit.clone()).is_none()
        {
            return Err("base_commit is required for old-side anchors".to_string());
        }

        let file = self
            .read_anchor_file_for_comment(
                &input.scope,
                input.device_id.as_deref(),
                &input.anchor.path,
                side,
                input.anchor.base_commit.as_deref(),
                input.anchor.line,
            )
            .await?;
        // Create must fail when the anchor file is unreadable: a stored comment
        // without a valid quote is useless from birth. List/read returns
        // `Unavailable` for the same file because an existing anchor may have
        // outlived a rename — different question, different answer.

        #[cfg(feature = "private")]
        {
            let quote = sealwire_private::compute_line_anchor_quote(
                &file.content,
                input.anchor.line,
                WINDOW_CONTEXT_LINES,
            )
            .ok_or_else(|| {
                format!(
                    "line {} is out of range in {}",
                    input.anchor.line, input.anchor.path
                )
            })?;

            let now = crate::state::unix_now();
            let comment = ReviewComment {
                id: format!("rcmt_{}", random_suffix()),
                scope: input.scope,
                author_kind: ReviewAuthorKind::Human,
                author_role: None,
                body,
                status: ReviewCommentStatus::Open,
                anchor: LineAnchor {
                    path: input.anchor.path,
                    side,
                    line: input.anchor.line,
                    exact: quote.exact,
                    prefix: quote.prefix,
                    suffix: quote.suffix,
                    line_hash: quote.line_hash,
                    window_hash: quote.window_hash,
                    base_commit: non_empty(input.anchor.base_commit),
                },
                created_at: now,
                updated_at: now,
            };

            let store = {
                let relay = self.relay.read().await;
                relay.usage_store.clone()
            };
            store.insert_review_comment(&comment)?;
            return Ok(comment);
        }

        #[cfg(not(feature = "private"))]
        {
            Err(LINE_COMMENTS_LOCKED_MESSAGE.to_string())
        }
    }

    pub async fn resolve_review_comment(
        &self,
        comment_id: String,
        input: CommentResolveInput,
    ) -> Result<ReviewComment, String> {
        let comment = self
            .load_authorized_comment(&comment_id, input.device_id)
            .await?;
        let status = match input.action.trim() {
            "resolve" => ReviewCommentStatus::Resolved,
            "dismiss" => ReviewCommentStatus::Dismissed,
            other => {
                return Err(format!(
                    "action must be 'resolve' or 'dismiss', not '{other}'"
                ))
            }
        };
        let event_kind = match status {
            ReviewCommentStatus::Resolved => "resolved",
            ReviewCommentStatus::Dismissed => "dismissed",
            _ => unreachable!("resolve route only sets resolved or dismissed"),
        };
        let now = crate::state::unix_now();
        let store = {
            let relay = self.relay.read().await;
            relay.usage_store.clone()
        };
        store.update_review_comment_status(&comment.id, status, event_kind, now)
    }

    pub async fn hand_back_review_comment(
        &self,
        comment_id: String,
        input: CommentHandBackInput,
    ) -> Result<ReviewComment, String> {
        let device_id = require_device_id(input.device_id)?;
        let comment = self
            .load_authorized_comment(&comment_id, Some(device_id.clone()))
            .await?;
        ensure_hand_back_scope(&comment.scope)?;
        ensure_hand_backable(&comment)?;

        let thread_id = comment
            .scope
            .strip_prefix("thread:")
            .expect("hand-back scope guard ensures thread scope");

        let prompt = hand_back_prompt(&comment);
        self.send_message(SendMessageInput {
            text: prompt,
            model: None,
            effort: None,
            device_id: Some(device_id),
            thread_id: thread_id.to_string(),
        })
        .await?;

        let now = crate::state::unix_now();
        let store = {
            let relay = self.relay.read().await;
            relay.usage_store.clone()
        };
        store.update_review_comment_status(
            &comment.id,
            ReviewCommentStatus::HandedBack,
            "handed_back",
            now,
        )
    }

    async fn load_authorized_comment(
        &self,
        comment_id: &str,
        device_id: Option<String>,
    ) -> Result<ReviewComment, String> {
        let comment = {
            let relay = self.relay.read().await;
            relay
                .usage_store
                .get_review_comment(comment_id)?
                .ok_or_else(|| format!("no comment with id {comment_id}"))?
        };
        self.authorize_comment_scope(&comment.scope, device_id)
            .await?;
        Ok(comment)
    }

    /// Same authorization as reading the subject's diff: worktree path scope for
    /// task runs, thread workspace resolution for session threads.
    pub(crate) async fn authorize_comment_scope(
        &self,
        scope: &str,
        device_id: Option<String>,
    ) -> Result<(), String> {
        if let Some(run_id) = scope.strip_prefix("team_run:") {
            if run_id.is_empty() {
                return Err("scope team_run: requires a run id".to_string());
            }
            if !self.beta_features_enabled().await {
                return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
            }
            self.authorize_team_action(Some(run_id), device_id).await?;
            return Ok(());
        }

        if let Some(thread_id) = scope.strip_prefix("thread:") {
            if thread_id.is_empty() {
                return Err("scope thread: requires a thread id".to_string());
            }
            let device_id = require_device_id(device_id)?;
            self.resolve_thread_workspace(thread_id, Some(&device_id))
                .await
                .map_err(ThreadWorkspaceError::into_message)?;
            return Ok(());
        }

        Err(format!(
            "scope must be team_run:<id> or thread:<id>, not '{scope}'"
        ))
    }

    /// Load every comment in `scope`, read each file once, and re-locate anchors.
    pub(crate) async fn review_comment_views_for_scope(
        &self,
        scope: &str,
        device_id: Option<&str>,
    ) -> Result<Vec<ReviewCommentView>, String> {
        let comments = {
            let relay = self.relay.read().await;
            relay.usage_store.list_review_comments_by_scope(scope)?
        };
        if comments.is_empty() {
            return Ok(Vec::new());
        }

        let keys: HashSet<AnchorFileKey> = comments.iter().map(anchor_file_key).collect();
        let contents = self
            .load_review_anchor_files(scope, device_id, &keys)
            .await?;
        Ok(relocate_comments_grouped(
            comments,
            &contents,
            self.review_anchors.as_ref(),
        ))
    }

    async fn read_anchor_file_for_comment(
        &self,
        scope: &str,
        device_id: Option<&str>,
        path: &str,
        side: CommentSide,
        base_commit: Option<&str>,
        line: u32,
    ) -> Result<AnchorFileContent, String> {
        let key = AnchorFileKey {
            path: path.to_string(),
            side,
            base_commit: base_commit.map(str::to_string),
        };
        let mut keys = HashSet::new();
        keys.insert(key.clone());
        let contents = self
            .load_review_anchor_files(scope, device_id, &keys)
            .await?;
        match contents.get(&key) {
            Some(Some(file)) if anchor_readable(file, line) => Ok(file.clone()),
            Some(Some(file)) => Err(format!(
                "only the first {} lines of {path} were readable; cannot anchor line {line}",
                file.line_count()
            )),
            Some(None) | None => Err(format!("could not read {path} for anchoring")),
        }
    }

    pub(crate) async fn load_review_anchor_files(
        &self,
        scope: &str,
        device_id: Option<&str>,
        keys: &HashSet<AnchorFileKey>,
    ) -> Result<HashMap<AnchorFileKey, Option<AnchorFileContent>>, String> {
        let mut contents = HashMap::new();
        if let Some(run_id) = scope.strip_prefix("team_run:") {
            let workspace = self
                .team_workspace(run_id)
                .await
                .ok_or_else(|| format!("no worktree for task run {run_id}"))?;
            for key in keys {
                let content = team_diff::read_anchor_file_from_worktree(
                    &workspace,
                    key.side,
                    key.base_commit.as_deref(),
                    &key.path,
                )
                .await?;
                contents.insert(key.clone(), content);
            }
            return Ok(contents);
        }

        if let Some(thread_id) = scope.strip_prefix("thread:") {
            let resolved = self
                .resolve_thread_workspace(thread_id, device_id)
                .await
                .map_err(ThreadWorkspaceError::into_message)?;
            let workspace = self
                .admit(&resolved.cwd)
                .await
                .trusted()
                .ok_or_else(|| {
                    format!(
                        "the workspace for thread {thread_id} ({}) is not trusted",
                        resolved.cwd
                    )
                })?
                .clone();
            for key in keys {
                let content = team_diff::read_anchor_file_from_worktree(
                    &workspace,
                    key.side,
                    key.base_commit.as_deref(),
                    &key.path,
                )
                .await?;
                contents.insert(key.clone(), content);
            }
            return Ok(contents);
        }

        Err(format!("unknown review comment scope: {scope}"))
    }
}

pub(crate) fn ensure_hand_back_scope(scope: &str) -> Result<(), String> {
    if scope.starts_with("team_run:") {
        return Err(TEAM_RUN_HAND_BACK_UNAVAILABLE.to_string());
    }
    if scope.starts_with("thread:") {
        if scope.len() <= "thread:".len() {
            return Err("scope thread: requires a thread id".to_string());
        }
        return Ok(());
    }
    Err(format!("unknown review comment scope: {scope}"))
}

pub(crate) fn comment_hand_back_list_meta(scope: &str) -> (bool, Option<String>) {
    match ensure_hand_back_scope(scope) {
        Ok(()) => (true, None),
        Err(reason) => (false, Some(reason)),
    }
}

pub(crate) fn ensure_hand_backable(comment: &ReviewComment) -> Result<(), String> {
    if comment.status == ReviewCommentStatus::Open {
        return Ok(());
    }
    Err(format!(
        "only open comments can be handed back (this one is {})",
        comment_status_label(comment.status)
    ))
}

pub(crate) fn hand_back_prompt(comment: &ReviewComment) -> String {
    let anchor = &comment.anchor;
    let side = anchor.side.as_str();
    let mut lines = vec![
        format!(
            "Please address this line comment on `{}` ({side} side, line {}):",
            anchor.path, anchor.line
        ),
        String::new(),
        comment.body.clone(),
    ];
    if !anchor.exact.is_empty() {
        lines.push(String::new());
        lines.push(format!("Quoted line: `{}`", anchor.exact));
    }
    lines.join("\n")
}

fn comment_status_label(status: ReviewCommentStatus) -> &'static str {
    match status {
        ReviewCommentStatus::Open => "open",
        ReviewCommentStatus::Resolved => "resolved",
        ReviewCommentStatus::HandedBack => "handed_back",
        ReviewCommentStatus::Dismissed => "dismissed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_comment(scope: &str, status: ReviewCommentStatus) -> ReviewComment {
        ReviewComment {
            id: "c-1".to_string(),
            scope: scope.to_string(),
            author_kind: ReviewAuthorKind::Human,
            author_role: None,
            body: "extract the helper".to_string(),
            status,
            anchor: LineAnchor {
                path: "src/app.ts".to_string(),
                side: CommentSide::New,
                line: 12,
                exact: "fn main() {}".to_string(),
                prefix: String::new(),
                suffix: String::new(),
                line_hash: "h".to_string(),
                window_hash: "w".to_string(),
                base_commit: None,
            },
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn hand_back_rejects_team_run_scope() {
        let error = ensure_hand_back_scope("team_run:run-1").expect_err("must refuse");
        assert!(
            error.contains("only supported for thread-scoped"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn list_meta_marks_team_run_hand_back_unavailable() {
        let (can_hand_back, reason) = comment_hand_back_list_meta("team_run:run-1");
        assert!(!can_hand_back);
        assert!(reason.is_some());
    }

    #[test]
    fn list_meta_allows_thread_hand_back() {
        let (can_hand_back, reason) = comment_hand_back_list_meta("thread:t-1");
        assert!(can_hand_back);
        assert!(reason.is_none());
    }

    #[test]
    fn hand_back_prompt_includes_path_line_body_and_quote() {
        let prompt = hand_back_prompt(&sample_comment("thread:t-1", ReviewCommentStatus::Open));
        assert!(prompt.contains("src/app.ts"));
        assert!(prompt.contains("line 12"));
        assert!(prompt.contains("extract the helper"));
        assert!(prompt.contains("fn main() {}"));
    }

    #[test]
    fn hand_back_rejects_non_open_comments() {
        let error =
            ensure_hand_backable(&sample_comment("thread:t-1", ReviewCommentStatus::Resolved))
                .expect_err("resolved comment must not hand back");
        assert!(
            error.contains("only open comments"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn create_review_comment_rejects_without_private_anchors() {
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            "/tmp/project".to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        let app = AppState::from_parts(relay, HashMap::new(), change_tx);
        let error = app
            .create_review_comment(CreateCommentInput {
                scope: "thread:thread-1".to_string(),
                body: "fix".to_string(),
                anchor: crate::protocol::CreateCommentAnchorInput {
                    path: "src/a.ts".to_string(),
                    side: "new".to_string(),
                    line: 1,
                    base_commit: None,
                },
                device_id: Some("device-a".to_string()),
            })
            .await
            .expect_err("public build must refuse to anchor");
        assert!(
            error.contains("not available in this build"),
            "unexpected error: {error}"
        );
    }
}
