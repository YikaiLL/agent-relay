// Smoke coverage for the Usage screen: it must render the fixture without
// throwing, surface the three bucket tabs, and keep a silent provider out of
// the "0 tokens" lie.

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { USAGE_FIXTURE } from "./shared/usage-fixture.js";
import { UsageReportScreen, dayFocus } from "./shared/usage-report-react.js";
import { stackedSeries } from "./shared/usage-model.js";

const h = React.createElement;

test("day view renders the fixture headline and provider roster", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report: USAGE_FIXTURE, bucket: "day" })
  );
  assert.match(html, /Spent today/);
  assert.match(html, /2\.9M/);
  assert.match(html, /Claude/);
  assert.match(html, /Codex/);
  assert.match(html, /Cursor/);
  assert.match(html, /Usage not reported/);
  assert.match(html, /\d+% of it came from cache/);
  assert.doesNotMatch(html, /not counted/);
});

test("week tab swaps the centre for the provider cost table", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report: USAGE_FIXTURE, bucket: "week" })
  );
  assert.match(html, /so far this week/);
  assert.match(html, /This week by provider/);
  assert.match(html, /Cost estimated from list prices/);
});

test("disabled ledger is not an empty day", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report: { enabled: false }, bucket: "day" })
  );
  assert.match(html, /Usage unavailable/);
  assert.doesNotMatch(html, /No usage yet/);
});

test("loading state shows before the first report arrives", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report: null, loading: true, bucket: "day" })
  );
  assert.match(html, /Loading/);
});

test("a fetch error is distinct from an empty ledger", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report: null, error: "boom", bucket: "day" })
  );
  assert.match(html, /Could not load usage/);
  assert.match(html, /boom/);
});

test("day chart uses compact axis labels and hides unused Fake", () => {
  const report = {
    enabled: true,
    daily_cap: 5_000_000,
    providers: [
      { key: "claude_code", label: "Claude", reports_usage: true },
      { key: "codex", label: "Codex", reports_usage: true },
      { key: "cursor", label: "Cursor", reports_usage: false },
      { key: "fake", label: "Fake", reports_usage: true },
    ],
    totals: { total: 3_000_000, cached_input: 500_000, input: 1_000_000, output: 1_500_000 },
    today: {
      since: 1_787_702_400,
      until: 1_787_702_400 + 14 * 3600,
      totals: { total: 2_900_000 },
      groups: [
        { provider: "claude_code", total: 1_600_000 },
        { provider: "codex", total: 800_000 },
      ],
      compare_totals: { total: 3_500_000 },
    },
    by_role: [{ total: 2_900_000, share: 100, turns: 3 }],
    top_tasks: [],
    buckets: [
      {
        key: "2026-08-13",
        groups: [{ provider: "claude_code", total: 1_000_000 }],
      },
      {
        key: "2026-08-14",
        groups: [{ provider: "claude_code", total: 1_200_000 }],
      },
      {
        key: "2026-08-26",
        groups: [
          { provider: "claude_code", total: 1_600_000 },
          { provider: "codex", total: 800_000 },
        ],
      },
    ],
  };
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report, bucket: "day" })
  );
  assert.doesNotMatch(html, /2026-08-/);
  assert.match(html, /class="usage-chart-labels"[^>]*>[\s\S]*?>13</);
  assert.match(html, />Today</);
  assert.doesNotMatch(html, />Fake</);
  assert.doesNotMatch(html, /unattributed/);
  assert.match(html, /Daily spend</);
  assert.match(html, /over \d+ days/);
  assert.match(html, /8\/13 – 8\/26/);
  assert.match(html, /When the quota runs out/);
});

