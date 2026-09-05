//! Token accounting: the ledger the relay never used to keep.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(test)]
mod tests;

/// One turn's worth of tokens, normalized across providers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct TokenUsage {
    /// Uncached input only. NOT the whole prompt — see the module docs.
    pub(crate) input: u64,
    /// Prompt tokens served from cache (Anthropic `cache_read_input_tokens`,
    /// Codex `cachedInputTokens`).
    pub(crate) cached_input: u64,
    /// Prompt tokens written to cache (Anthropic `cache_creation_input_tokens`).
    /// Codex does not report this; it stays 0 rather than being guessed.
    pub(crate) cache_write: u64,
    pub(crate) output: u64,
    /// Reasoning tokens, where the provider separates them (Codex does;
    /// Anthropic folds them into `output`). Tracked apart from `output` only so
    /// the split survives if a report ever wants it — it is already counted in
    /// `total`, so adding it to `output` at read time would double it.
    pub(crate) reasoning_output: u64,
    /// Provider-reported total where available, else the sum of the parts.
    pub(crate) total: u64,
}

impl TokenUsage {
    /// The sum of every *billable* component.
    pub(crate) fn sum_of_parts(&self) -> u64 {
        self.input
            .saturating_add(self.cached_input)
            .saturating_add(self.cache_write)
            .saturating_add(self.output)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.total == 0 && self.sum_of_parts() == 0
    }

    /// Component-wise `self - other`, saturating at zero.
    pub(crate) fn saturating_sub_componentwise(self, other: &Self) -> Self {
        Self {
            input: self.input.saturating_sub(other.input),
            cached_input: self.cached_input.saturating_sub(other.cached_input),
            cache_write: self.cache_write.saturating_sub(other.cache_write),
            output: self.output.saturating_sub(other.output),
            reasoning_output: self.reasoning_output.saturating_sub(other.reasoning_output),
            total: self.total.saturating_sub(other.total),
        }
    }

    pub(crate) fn saturating_add(self, other: Self) -> Self {
        Self {
            input: self.input.saturating_add(other.input),
            cached_input: self.cached_input.saturating_add(other.cached_input),
            cache_write: self.cache_write.saturating_add(other.cache_write),
            output: self.output.saturating_add(other.output),
            reasoning_output: self.reasoning_output.saturating_add(other.reasoning_output),
            total: self.total.saturating_add(other.total),
        }
    }
}

