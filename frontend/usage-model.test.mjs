import test from "node:test";
import assert from "node:assert/strict";

import {
  priceAgeNote,
  cachedShare,
  costLabel,
  deltaPercent,
  formatDelta,
  formatTokens,
  headlineTotal,
  projectWindow,
  providerRows,
  reportState,
  rollupByProvider,
  stackedSeries,
} from "./shared/usage-model.js";

test("tokens format to the compact forms the screen uses", () => {
  assert.equal(formatTokens(2_900_000), "2.9M");
  assert.equal(formatTokens(810_000), "810k");
  assert.equal(formatTokens(470), "470");
  assert.equal(formatTokens(1_000_000), "1M", "a whole million drops the .0");
  assert.equal(formatTokens(128_400_000), "128M", "past 100M the decimal is dropped");
  assert.equal(formatTokens(-1), "—");
  assert.equal(formatTokens(undefined), "—");
});

/// The headline includes cache reads, and the of-which framing is what keeps
/// that from reading as double-counting. See the model header for why.
test("the headline includes cache reads and reports them as a share of itself", () => {
  const usage = { input: 100, cached_input: 1_100, cache_write: 300, output: 500 };
  assert.equal(headlineTotal(usage), 2_000);

  const cached = cachedShare(usage);
  assert.equal(cached.cached, 1_100);
  assert.ok(
    Math.abs(cached.share - 55) < 1e-9,
    "cached is 55% OF the headline, not extra on top"
  );
  assert.ok(cached.meaningful);
});

test("a provider-reported total wins over re-summing the parts", () => {
  // Providers report their own total; trusting it avoids drifting from their
  // billing when a component we do not model appears.
  assert.equal(headlineTotal({ input: 1, output: 1, total: 999 }), 999);
});

test("cached share is silent when nothing was cached", () => {
  assert.equal(cachedShare({ input: 10, output: 5 }).meaningful, false);
});

/// A change from zero is not a percentage. "+∞%" is not a fact about spend.
test("a delta from zero has no percentage", () => {
  assert.equal(deltaPercent(500, 0), null);
  assert.equal(formatDelta(null), "");
});

test("deltas format with the screen's sign conventions", () => {
  assert.equal(formatDelta(deltaPercent(4_100_000, 5_400_000)), "−24%");
  assert.equal(formatDelta(deltaPercent(2_300_000, 2_170_000)), "+6%");
  assert.equal(formatDelta(deltaPercent(100, 100)), "0%");
});

/// THE Cursor case. A provider that cannot report usage must never render as 0,
/// and must not inflate everyone else's share.
test("a provider that reports no usage is listed but excluded from the denominator", () => {
  const { rows, complete } = providerRows({
    providers: [
      { key: "claude_code", reports_usage: true },
      { key: "codex", reports_usage: true },
      { key: "cursor", reports_usage: false },
    ],
    groups: [
      { provider: "claude_code", total: 750 },
      { provider: "codex", total: 250 },
    ],
  });

  const cursor = rows.find((row) => row.key === "cursor");
  assert.equal(cursor.total, null, "null is 'no signal'; 0 would mean 'did nothing'");
  assert.equal(cursor.share, null);

  const claude = rows.find((row) => row.key === "claude_code");
  assert.equal(claude.share, 75, "shares are of what was measured");
  assert.equal(complete, false, "the screen must be able to say the picture is partial");
});

test("silent providers sort last, measured providers by size", () => {
  const { rows } = providerRows({
    providers: [
      { key: "cursor", reports_usage: false },
      { key: "codex", reports_usage: true },
      { key: "claude_code", reports_usage: true },
    ],
    groups: [
      { provider: "codex", total: 100 },
      { provider: "claude_code", total: 900 },
    ],
  });
  assert.deepEqual(
    rows.map((row) => row.key),
    ["claude_code", "codex", "cursor"]
  );
});

test("with no roster, the measured providers are the roster", () => {
  const { rows, complete } = providerRows({
    groups: [{ provider: "codex", total: 10 }],
  });
  assert.equal(rows.length, 1);
  assert.equal(complete, true);
});

/// An estimate rendered as a fact is worse than no number.
test("cost carries its provenance", () => {
  const provider = costLabel({ cost_usd: 28.6, cost_source: "provider" });
  assert.equal(provider.text, "$28.60");
  assert.equal(provider.estimated, false);

  const estimated = costLabel({ cost_usd: 9.8, cost_source: "estimated" });
  assert.equal(estimated.text, "$9.80");
  assert.equal(estimated.estimated, true, "the UI must be able to mark it");

  const none = costLabel({ cost_usd: null, cost_source: "unavailable" });
  assert.equal(none.text, "—", "unavailable is a dash, never $0.00");
});

test("an absent cost is a dash rather than zero", () => {
  assert.equal(costLabel({}).text, "—");
  assert.equal(costLabel().text, "—");
});

test("a projection extrapolates linearly and says when it crosses a cap", () => {
  const halfDay = 12 * 3600 * 1000;
  const day = 24 * 3600 * 1000;
  const projection = projectWindow({
    spent: 2_900_000,
    elapsedMs: halfDay,
    windowMs: day,
    cap: 5_000_000,
  });

  assert.equal(projection.projected, 5_800_000, "double the half-day rate");
  assert.equal(projection.remaining, 2_900_000);
  assert.ok(projection.confident);
  // 5M at 2.9M/12h is reached at ~20.7h into the day.
  assert.ok(projection.exhaustsAt > 20 * 3600 * 1000);
  assert.ok(projection.exhaustsAt < 21 * 3600 * 1000);
});

