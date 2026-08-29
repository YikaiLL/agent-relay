//! Line-comment persistence and grouped re-location on read.

use std::collections::HashMap;

use relay_api::{LineAnchor, RelocateOutcome, ReviewAnchors, ReviewComment, ReviewCommentView};

/// Groups comments for a single file read + batch re-location.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct AnchorFileKey {
    pub path: String,
    pub side: relay_api::CommentSide,
    pub base_commit: Option<String>,
}

pub(crate) fn anchor_file_key(comment: &ReviewComment) -> AnchorFileKey {
    AnchorFileKey {
        path: comment.anchor.path.clone(),
        side: comment.anchor.side,
        base_commit: comment.anchor.base_commit.clone(),
    }
}

/// Text read for one anchor group. `None` means the file could not be read at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AnchorFileContent {
    pub content: String,
    pub truncated: bool,
}

impl AnchorFileContent {
    pub(crate) fn line_count(&self) -> u32 {
        if self.content.is_empty() {
            0
        } else {
            self.content.matches('\n').count() as u32 + 1
        }
    }
}

pub(crate) fn anchor_readable(file: &AnchorFileContent, line: u32) -> bool {
    !file.truncated || line <= file.line_count()
}

/// Re-locate every comment, reading each file's content at most once.
pub(crate) fn relocate_comments_grouped(
    comments: Vec<ReviewComment>,
    contents: &HashMap<AnchorFileKey, Option<AnchorFileContent>>,
    relocator: &dyn ReviewAnchors,
) -> Vec<ReviewCommentView> {
    let mut groups: HashMap<AnchorFileKey, Vec<ReviewComment>> = HashMap::new();
    for comment in comments {
        groups
            .entry(anchor_file_key(&comment))
            .or_default()
            .push(comment);
    }

    let mut views = Vec::new();
    for (key, group) in groups {
        match contents.get(&key) {
            None | Some(None) => {
                for comment in group {
                    views.push(ReviewCommentView {
                        comment,
                        relocation: RelocateOutcome::unavailable(),
                    });
                }
            }
            Some(Some(file)) => {
                let (readable, unreadable): (Vec<_>, Vec<_>) = group
                    .into_iter()
                    .partition(|comment| anchor_readable(file, comment.anchor.line));
                for comment in unreadable {
                    views.push(ReviewCommentView {
                        comment,
                        relocation: RelocateOutcome::unavailable(),
                    });
                }
                if readable.is_empty() {
                    continue;
                }
                let anchors: Vec<LineAnchor> = readable
                    .iter()
                    .map(|comment| comment.anchor.clone())
                    .collect();
                let outcomes = relocator.relocate(&file.content, &anchors);
                for (comment, relocation) in readable.into_iter().zip(outcomes) {
                    views.push(ReviewCommentView {
                        comment,
                        relocation,
                    });
                }
            }
        }
    }

    views.sort_by(|left, right| {
        left.comment
            .anchor
            .path
            .cmp(&right.comment.anchor.path)
            .then(left.comment.anchor.line.cmp(&right.comment.anchor.line))
            .then(left.comment.id.cmp(&right.comment.id))
    });
    views
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::store::UsageStore;
    use relay_api::{
        AnchorStatus, CommentSide, RelocateOutcome, ReviewAuthorKind, ReviewCommentStatus,
    };
    use tempfile::TempDir;

    struct RecordingRelocator {
        batch_sizes: std::sync::Mutex<Vec<usize>>,
    }

    impl ReviewAnchors for RecordingRelocator {
        fn relocate(&self, _content: &str, anchors: &[LineAnchor]) -> Vec<RelocateOutcome> {
            self.batch_sizes.lock().expect("lock").push(anchors.len());
            anchors
                .iter()
                .map(|anchor| RelocateOutcome {
                    status: AnchorStatus::Anchored,
                    line: Some(anchor.line),
                })
                .collect()
        }
    }

    fn sample_comment(id: &str, path: &str, line: u32) -> ReviewComment {
        ReviewComment {
            id: id.to_string(),
            scope: "team_run:run-1".to_string(),
            author_kind: ReviewAuthorKind::Human,
            author_role: None,
            body: "nit".to_string(),
            status: ReviewCommentStatus::Open,
            anchor: LineAnchor {
                path: path.to_string(),
                side: CommentSide::New,
                line,
                exact: format!("line-{line}"),
                prefix: String::new(),
                suffix: String::new(),
                line_hash: format!("hash-{line}"),
                window_hash: format!("window-{line}"),
                base_commit: None,
            },
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn grouped_relocation_batches_by_file() {
        let relocator = RecordingRelocator {
            batch_sizes: std::sync::Mutex::new(Vec::new()),
        };
        let mut contents = HashMap::new();
        contents.insert(
            anchor_file_key(&sample_comment("a", "src/a.ts", 1)),
            readable("line-1\n"),
        );
        contents.insert(
            anchor_file_key(&sample_comment("b", "src/b.ts", 2)),
            readable("line-2\n"),
        );

        let comments = vec![
            sample_comment("a", "src/a.ts", 1),
            sample_comment("b", "src/b.ts", 2),
            sample_comment("c", "src/a.ts", 3),
        ];
        let views = relocate_comments_grouped(comments, &contents, &relocator);
        assert_eq!(views.len(), 3);
        let batches = relocator.batch_sizes.lock().expect("lock");
        assert_eq!(batches.len(), 2);
        assert!(batches.contains(&2));
        assert!(batches.contains(&1));
    }

    #[test]
    fn review_comment_store_round_trips() {
        let dir = TempDir::new().expect("tempdir");
        let store = UsageStore::open(&dir.path().join("sealwire.db"));
        let comment = sample_comment("c-1", "src/app.ts", 4);
        store
            .insert_review_comment(&comment)
            .expect("insert comment");
        let loaded = store
            .list_review_comments_by_scope("team_run:run-1")
            .expect("list");
        assert_eq!(loaded, vec![comment]);
    }

    struct OrphanOnEmptyRelocator {
        calls: std::sync::Mutex<usize>,
    }

    impl ReviewAnchors for OrphanOnEmptyRelocator {
        fn relocate(&self, content: &str, anchors: &[LineAnchor]) -> Vec<RelocateOutcome> {
            *self.calls.lock().expect("lock") += 1;
            if content.is_empty() {
                return anchors
                    .iter()
                    .map(|_| RelocateOutcome {
                        status: AnchorStatus::Orphaned,
                        line: None,
                    })
                    .collect();
            }
            anchors
                .iter()
                .map(|anchor| RelocateOutcome {
                    status: AnchorStatus::Anchored,
                    line: Some(anchor.line),
                })
                .collect()
        }
    }

    fn readable(content: &str) -> Option<AnchorFileContent> {
        Some(AnchorFileContent {
            content: content.to_string(),
            truncated: false,
        })
    }

    #[test]
    fn unreadable_file_yields_unavailable_not_orphaned() {
        let relocator = OrphanOnEmptyRelocator {
            calls: std::sync::Mutex::new(0),
        };
        let key = anchor_file_key(&sample_comment("a", "src/missing.ts", 1));
        let mut contents = HashMap::new();
        contents.insert(key, None);

        let views = relocate_comments_grouped(
            vec![sample_comment("a", "src/missing.ts", 1)],
            &contents,
            &relocator,
        );
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].relocation.status, AnchorStatus::Unavailable);
        assert_eq!(*relocator.calls.lock().expect("lock"), 0);
    }

    #[test]
    fn truncated_file_yields_unavailable_for_anchors_beyond_the_read_portion() {
        let relocator = RecordingRelocator {
            batch_sizes: std::sync::Mutex::new(Vec::new()),
        };
        let key = anchor_file_key(&sample_comment("a", "src/big.ts", 1));
        let mut contents = HashMap::new();
        contents.insert(
            key,
            Some(AnchorFileContent {
                content: "line-1\nline-2\n".to_string(),
                truncated: true,
            }),
        );

        let views = relocate_comments_grouped(
            vec![
                sample_comment("in-range", "src/big.ts", 2),
                sample_comment("beyond", "src/big.ts", 5),
            ],
            &contents,
            &relocator,
        );
        assert_eq!(views.len(), 2);
        let in_range = views
            .iter()
            .find(|view| view.comment.id == "in-range")
            .expect("in-range view");
        let beyond = views
            .iter()
            .find(|view| view.comment.id == "beyond")
            .expect("beyond view");
        assert_eq!(in_range.relocation.status, AnchorStatus::Anchored);
        assert_eq!(beyond.relocation.status, AnchorStatus::Unavailable);
        assert_eq!(relocator.batch_sizes.lock().expect("lock").len(), 1);
    }

    #[test]
    fn file_review_tick_store_round_trips() {
        let dir = TempDir::new().expect("tempdir");
        let store = UsageStore::open(&dir.path().join("sealwire.db"));
        let hash = "a".repeat(64);
        store
            .upsert_file_review_tick(
                "team_run:run-1",
                "src/app.ts",
                CommentSide::New,
                "",
                &hash,
                100,
            )
            .expect("upsert");
        let rows = store
            .list_file_review_states_by_scope("team_run:run-1")
            .expect("list");
        assert_eq!(
            rows,
            vec![crate::usage::store::FileReviewStateRow {
                path: "src/app.ts".to_string(),
                side: CommentSide::New,
                base_commit: String::new(),
                last_tick_at: Some(100),
                content_hash: Some(hash),
            }]
        );
    }
}
