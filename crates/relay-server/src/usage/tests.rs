use serde_json::json;

use super::*;

/// One Codex `thread/tokenUsage/updated` params object, with `last` describing
/// the request that just finished and `total` the thread's running sum.
fn codex_notification(thread_id: &str, turn_id: &str, last: u64, total: u64) -> Value {
    json!({
        "threadId": thread_id,
        "turnId": turn_id,
        "tokenUsage": {
            "last": {
                "inputTokens": last,
                "cachedInputTokens": 0,
                "outputTokens": 0,
                "reasoningOutputTokens": 0,
                "totalTokens": last,
            },
            "total": {
                "inputTokens": total,
                "cachedInputTokens": 0,
                "outputTokens": 0,
                "reasoningOutputTokens": 0,
                "totalTokens": total,
            },
            "modelContextWindow": 272_000,
        }
    })
}

/// `tokenUsage.total` is cumulative FOR THE THREAD, not for the request that
/// triggered the notification. Summing it bills the triangular number instead
/// of the real spend — ten 1k requests read as 55k rather than 10k.
///
/// This is the single most expensive way to get the ledger wrong, because the
/// number stays plausible: it is the right order of magnitude, monotonic, and
/// wrong by a factor that grows with conversation length.
#[test]
fn a_ten_turn_codex_thread_bills_ten_turns_not_fifty_five() {
    let mut tracker = CodexUsageTracker::new();
    let mut billed = 0;

    for turn in 1..=10u64 {
        let observation = tracker
            .observe(&codex_notification(
                "thread-a",
                &format!("turn-{turn}"),
                1_000,
                turn * 1_000,
            ))
            .expect("every notification carries billable usage");
        billed += observation.usage.total;
    }

    assert_eq!(
        billed, 10_000,
        "ten 1k requests must bill 10k; {billed} means `total` was summed \
         instead of differenced"
    );
}

/// A thread the relay resumes already has a `total` accumulated before this
/// process ever saw it. Differencing against a zero baseline would bill that
/// entire history as if it happened now.
#[test]
fn a_resumed_codex_thread_does_not_bill_its_history_on_the_first_notification() {
    let mut tracker = CodexUsageTracker::new();

    let first = tracker
        .observe(&codex_notification("resumed", "turn-1", 1_200, 840_000))
        .expect("billable");
    assert_eq!(
        first.usage.total, 1_200,
        "the first notification for a thread bills only the request that just \
         ran, not the thread's pre-existing total"
    );

    let second = tracker
        .observe(&codex_notification("resumed", "turn-2", 800, 840_800))
        .expect("billable");
    assert_eq!(second.usage.total, 800, "subsequent deltas resume normally");
}

/// Codex compaction can reset the cumulative counter. A backwards `total` must
/// not silently drop the request that came with it.
#[test]
fn a_codex_total_that_goes_backwards_rebaselines_instead_of_dropping_usage() {
    let mut tracker = CodexUsageTracker::new();
    tracker
        .observe(&codex_notification("compacted", "turn-1", 5_000, 50_000))
        .expect("billable");

    let after_compaction = tracker
        .observe(&codex_notification("compacted", "turn-2", 900, 900))
        .expect("a reset total still carries a billable request");
    assert_eq!(after_compaction.usage.total, 900);

    let next = tracker
        .observe(&codex_notification("compacted", "turn-3", 300, 1_200))
        .expect("billable");
    assert_eq!(
        next.usage.total, 300,
        "the tracker re-baselined on the reset rather than differencing \
         against the pre-compaction total"
    );
}

/// A dropped notification is folded into the next delta rather than lost —
/// this is the whole reason to difference `total` instead of summing `last`.
#[test]
fn a_missed_codex_notification_is_recovered_by_the_next_delta() {
    let mut tracker = CodexUsageTracker::new();
    tracker
        .observe(&codex_notification("gappy", "turn-1", 1_000, 1_000))
        .expect("billable");
    // turn-2 (another 1_000) never arrives.
    let third = tracker
        .observe(&codex_notification("gappy", "turn-3", 1_000, 3_000))
        .expect("billable");

    assert_eq!(
        third.usage.total, 2_000,
        "the delta covers the gap; summing `last` would have billed 1_000 and \
         lost the missed request forever"
    );
}