test("a projection that never reaches the cap reports no exhaustion", () => {
  const day = 24 * 3600 * 1000;
  const projection = projectWindow({
    spent: 500_000,
    elapsedMs: day / 2,
    windowMs: day,
    cap: 5_000_000,
  });
  assert.equal(projection.exhaustsAt, null);
});

/// "Exhausts at 04:12" derived from two turns at 00:05 is a confident lie.
test("a projection early in the window is marked unconfident", () => {
  const day = 24 * 3600 * 1000;
  const projection = projectWindow({
    spent: 100_000,
    elapsedMs: day * 0.02,
    windowMs: day,
    cap: 5_000_000,
  });
  assert.equal(projection.confident, false);
});

test("a projection with no elapsed time does not divide by zero", () => {
  const projection = projectWindow({ spent: 0, elapsedMs: 0, windowMs: 86_400_000 });
  assert.equal(projection.projected, 0);
  assert.equal(projection.confident, false);
});

test("model rows roll up to providers, keeping the model breakdown", () => {
  const rows = rollupByProvider([
    { provider: "claude_code", model: "claude-opus-5", total: 900 },
    { provider: "claude_code", model: "claude-haiku-4-5", total: 100 },
    { provider: "codex", model: "gpt-5", total: 400 },
  ]);

  assert.deepEqual(
    rows.map((row) => row.provider),
    ["claude_code", "codex"]
  );
  assert.equal(rows[0].total, 1_000);
  assert.deepEqual(
    rows[0].models.map((model) => model.model),
    ["claude-opus-5", "claude-haiku-4-5"],
    "models sort by size within the provider"
  );
});

test("a provider that never named the model keeps its own bucket", () => {
  const rows = rollupByProvider([
    { provider: "cursor", model: null, total: 50 },
    { provider: "cursor", model: "composer-1", total: 10 },
  ]);
  assert.equal(rows[0].models.length, 2);
  assert.equal(rows[0].models[0].model, null);
});

/// A day with no usage is a fact about the week. Skipping it draws fourteen
/// bars over a twelve-day axis.
test("empty buckets are materialised rather than skipped", () => {
  const series = stackedSeries({
    providers: [
      { key: "claude_code", reports_usage: true },
      { key: "codex", reports_usage: true },
    ],
    buckets: [
      { key: "2026-08-13", groups: [{ provider: "claude_code", total: 100 }] },
      { key: "2026-08-14", groups: [] },
      { key: "2026-08-15", groups: [{ provider: "codex", total: 50 }] },
    ],
  });

  assert.equal(series.length, 3);
  assert.equal(series[1].total, 0, "the quiet day is still a bar");
  assert.deepEqual(series[1].byProvider, { claude_code: 0, codex: 0 });
  assert.equal(series[2].byProvider.codex, 50);
});

test("a silent provider contributes no band to the stack", () => {
  const series = stackedSeries({
    providers: [
      { key: "codex", reports_usage: true },
      { key: "cursor", reports_usage: false },
    ],
    buckets: [{ key: "d", groups: [{ provider: "codex", total: 7 }] }],
  });
  assert.deepEqual(Object.keys(series[0].byProvider), ["codex"]);
});

/// A degraded ledger is not a quiet day, and must not render as one forever.
test("a disabled ledger is distinguishable from an empty one", () => {
  assert.equal(reportState(null), "loading");
  assert.equal(reportState({ enabled: false }), "disabled");
  assert.equal(reportState({ enabled: true, totals: {} }), "empty");
  assert.equal(reportState({ enabled: true, totals: { total: 5 } }), "ready");
});

// --- price table age -------------------------------------------------------
//
// Prices are compiled into the binary and `npx sealwire` does not update
// itself, so the cost column can quote year-old list prices with nothing on
// screen admitting it. These pin when we say so and when we stay quiet.

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-26T12:00:00Z");

test("a recent price table needs no caveat", () => {
  assert.equal(priceAgeNote("2026-08-26", NOW), null);
  assert.equal(priceAgeNote("2026-07-01", NOW), null);
  // The day before the threshold is still quiet.
  assert.equal(priceAgeNote(new Date(NOW - 89 * DAY).toISOString().slice(0, 10), NOW), null);
});

test("past a season the footnote says how old the prices are", () => {
  const note = priceAgeNote(new Date(NOW - 120 * DAY).toISOString().slice(0, 10), NOW);
  assert.match(note, /4 months old/);
  assert.match(note, /update sealwire/);
});

test("past a year it stops counting months and says so", () => {
  const note = priceAgeNote(new Date(NOW - 500 * DAY).toISOString().slice(0, 10), NOW);
  assert.match(note, /over a year old/);
  assert.doesNotMatch(note, /\d+ months/);
});

test("an unreadable date is not evidence of staleness", () => {
  // Guessing would put a warning under a column that may be perfectly current.
  for (const bad of [null, undefined, "", "yesterday", "2026-8-6", 20260826, {}]) {
    assert.equal(priceAgeNote(bad, NOW), null, `${JSON.stringify(bad)} should be quiet`);
  }
});
