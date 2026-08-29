//! Line-comment records and the re-location seam.
//!
//! The anchor **record** and outcome **states** are public so SQLite and routes
//! can serialize them without a private build. Re-location itself — the judgement
//! of whether a stored anchor is still `Anchored`, `Moved`, etc. — lives behind
//! [`ReviewAnchors`] and is implemented only in the private crate.

use serde::{Deserialize, Serialize};

/// Lines of context above and below the anchored line when hashing. Shared
/// between the stored anchor and the private re-locator.
pub const WINDOW_CONTEXT_LINES: usize = 2;

/// Outcome of re-locating one stored anchor against current file content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnchorStatus {
    /// Line and window both match at the recorded line.
    Anchored,
    /// Line and window match together at a different line.
    Moved,
    /// The commented line is still there; its surroundings changed.
    ContextChanged,
    /// Several equally good candidates — do not guess.
    Ambiguous,
    /// The commented line no longer appears in the file.
    Orphaned,
    /// A public build has no private re-location implementation.
    Unavailable,
}

/// Which side of a diff the anchor was written on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommentSide {
    Old,
    New,
}

impl CommentSide {
    pub fn as_str(self) -> &'static str {
        match self {
            CommentSide::Old => "old",
            CommentSide::New => "new",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "old" => Some(CommentSide::Old),
            "new" => Some(CommentSide::New),
            _ => None,
        }
    }
}

/// The text-and-hash half of a line anchor (W3C TextQuoteSelector + position).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineAnchor {
    pub path: String,
    pub side: CommentSide,
    pub line: u32,
    pub exact: String,
    pub prefix: String,
    pub suffix: String,
    pub line_hash: String,
    pub window_hash: String,
    /// Required for [`CommentSide::Old`]; meaningless for the new side.
    pub base_commit: Option<String>,
}

/// Result of matching one [`LineAnchor`] against a file's current text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelocateOutcome {
    pub status: AnchorStatus,
    /// The line where the anchor was found, if any.
    pub line: Option<u32>,
}

impl RelocateOutcome {
    pub fn unavailable() -> Self {
        Self {
            status: AnchorStatus::Unavailable,
            line: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewAuthorKind {
    Human,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewCommentStatus {
    Open,
    Resolved,
    HandedBack,
    Dismissed,
}

/// One durable line comment, as stored in SQLite and returned on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewComment {
    pub id: String,
    /// `"team_run:<id>"` | `"thread:<id>"`.
    pub scope: String,
    pub author_kind: ReviewAuthorKind,
    pub author_role: Option<String>,
    pub body: String,
    pub status: ReviewCommentStatus,
    pub anchor: LineAnchor,
    pub created_at: u64,
    pub updated_at: u64,
}

/// A comment plus the outcome of re-locating its anchor on read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewCommentView {
    pub comment: ReviewComment,
    pub relocation: RelocateOutcome,
}

/// Whether a per-file review tick still matches the file the user saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileReviewTickStatus {
    /// No tick recorded for this file key.
    None,
    /// The stored fingerprint matches current file contents.
    Current,
    /// A tick exists but the file has changed since.
    Stale,
}

/// One file's review tick as returned on read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileReviewTickView {
    pub path: String,
    pub side: CommentSide,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    pub status: FileReviewTickStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_tick_at: Option<u64>,
}

/// Private judgement over stored anchors. The public relay holds an implementation
/// when built with the private crate; otherwise every outcome is
/// [`AnchorStatus::Unavailable`].
pub trait ReviewAnchors: Send + Sync {
    /// Whether this build can compute anchor quotes on create. Public stand-ins
    /// return `false`; the private implementation returns `true`.
    fn can_anchor(&self) -> bool {
        true
    }

    /// Re-locate every anchor in `anchors` against the same `content`.
    ///
    /// Batched so callers read each file once and resolve all of its anchors in
    /// one pass — the expensive part (reading the file) stays on the public side.
    fn relocate(&self, content: &str, anchors: &[LineAnchor]) -> Vec<RelocateOutcome>;
}
