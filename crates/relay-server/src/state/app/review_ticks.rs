//! Per-file review ticks: record that a reviewer has seen a file at a point in time.

use relay_api::{CommentSide, FileReviewTickStatus, FileReviewTickView};
use relay_util::sha256_hex;

use crate::protocol::{ListReviewTicksQuery, ListReviewTicksResponse, TickReviewFileInput};
use crate::usage::store::FileReviewStateRow;

use super::team_diff::validate_repo_relative_path;
use super::*;

pub(crate) fn file_content_hash(content: &str) -> String {
    sha256_hex(content)
}

pub(crate) fn file_review_tick_status(
    stored: Option<&str>,
    current: Option<&str>,
) -> FileReviewTickStatus {
    let Some(stored) = stored.filter(|hash| !hash.is_empty()) else {
        return FileReviewTickStatus::None;
    };
    match current {
        Some(current) if current == stored => FileReviewTickStatus::Current,
        Some(_) => FileReviewTickStatus::Stale,
        None => FileReviewTickStatus::Stale,
    }
}

impl AppState {
    pub async fn list_review_ticks(
        &self,
        query: ListReviewTicksQuery,
    ) -> Result<ListReviewTicksResponse, String> {
        self.authorize_comment_scope(&query.scope, query.device_id.clone())
            .await?;
        let rows = {
            let relay = self.relay.read().await;
            relay
                .usage_store
                .list_file_review_states_by_scope(&query.scope)?
        };
        let mut ticks = Vec::with_capacity(rows.len());
        for row in rows {
            ticks.push(
                self.review_tick_view(&query.scope, query.device_id.as_deref(), row)
                    .await?,
            );
        }
        Ok(ListReviewTicksResponse {
            scope: query.scope,
            ticks,
        })
    }

    pub async fn tick_review_file(
        &self,
        input: TickReviewFileInput,
    ) -> Result<FileReviewTickView, String> {
        self.authorize_comment_scope(&input.scope, input.device_id.clone())
            .await?;
        validate_repo_relative_path(&input.path)?;
        let side = CommentSide::parse(input.side.trim())
            .ok_or_else(|| format!("side must be 'old' or 'new', not '{}'", input.side))?;
        if matches!(side, CommentSide::Old) && non_empty(input.base_commit.clone()).is_none() {
            return Err("base_commit is required for old-side ticks".to_string());
        }

        let base_commit = non_empty(input.base_commit.clone()).unwrap_or_default();
        let content_hash = self
            .file_content_hash_for_tick(
                &input.scope,
                input.device_id.as_deref(),
                &input.path,
                side,
                non_empty(input.base_commit),
            )
            .await?;

        let now = crate::state::unix_now();
        let store = {
            let relay = self.relay.read().await;
            relay.usage_store.clone()
        };
        store.upsert_file_review_tick(
            &input.scope,
            &input.path,
            side,
            &base_commit,
            &content_hash,
            now,
        )?;

        Ok(FileReviewTickView {
            path: input.path,
            side,
            base_commit: if base_commit.is_empty() {
                None
            } else {
                Some(base_commit)
            },
            status: FileReviewTickStatus::Current,
            last_tick_at: Some(now),
        })
    }

    async fn review_tick_view(
        &self,
        scope: &str,
        device_id: Option<&str>,
        row: FileReviewStateRow,
    ) -> Result<FileReviewTickView, String> {
        let base_commit = if row.base_commit.is_empty() {
            None
        } else {
            Some(row.base_commit.clone())
        };
        let current = self
            .file_content_hash_for_tick(scope, device_id, &row.path, row.side, base_commit.clone())
            .await
            .ok();
        let status = file_review_tick_status(row.content_hash.as_deref(), current.as_deref());
        Ok(FileReviewTickView {
            path: row.path,
            side: row.side,
            base_commit,
            status,
            last_tick_at: row.last_tick_at,
        })
    }

    async fn file_content_hash_for_tick(
        &self,
        scope: &str,
        device_id: Option<&str>,
        path: &str,
        side: CommentSide,
        base_commit: Option<String>,
    ) -> Result<String, String> {
        let mut keys = std::collections::HashSet::new();
        keys.insert(crate::usage::review_comments::AnchorFileKey {
            path: path.to_string(),
            side,
            base_commit: base_commit.clone(),
        });
        let contents = self
            .load_review_anchor_files(scope, device_id, &keys)
            .await?;
        let key = crate::usage::review_comments::AnchorFileKey {
            path: path.to_string(),
            side,
            base_commit,
        };
        match contents.get(&key) {
            Some(Some(file)) => Ok(file_content_hash(&file.content)),
            Some(None) | None => Err(format!("could not read {path} for review tick")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_status_distinguishes_none_current_and_stale() {
        assert_eq!(
            file_review_tick_status(None, Some("abc")),
            FileReviewTickStatus::None
        );
        assert_eq!(
            file_review_tick_status(Some(""), Some("abc")),
            FileReviewTickStatus::None
        );
        assert_eq!(
            file_review_tick_status(Some("abc"), Some("abc")),
            FileReviewTickStatus::Current
        );
        assert_eq!(
            file_review_tick_status(Some("abc"), Some("def")),
            FileReviewTickStatus::Stale
        );
        assert_eq!(
            file_review_tick_status(Some("abc"), None),
            FileReviewTickStatus::Stale
        );
    }

    #[test]
    fn content_hash_is_full_sha256_hex() {
        let hash = file_content_hash("fn main() {}\n");
        assert_eq!(hash.len(), 64);
        assert_eq!(hash, file_content_hash("fn main() {}\n"));
        assert_ne!(hash, file_content_hash("fn main() { }\n"));
    }
}