test("provider deltas and today attribution render from live-shaped payload", () => {
  const report = {
    enabled: true,
    daily_cap: 5_000_000,
    providers: [
      { key: "claude_code", label: "Claude", reports_usage: true },
      { key: "codex", label: "Codex", reports_usage: true },
      { key: "cursor", label: "Cursor", reports_usage: false },
    ],
    totals: { total: 2_900_000, cached_input: 1_100_000, input: 900_000, output: 900_000, failed_total: 214_000 },
    today: {
      since: 1_787_702_400,
      until: 1_787_702_400 + 14 * 3600,
      totals: { total: 2_900_000, cached_input: 1_100_000, input: 900_000, output: 900_000, failed_total: 214_000 },
      groups: [
        { provider: "claude_code", total: 1_620_000 },
        { provider: "codex", total: 810_000 },
      ],
      compare_totals: { total: 3_500_000 },
      compare_groups: [
        { provider: "claude_code", total: 2_100_000 },
        { provider: "codex", total: 760_000 },
      ],
    },
    by_role: [
      { role: "Tester", total: 1_020_000, share: 35 },
      { role: "Implementer", total: 890_000, share: 31 },
    ],
    by_team: [
      { team: "Infra", total: 1_100_000, share: 38 },
      { team: "Backend", total: 780_000, share: 27 },
    ],
    waste: { failed_total: 214_000, share: 7, hotspot_total: 168_000, hotspot_label: "Migrate Broker" },
    top_tasks: [
      { title: "Migrate Broker", team_run_id: "migrate-broker", total: 612_000, status: "paused", by_provider: { claude_code: 0.7, codex: 0.3 } },
    ],
    buckets: [
      { key: "2026-08-25", groups: [{ provider: "claude_code", total: 2_000_000 }] },
      { key: "2026-08-26", groups: [{ provider: "claude_code", total: 1_620_000 }, { provider: "codex", total: 810_000 }] },
    ],
  };
  const html = renderToStaticMarkup(h(UsageReportScreen, { report, bucket: "day" }));
  assert.match(html, /−23%/); // claude vs yesterday
  assert.match(html, /\+7%/); // codex
  assert.match(html, /By team/);
  assert.match(html, /Infra/);
  assert.match(html, /Worth a look/);
  assert.match(html, /Migrate Broker/);
  assert.match(html, /usage-kicker-scope/);
  assert.doesNotMatch(html, />M3</);
});

// --- the exhaustion policy control ------------------------------------------
//
// It was two disabled buttons for a milestone. Now it writes, so the things
// worth pinning are which one reads as chosen and when it is safe to press.

test("the policy toggle marks the armed policy and can be pressed once a cap exists", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, {
      report: { ...USAGE_FIXTURE, daily_cap: 5_000_000, budget_policy: "stop_everything" },
      bucket: "day",
      onSetBudget: () => {},
    })
  );
  // The armed one is marked, and only it.
  assert.match(html, /class="is-active"[^>]*>Stop everything</);
  assert.doesNotMatch(html, /class="is-active"[^>]*>Hold new work</);
  assert.doesNotMatch(html, /disabled=""[^>]*>Stop everything</);
  // And the note describes what stop_everything actually does — which is NOT
  // interrupting a running turn.
  assert.match(html, /Turns already running finish/);
});

test("with no cap set the policy cannot be chosen, because neither would fire", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, {
      report: { ...USAGE_FIXTURE, daily_cap: null, budget_policy: "hold_new_work" },
      bucket: "day",
      onSetBudget: () => {},
    })
  );
  assert.match(html, /disabled=""[^>]*>Hold new work</);
  assert.match(html, /Set a daily quota first/);
});

test("a screen with no budget writer offers no policy buttons to press", () => {
  // Remote has no transport for this today. An enabled-looking control that
  // silently does nothing is worse than one that says it is unavailable.
  const html = renderToStaticMarkup(
    h(UsageReportScreen, {
      report: { ...USAGE_FIXTURE, daily_cap: 5_000_000, budget_policy: "hold_new_work" },
      bucket: "day",
    })
  );
  assert.match(html, /disabled=""[^>]*>Stop everything</);
});

test("the default policy is assumed when the report predates the field", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, {
      report: { ...USAGE_FIXTURE, daily_cap: 5_000_000 },
      bucket: "day",
      onSetBudget: () => {},
    })
  );
  assert.match(html, /class="is-active"[^>]*>Hold new work</);
});

test("the cost footnote dates the price table it used", () => {
  // The cost column is the one figure here that goes stale without anything on
  // screen changing. Saying "estimated" is not enough — estimated from WHEN.
  const html = renderToStaticMarkup(
    h(UsageReportScreen, {
      report: { ...USAGE_FIXTURE, prices_as_of: "2026-08-26" },
      bucket: "week",
    })
  );
  assert.match(html, /as of 2026-08-26/);
});