/// Two threads must not share a baseline.
#[test]
fn codex_baselines_are_per_thread() {
    let mut tracker = CodexUsageTracker::new();
    tracker
        .observe(&codex_notification("a", "turn-1", 1_000, 1_000))
        .expect("billable");
    tracker
        .observe(&codex_notification("b", "turn-1", 7_000, 7_000))
        .expect("billable");

    let a_second = tracker
        .observe(&codex_notification("a", "turn-2", 500, 1_500))
        .expect("billable");
    assert_eq!(
        a_second.usage.total, 500,
        "thread `a` differenced against `b`'s total"
    );
}

/// For Anthropic usage, `input_tokens` is the UNCACHED REMAINDER, not the
/// prompt. The real prompt is `input + cache_read + cache_creation`.
///
/// Folding the cached fields into `input` loses the distinction that makes the
/// number worth reporting at all — cache reads cost roughly a tenth of fresh
/// input and cache writes rather more, so a breakdown that has already summed
/// them can never be re-weighted. Dropping them instead is worse still: a
/// coding agent is the most cache-heavy workload there is, so the headline
/// figure would under-report by most of the real consumption.
#[test]
fn cached_input_is_not_folded_into_input_tokens() {
    let usage = claude_turn_usage(&json!({
        "input_tokens": 100,
        "cache_read_input_tokens": 9_000,
        "cache_creation_input_tokens": 500,
        "output_tokens": 200,
    }));

    assert_eq!(
        usage.input, 100,
        "`input` must stay the uncached remainder the provider reported"
    );
    assert_eq!(
        usage.cached_input, 9_000,
        "cache reads must survive as their own field"
    );
    assert_eq!(
        usage.cache_write, 500,
        "cache writes must survive as their own field"
    );
    assert_eq!(usage.output, 200);
    assert_eq!(
        usage.total, 9_800,
        "the total is the whole prompt plus output, not just the uncached part"
    );
}

/// The breakdown has to survive far enough to be reported, so a round trip
/// through serde must not quietly collapse it either.
#[test]
fn the_cache_breakdown_survives_serialization() {
    let usage = claude_turn_usage(&json!({
        "input_tokens": 10,
        "cache_read_input_tokens": 20,
        "cache_creation_input_tokens": 30,
        "output_tokens": 40,
    }));
    let encoded = serde_json::to_string(&usage).expect("serializes");
    let decoded: TokenUsage = serde_json::from_str(&encoded).expect("round trips");
    assert_eq!(decoded, usage);
    assert_eq!(decoded.cached_input, 20);
    assert_eq!(decoded.cache_write, 30);
}

/// Providers that report reasoning tokens count them inside `output` too, so
/// the sum must not add them a second time.
#[test]
fn reasoning_output_is_a_breakdown_hint_not_an_addend() {
    let usage = TokenUsage {
        input: 100,
        cached_input: 0,
        cache_write: 0,
        output: 500,
        reasoning_output: 400,
        total: 600,
    };
    assert_eq!(
        usage.sum_of_parts(),
        600,
        "reasoning tokens are already inside `output`; adding them double-counts"
    );
}

/// A notification with no usage at all is not a zero-token turn worth a row.
#[test]
fn an_empty_codex_notification_bills_nothing() {
    let mut tracker = CodexUsageTracker::new();
    let observed = tracker.observe(&json!({
        "threadId": "quiet",
        "turnId": "turn-1",
        "tokenUsage": {
            "last": { "totalTokens": 0 },
            "total": { "totalTokens": 0 },
        }
    }));
    assert!(
        observed.is_none(),
        "a zero observation must not become a ledger row"
    );
}

/// The context window is the signal the team runner's TL re-seed heuristics
/// were written without ("no token/usage signal anywhere"). Carry it through.
#[test]
fn the_context_window_is_carried_through() {
    let mut tracker = CodexUsageTracker::new();
    let observation = tracker
        .observe(&codex_notification("ctx", "turn-1", 10, 10))
        .expect("billable");
    assert_eq!(observation.context_window, Some(272_000));
}