fn u64_at(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// Parse one Codex `TokenUsageBreakdown`.
fn codex_breakdown(value: &Value) -> TokenUsage {
    let cached_input = u64_at(value, "cachedInputTokens");
    // Codex reports `cachedInputTokens` as a subset of `inputTokens` — its
    // `totalTokens` is input + output, not input + cached + output. Normalize
    // to this module's cross-provider contract, where `input` is only the
    // uncached remainder and every billable bucket is disjoint.
    let input = u64_at(value, "inputTokens").saturating_sub(cached_input);
    let output = u64_at(value, "outputTokens");
    let reasoning_output = u64_at(value, "reasoningOutputTokens");
    let total = u64_at(value, "totalTokens");
    let mut usage = TokenUsage {
        input,
        cached_input,
        cache_write: 0,
        output,
        reasoning_output,
        total,
    };
    if usage.total == 0 {
        usage.total = usage.sum_of_parts();
    }
    usage
}

/// Anthropic usage, as it arrives on the worker's `done` event.
pub(crate) fn claude_turn_usage(value: &Value) -> TokenUsage {
    let mut usage = TokenUsage {
        input: u64_at(value, "input_tokens"),
        cached_input: u64_at(value, "cache_read_input_tokens"),
        cache_write: u64_at(value, "cache_creation_input_tokens"),
        output: u64_at(value, "output_tokens"),
        reasoning_output: 0,
        total: 0,
    };
    usage.total = usage.sum_of_parts();
    usage
}

/// One entry of the Agent SDK's `modelUsage` map.
pub(crate) fn claude_model_usage(value: &Value) -> TokenUsage {
    let mut usage = TokenUsage {
        input: u64_at(value, "inputTokens"),
        cached_input: u64_at(value, "cacheReadInputTokens"),
        cache_write: u64_at(value, "cacheCreationInputTokens"),
        output: u64_at(value, "outputTokens"),
        reasoning_output: 0,
        total: 0,
    };
    usage.total = usage.sum_of_parts();
    usage
}

/// Turns Codex's cumulative `total` into per-request deltas.
#[derive(Debug, Default)]
pub(crate) struct CodexUsageTracker {
    seen_total: HashMap<String, TokenUsage>,
}

impl CodexUsageTracker {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Consume one `thread/tokenUsage/updated` params object.
    pub(crate) fn observe(&mut self, params: &Value) -> Option<CodexUsageObservation> {
        let thread_id = params.get("threadId").and_then(Value::as_str)?.to_string();
        let turn_id = params
            .get("turnId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let token_usage = params.get("tokenUsage")?;

        let last = token_usage.get("last").map(codex_breakdown);
        let total = token_usage.get("total").map(codex_breakdown);
        let context_window = token_usage
            .get("modelContextWindow")
            .and_then(Value::as_u64);

        let baseline = self.seen_total.get(&thread_id).copied();
        let usage = match (total, baseline) {
            // No baseline: a resumed thread's `total` predates this process.
            (Some(total), None) => {
                self.seen_total.insert(thread_id.clone(), total);
                last.unwrap_or(total)
            }
            // `total` went backwards — compaction reset the counter.
            (Some(total), Some(previous)) if total.total < previous.total => {
                self.seen_total.insert(thread_id.clone(), total);
                last.unwrap_or(total)
            }
            (Some(total), Some(previous)) => {
                self.seen_total.insert(thread_id.clone(), total);
                let delta = total.saturating_sub_componentwise(&previous);
                match last {
                    Some(last) if last.total == delta.total => last,
                    _ => delta,
                }
            }
            // No `total` at all: `last` is all we have.
            (None, _) => last?,
        };

        // An all-zero delta is still an OBSERVATION: the provider answered, and
        // it answered "nothing". Dropping it here would make it indistinguishable
        // from a turn that reported no figure at all, and the reviewer gate
        // (`state/app/team.rs`) has to tell those apart. Billing is unaffected —
        // `record_token_usage` drops empty usage before it writes a ledger row.
        Some(CodexUsageObservation {
            thread_id,
            turn_id,
            usage,
            context_window,
            thread_total: total.map(|value| value.total),
        })
    }
}

/// One billable observation drawn from a Codex usage notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexUsageObservation {
    pub(crate) thread_id: String,
    pub(crate) turn_id: Option<String>,
    /// The delta to bill — never the cumulative total.
    pub(crate) usage: TokenUsage,
    /// The model's context window, when reported. This is the signal the team
    /// runner's TL re-seed heuristics were written without.
    pub(crate) context_window: Option<u64>,
    /// The thread's cumulative total after this observation, for display.
    pub(crate) thread_total: Option<u64>,
}

/// Turns the Claude SDK result message's session-cumulative `modelUsage` and
/// `total_cost_usd` into per-turn deltas, as `CodexUsageTracker` does for Codex.
#[derive(Debug, Default)]
pub(crate) struct ClaudeUsageTracker {
    seen: HashMap<String, ClaudeSeenTotals>,
}

#[derive(Debug, Default, Clone)]
struct ClaudeSeenTotals {
    per_model: HashMap<String, TokenUsage>,
    cost_usd: f64,
}

impl ClaudeUsageTracker {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Consume one worker `done` payload. `None` means nothing new was spent —
    /// a re-reported snapshot must not become a second ledger row.
    pub(crate) fn observe(
        &mut self,
        thread_id: &str,
        payload: &Value,
    ) -> Option<ClaudeUsageObservation> {
        let models = payload.get("model_usage").and_then(Value::as_object)?;
        let seen = self.seen.entry(thread_id.to_string()).or_default();

        let mut per_model = Vec::new();
        for (model, value) in models {
            let cumulative = claude_model_usage(value);
            let previous = seen.per_model.get(model).copied().unwrap_or_default();
            // Backwards means a different session reusing the thread id: take
            // the new figure whole rather than saturating a negative to zero.
            let delta = if cumulative.total < previous.total {
                cumulative
            } else {
                cumulative.saturating_sub_componentwise(&previous)
            };
            seen.per_model.insert(model.clone(), cumulative);
            if !delta.is_empty() {
                per_model.push((model.clone(), delta));
            }
        }

        let cost_usd = payload
            .get("total_cost_usd")
            .and_then(Value::as_f64)
            .map(|cumulative| {
                let delta = if cumulative < seen.cost_usd {
                    cumulative
                } else {
                    cumulative - seen.cost_usd
                };
                seen.cost_usd = cumulative;
                delta
            });

        if per_model.is_empty() {
            return None;
        }
        Some(ClaudeUsageObservation {
            per_model,
            cost_usd,
        })
    }
}

/// One billable observation drawn from a Claude `done` payload.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ClaudeUsageObservation {
    /// Per-model deltas to bill — never the session-cumulative figures.
    pub(crate) per_model: Vec<(String, TokenUsage)>,
    pub(crate) cost_usd: Option<f64>,
}

pub(crate) mod budget;
pub(crate) mod pricing;
pub(crate) mod report;
pub(crate) mod review_anchors;
pub(crate) mod review_comments;
pub(crate) mod store;