test("a report with no price date still labels the column an estimate", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report: USAGE_FIXTURE, bucket: "week" })
  );
  assert.match(html, /Cost estimated from list prices/);
  assert.doesNotMatch(html, /as of undefined/);
});

test("maps ledger role ids to the names the design uses", () => {
  const report = {
    enabled: true,
    providers: [{ key: "claude_code", label: "Claude", reports_usage: true }],
    totals: { total: 1_000_000, cached_input: 0, input: 500_000, output: 500_000 },
    today: {
      since: 1,
      until: 2,
      totals: { total: 1_000_000 },
      groups: [{ provider: "claude_code", total: 1_000_000 }],
      compare_totals: { total: 1_000_000 },
      compare_groups: [],
    },
    by_role: [
      { role: "tl", total: 400_000, share: 40 },
      { role: "dev", total: 350_000, share: 35 },
      { role: "reviewer", total: 250_000, share: 25 },
    ],
    by_team: [],
    top_tasks: [],
    buckets: [{ key: "2026-08-26", groups: [{ provider: "claude_code", total: 1_000_000 }] }],
  };
  const html = renderToStaticMarkup(h(UsageReportScreen, { report, bucket: "day" }));
  assert.match(html, />Planner</);
  assert.match(html, />Implementer</);
  assert.match(html, />Reviewer</);
  assert.doesNotMatch(html, />tl</);
  assert.doesNotMatch(html, />dev</);
});

test("selecting a past day updates left spend and right attribution together", () => {
  const report = {
    enabled: true,
    daily_cap: 5_000_000,
    providers: [
      { key: "claude_code", label: "Claude", reports_usage: true },
      { key: "codex", label: "Codex", reports_usage: true },
    ],
    totals: { total: 5_000_000, cached_input: 400_000, input: 2_000_000, output: 2_600_000 },
    today: {
      since: 1,
      until: 2,
      totals: {
        total: 2_900_000,
        cached_input: 1_100_000,
        input: 900_000,
        output: 900_000,
      },
      groups: [
        { provider: "claude_code", total: 1_600_000 },
        { provider: "codex", total: 1_300_000 },
      ],
      compare_totals: { total: 3_000_000 },
      compare_groups: [],
    },
    by_role: [{ role: "Tester", total: 1_000_000, share: 34 }],
    by_team: [{ team: "Infra", total: 1_100_000, share: 38 }],
    top_tasks: [{ title: "Only today", team_run_id: "t1", total: 100_000, status: "done" }],
    buckets: [
      {
        key: "2026-08-13",
        groups: [
          {
            provider: "claude_code",
            total: 750_000,
            cached_input: 50_000,
            input: 400_000,
            output: 300_000,
          },
        ],
      },
      {
        key: "2026-08-26",
        groups: [
          { provider: "claude_code", total: 1_600_000 },
          { provider: "codex", total: 1_300_000 },
        ],
      },
    ],
  };
  const series = stackedSeries({ buckets: report.buckets });
  const past = dayFocus(report, series, "2026-08-13");
  assert.equal(past.isToday, false);
  assert.equal(past.totals.total, 750_000);
  assert.equal(past.groups[0].provider, "claude_code");

  const todayHtml = renderToStaticMarkup(
    h(UsageReportScreen, { report, bucket: "day" })
  );
  assert.match(todayHtml, /Spent today/);
  assert.match(todayHtml, /By role/);
  assert.match(todayHtml, /Only today/);
  assert.match(todayHtml, /1\.1M/); // cache from today

  const pastHtml = renderToStaticMarkup(
    h(UsageReportScreen, { report, bucket: "day", selectedDayKey: "2026-08-13" })
  );
  assert.match(pastHtml, /Spent 8\/13/);
  assert.match(pastHtml, /750K|750k|0\.8M|750/);
  assert.match(pastHtml, /only available for today/);
  assert.doesNotMatch(pastHtml, /By role/);
  assert.doesNotMatch(pastHtml, /Only today/);
  // Cache follows the selected day (50k cached on 8/13), not today's 1.1M.
  assert.match(pastHtml, /usage-cache-num[^>]*>50k</);
  assert.doesNotMatch(pastHtml, /usage-cache-num[^>]*>1\.1M</);
});
