//! Public-build stand-in for [`relay_api::ReviewAnchors`].
//!
//! Comments still store and display their original anchor text; re-location status
//! is [`AnchorStatus::Unavailable`], never a fabricated [`AnchorStatus::Anchored`].

use relay_api::{AnchorStatus, LineAnchor, RelocateOutcome, ReviewAnchors};

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct UnavailableReviewAnchors;

impl ReviewAnchors for UnavailableReviewAnchors {
    fn can_anchor(&self) -> bool {
        false
    }

    fn relocate(&self, _content: &str, anchors: &[LineAnchor]) -> Vec<RelocateOutcome> {
        anchors
            .iter()
            .map(|_| RelocateOutcome::unavailable())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use relay_api::AnchorStatus;

    struct FabricatingRelocator;

    impl ReviewAnchors for FabricatingRelocator {
        fn relocate(&self, _content: &str, anchors: &[LineAnchor]) -> Vec<RelocateOutcome> {
            anchors
                .iter()
                .map(|anchor| RelocateOutcome {
                    status: AnchorStatus::Anchored,
                    line: Some(anchor.line),
                })
                .collect()
        }
    }

    #[test]
    fn unavailable_review_anchors_cannot_anchor() {
        assert!(!UnavailableReviewAnchors.can_anchor());
    }

    #[test]
    fn public_build_never_fabricates_anchored() {
        let anchors = vec![LineAnchor {
            path: "src/a.ts".to_string(),
            side: relay_api::CommentSide::New,
            line: 1,
            exact: "x".to_string(),
            prefix: String::new(),
            suffix: String::new(),
            line_hash: "h".to_string(),
            window_hash: "w".to_string(),
            base_commit: None,
        }];
        let fabricating = FabricatingRelocator;
        let public = UnavailableReviewAnchors;

        let fabricated = fabricating.relocate("line\n", &anchors);
        assert_eq!(fabricated[0].status, AnchorStatus::Anchored);

        let outcomes = public.relocate("line\n", &anchors);
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].status, AnchorStatus::Unavailable);
        assert_eq!(outcomes[0].line, None);
    }
}
