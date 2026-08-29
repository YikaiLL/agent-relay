// The Usage screen.
//
// Presentation only: every derivation it shows comes from usage-model.js, so
// the numbers can be tested without a DOM and this file stays about layout and
// wording. The rule it keeps is that an absence is drawn as an absence — a
// provider that cannot report gets an em dash, a section with nothing to say is
// omitted rather than rendered at zero, and a projection the model calls
// unconfident is not given the same weight as a measurement.
//
// Colour identifies a provider and never a rank; the `is-<tone>` classes resolve
// to the app-wide provider tokens in styles.css, so a provider is the same
// colour here as it is in the transcript.

import React from "react";

import {
  cachedShare,
  costLabel,
  formatDelta,
  formatTokens,
  deltaPercent,
  headlineTotal,
  projectWindow,
  providerRows,
  priceAgeNote,
  reportState,
  stackedSeries,
} from "./usage-model.js";
import { downloadUsageCsv } from "./usage-csv.js";

const h = React.createElement;

// Month bucket keys render as a short month name; the year is already stated
// once in the range above the chart.
const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// The two exhaustion policies, in the order they escalate.
const POLICIES = [
  ["hold_new_work", "Hold new work"],
  ["stop_everything", "Stop everything"],
];

const PROVIDER_TONE = {
  claude_code: "claude",
  codex: "codex",
  cursor: "cursor",
};

const PROVIDER_BLURB = {
  claude_code: "Default for Implementer / Tester",
  codex: "Migrations · long diff review",
  cursor: "Small frontend edits · cheapest per token",
};

/** Wire role ids → names the design uses. Unknown ids pass through. */
const ROLE_LABEL = {
  tl: "Planner",
  planner: "Planner",
  dev: "Implementer",
  implementer: "Implementer",
  reviewer: "Reviewer",
  tester: "Tester",
};

function roleLabel(role) {
  if (!role) return "Unattributed";
  return ROLE_LABEL[role] || ROLE_LABEL[String(role).toLowerCase()] || role;
}

function providerTone(key) {
  return PROVIDER_TONE[key] || "other";
}

function providerMeta(report, key) {
  const fromReport = (report?.providers || []).find((p) => p.key === key);
  return {
    key,
    label: fromReport?.label || key,
    blurb: fromReport?.blurb || PROVIDER_BLURB[key] || "",
    reports_usage: fromReport?.reports_usage,
  };
}

/**
 * A bucket key as an axis label: `2026-08-26` → `26`, `2026-W34` → `W34`.
 *
 * Fourteen full dates across one axis overlap into an unreadable band, and the
 * year and month are already stated once in the range above the chart. The last
 * column gets a word instead of a number — "Today" / "This week" — because its bar is
 * the only partial one, and a reader comparing it against yesterday needs to
 * know that before they read its height.
 */
function shortBucketLabel(key, { end = false, endLabel = "Today" } = {}) {
  if (end) return endLabel;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (day) return String(Number(day[3]));
  const week = /^(\d{4})-W(\d{2})$/.exec(key);
  if (week) return `W${Number(week[2])}`;
  const month = /^(\d{4})-(\d{2})$/.exec(key);
  if (month) return MONTH_LABELS[Number(month[2]) - 1] || key;
  const md = /^(\d{1,2})\/(\d{1,2})$/.exec(key);
  if (md) return String(Number(md[2]));
  return key;
}

function shortRangeLabel(fromKey, toKey) {
  const fmt = (key) => {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (day) return `${Number(day[2])}/${Number(day[3])}`;
    const md = /^(\d{1,2})\/(\d{1,2})$/.exec(key);
    if (md) return `${Number(md[1])}/${Number(md[2])}`;
    return shortBucketLabel(key);
  };
  if (!fromKey || !toKey) return "";
  return `${fmt(fromKey)} – ${fmt(toKey)}`;
}

// The roster minus `fake`, unless `fake` actually spent something in view. The
// server already applies this rule to its own roster; it is repeated here
// because the chart's buckets can carry a provider the roster does not, and a
// test relay's row on a real screen is noise that never clears.
function visibleProviders(report, groups = []) {
  const spent = new Set((groups || []).map((g) => g.provider));
  for (const bucket of report?.buckets || []) {
    for (const g of bucket.groups || []) spent.add(g.provider);
  }
  return (report?.providers || []).filter((p) => {
    if (p.key === "fake" && !spent.has("fake")) return false;
    return true;
  });
}


function StatusDot({ status }) {
  if (!status || status === "unknown") return null;
  const tone =
    status === "running" ? "running" : status === "paused" ? "paused" : "idle";
  const label =
    status === "running"
      ? "Running"
      : status === "paused"
        ? "Paused"
        : status === "pending_merge"
          ? "Awaiting merge"
          : status;
  return h("span", { className: `usage-status is-${tone}` }, label);
}

// A one-line provider split beside a task. `flex: share` lets the browser do
// the proportional widths, so no percentage is computed or rounded here — and
// zero-value segments are dropped rather than rendered at 0 width, which would
// otherwise collapse into a visible seam between the segments either side.
//
// `aria-hidden` because it is a restatement: the numbers it summarises are
// already on the row in text.
function MiniStack({ byProvider }) {
  const entries = Object.entries(byProvider || {}).filter(([, v]) => v > 0);
  if (!entries.length) return null;
  return h(
    "span",
    { className: "usage-mini-stack", "aria-hidden": "true" },
    ...entries.map(([key, share]) =>
      h("span", {
        key,
        className: `usage-mini-seg is-${providerTone(key)}`,
        style: { flex: share },
      })
    )
  );
}

// Clamped at 100: over-cap spend would otherwise run the fill past its track.
// The overshoot is not lost — it is what the projection line and the "heading
// over" copy are for — but a bar that renders wider than its own container
// reads as a layout bug rather than as a number.
function QuotaBar({ spent, cap, delta }) {
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  return h(
    "div",
    { className: "usage-quota" },
    h(
      "div",
      { className: "usage-quota-track" },
      h("div", { className: "usage-quota-fill", style: { width: `${pct}%` } })
    ),
    delta
      ? h("span", { className: "usage-delta is-down" }, delta)
      : null
  );
}

/**
 * The chart's y-max.
 *
 * The `base * 1.2` clamp is the whole point. Early in the day the projection
 * divides a small spend by a small elapsed fraction and can land many times
 * above any real bar; scaling the axis to it would flatten fourteen days of
 * actual history into a strip along the bottom to make room for a dashed line
 * that is a guess. Letting the projection overshoot the top by at most a fifth
 * keeps it legible as "heading over" without letting it repaint the facts.
 *
 * An unconfident projection is excluded entirely — see `projectWindow`.
 */
function chartScaleMax(series, cap, projectToday) {
  const seriesMax = Math.max(0, ...series.map((b) => b.total));
  const base = Math.max(cap || 0, seriesMax, 1);
  const projected =
    projectToday?.confident && Number(projectToday.projected) > 0
      ? Number(projectToday.projected)
      : 0;
  return Math.max(base, Math.min(projected, base * 1.2));
}

/**
 * Round gridline values, chosen rather than computed.
 *
 * A generated scale (max/4, max/2, …) produces ticks like "3.7M" that carry no
 * meaning; a reader checks a bar against a round number or not at all. The
 * `max * 0.95` cut-off drops any tick that would sit under the plot's ceiling,
 * where its label collides with the top of the tallest bar.
 *
 * The cap is always included even when it is not round: it is the one line on
 * this axis the user actually set.
 */
function yAxisTicks(max, cap) {
  const nice = [];
  if (max >= 1_000_000) {
    for (const m of [2, 4, 5, 6, 8, 10]) {
      const v = m * 1_000_000;
      if (v < max * 0.95) nice.push(v);
    }
  } else if (max >= 1_000) {
    for (const k of [250, 500, 750]) {
      const v = k * 1_000;
      if (v < max * 0.95) nice.push(v);
    }
  }
  if (cap && !nice.includes(cap)) nice.push(cap);
  return [...new Set(nice)].filter((v) => v > 0 && v <= max).sort((a, b) => a - b);
}

function StackedChart({ series, cap, projectToday, providers, endLabel = "Today" }) {
  const max = chartScaleMax(series, cap, projectToday);
  const preferred = ["claude_code", "codex", "cursor"];
  const seen = new Set();
  for (const bucket of series) {
    for (const key of Object.keys(bucket.byProvider || {})) {
      if ((bucket.byProvider[key] || 0) > 0) seen.add(key);
    }
  }
  const stackKeys = [
    ...preferred.filter((k) => seen.has(k)),
    ...[...seen].filter((k) => !preferred.includes(k)),
  ];
  const colCount = Math.max(series.length, 1);
  const capPct = cap ? (cap / max) * 100 : null;
  const ticks = yAxisTicks(max, cap);

  return h(
    "div",
    { className: "usage-chart", style: { "--usage-cols": String(colCount) } },
    h(
      "div",
      { className: "usage-chart-frame" },
      h(
        "div",
        { className: "usage-chart-yaxis", "aria-hidden": "true" },
        ...ticks.map((v) =>
          h(
            "span",
            {
              key: v,
              className: v === cap ? "is-cap" : undefined,
              style: { bottom: `${(v / max) * 100}%` },
            },
            formatTokens(v)
          )
        )
      ),
      h(
        "div",
        { className: "usage-chart-plot" },
        capPct != null
          ? h("div", {
              className: "usage-chart-cap",
              style: { bottom: `${capPct}%` },
              title: `Daily quota ${formatTokens(cap)}`,
            })
          : null,
        h(
          "div",
          { className: "usage-chart-bars" },
          ...series.map((bucket, i) => {
            const isEnd = i === series.length - 1;
            const height = bucket.total > 0 ? (bucket.total / max) * 100 : 0;
            const projected =
              isEnd && projectToday?.confident ? projectToday.projected : null;
            const projHeight =
              projected != null
                ? Math.min(100, (projected / max) * 100)
                : null;
            const hitCap = cap && bucket.total >= cap;
            return h(
              "div",
              {
                key: bucket.key,
                className: [
                  "usage-chart-col",
                  isEnd ? "is-today" : "",
                  hitCap ? "is-capped" : "",
                ]
                  .filter(Boolean)
                  .join(" "),
                title: [
                  shortBucketLabel(bucket.key, { end: isEnd, endLabel }),
                  formatTokens(bucket.total),
                  ...stackKeys
                    .filter((k) => bucket.byProvider[k])
                    .map((k) => `${k}: ${formatTokens(bucket.byProvider[k])}`),
                  hitCap ? "Hit the daily quota" : "",
                ]
                  .filter(Boolean)
                  .join(" · "),
              },
              h(
                "span",
                { className: "usage-chart-value" },
                bucket.total > 0 ? formatTokens(bucket.total) : ""
              ),
              h(
                "div",
                { className: "usage-chart-bar-wrap" },
                projHeight
                  ? h("div", {
                      className: "usage-chart-projection",
                      style: { height: `${Math.max(projHeight, height)}%` },
                    })
                  : null,
                height > 0
                  ? h(
                      "div",
                      {
                        className: "usage-chart-bar",
                        style: { height: `${height}%` },
                      },
                      ...stackKeys.map((key) => {
                        const n = bucket.byProvider[key] || 0;
                        if (!n) return null;
                        return h("div", {
                          key,
                          className: `usage-chart-seg is-${providerTone(key)}`,
                          style: { flexGrow: n, flexShrink: 0, flexBasis: 0 },
                        });
                      })
                    )
                  : h("div", { className: "usage-chart-bar is-empty" })
              )
            );
          })
        )
      )
    ),
    h(
      "div",
      { className: "usage-chart-labels" },
      ...series.map((bucket, i) => {
        const isEnd = i === series.length - 1;
        const show =
          isEnd ||
          i === 0 ||
          series.length <= 10 ||
          i % 2 === 0;
        return h(
          "span",
          {
            key: bucket.key,
            className: isEnd ? "is-today" : undefined,
          },
          show ? shortBucketLabel(bucket.key, { end: isEnd, endLabel }) : ""
        );
      })
    ),
    stackKeys.length
      ? h(
          "div",
          { className: "usage-chart-legend" },
          ...stackKeys.map((key) =>
            h(
              "span",
              { key, className: "usage-chart-legend-item" },
              h("span", { className: `usage-swatch is-${providerTone(key)}` }),
              providerMeta({ providers }, key).label || key
            )
          )
        )
      : null
  );
}

function LeftRail({ report, projection, onSetBudget, budgetPending }) {
  const policy = report.budget_policy || "hold_new_work";
  const todayGroups =
    report.today?.groups ||
    report.today_groups ||
    (report.buckets || []).slice(-1)[0]?.groups ||
    [];
  const total = report.today
    ? headlineTotal(report.today.totals)
    : todayGroups.reduce((s, g) => s + headlineTotal(g), 0) || headlineTotal(report.totals);
  const cap = report.daily_cap || null;
  const prev = report.today
    ? headlineTotal(report.today.compare_totals)
    : (report.buckets || []).slice(-2, -1)[0]?.groups?.reduce((s, g) => s + headlineTotal(g), 0) ||
      headlineTotal(report.compare?.totals);
  const delta = deltaPercent(total, prev);
  const deltaText = formatDelta(delta);
  const roster = visibleProviders(report, todayGroups);
  const todayRows = providerRows({ groups: todayGroups, providers: roster });
  const { complete } = todayRows;
  const prevByProvider = new Map();
  for (const g of report.today?.compare_groups || []) {
    prevByProvider.set(g.provider, (prevByProvider.get(g.provider) || 0) + headlineTotal(g));
  }

  return h(
    "aside",
    { className: "usage-rail usage-rail-left" },
    h("div", { className: "usage-kicker" }, "Spent today"),
    h(
      "div",
      { className: "usage-headline" },
      h("span", { className: "usage-headline-num" }, formatTokens(total)),
      cap
        ? h("span", { className: "usage-headline-cap" }, ` / ${formatTokens(cap)} daily quota`)
        : null
    ),
    h(QuotaBar, {
      spent: total,
      cap: cap || total,
      delta: deltaText ? `${deltaText} vs the same time yesterday` : null,
    }),
    projection?.confident && projection.exhaustsAt
      ? h(
          "p",
          { className: "usage-projection-note is-warn" },
          `On track to run out at ${formatExhaust(projection.exhaustsAt)}`
        )
      : projection?.confident
        ? h(
            "p",
            { className: "usage-projection-note" },
            `At the current rate, ${formatTokens(projection.projected)} today`
          )
        : null,
    h("div", { className: "usage-section-label" }, "By provider"),
    h(
      "ul",
      { className: "usage-provider-list" },
      ...todayRows.rows.map((row) => {
        const meta = providerMeta(report, row.key);
        if (!row.reportsUsage) {
          return h(
            "li",
            { key: row.key, className: "usage-provider-row is-silent" },
            h("span", { className: `usage-swatch is-${providerTone(row.key)}` }),
            h(
              "div",
              { className: "usage-provider-body" },
              h("div", { className: "usage-provider-name" }, meta.label || row.key),
              h("div", { className: "usage-provider-blurb" }, "Usage not reported")
            ),
            h("div", { className: "usage-provider-stats" }, h("span", null, "—"))
          );
        }
        const rowDelta = deltaPercent(row.total, prevByProvider.get(row.key));
        const rowDeltaText = formatDelta(rowDelta);
        return h(
          "li",
          { key: row.key, className: "usage-provider-row" },
          h("span", { className: `usage-swatch is-${providerTone(row.key)}` }),
          h(
            "div",
            { className: "usage-provider-body" },
            h(
              "div",
              { className: "usage-provider-name-row" },
              h("span", { className: "usage-provider-name" }, meta.label || row.key),
              h("strong", null, formatTokens(row.total))
            ),
            h(
              "div",
              { className: "usage-provider-track" },
              h("div", {
                className: `usage-provider-fill is-${providerTone(row.key)}`,
                style: { width: `${Math.max(0, Math.min(100, row.share || 0))}%` },
              })
            ),
            h(
              "div",
              { className: "usage-provider-meta" },
              rowDeltaText
                ? h(
                    "span",
                    {
                      className:
                        rowDelta < 0 ? "is-down" : rowDelta > 0 ? "is-up" : undefined,
                    },
                    rowDeltaText
                  )
                : null,
              row.share != null ? h("span", null, `${Math.round(row.share)}%`) : null
            ),
            meta.blurb
              ? h("div", { className: "usage-provider-blurb" }, meta.blurb)
              : null
          )
        );
      })
    ),
    !complete
      ? h(
          "p",
          { className: "usage-partial-note" },
          "Shares count only providers that report. Cursor is not in the denominator."
        )
      : null,
    h(
      "div",
      { className: "usage-policy" },
      h("div", { className: "usage-section-label" }, "When the quota runs out"),
      h(
        "div",
        { className: "usage-policy-toggle" },
        ...POLICIES.map(([value, label]) =>
          h(
            "button",
            {
              key: value,
              type: "button",
              className: policy === value ? "is-active" : "",
              // Disabled with no cap set, because neither policy can fire: the
              // control would accept a choice that changes nothing, which reads
              // as broken rather than as inapplicable.
              disabled: !cap || budgetPending || !onSetBudget,
              title: cap ? undefined : "Set a daily quota first",
              onClick: () => onSetBudget?.({ policy: value }),
            },
            label
          )
        )
      ),
      h(
        "p",
        { className: "usage-policy-note" },
        // Says what actually happens, not what the mockup promised. Neither
        // policy interrupts a turn that is already running — the relay has no
        // primitive for that — so "stop everything" has to mean "start nothing".
        policy === "stop_everything"
          ? "Nothing new starts, yours included. Turns already running finish."
          : "New autonomous work waits for tomorrow. You can still send messages yourself."
      )
    )
  );
}

function formatExhaust(msFromWindowStart) {
  const date = new Date(msFromWindowStart);
  if (Number.isFinite(date.getTime()) && msFromWindowStart > 86_400_000) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  const mins = Math.round(Number(msFromWindowStart) / 60_000);
  if (!Number.isFinite(mins) || mins < 0) return "—";
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function CenterDay({ report, series, projection }) {
  const windowTotal = series.reduce((s, b) => s + b.total, 0);
  const avg = series.length ? windowTotal / series.length : 0;
  const dayCount = series.length || 14;
  return h(
    "section",
    { className: "usage-center" },
    h(
      "div",
      { className: "usage-center-head" },
      h("h2", { className: "usage-center-title" }, "Daily spend"),
      h(
        "p",
        { className: "usage-center-sub" },
        `${formatTokens(windowTotal)} over ${dayCount} days · ${formatTokens(avg)}/day`
      )
    ),
    h(StackedChart, {
      series,
      cap: report.daily_cap,
      projectToday: projection,
      providers: visibleProviders(report),
    }),
    (report.top_tasks || []).length
      ? h(
          "div",
          { className: "usage-tasks" },
          h(
            "div",
            { className: "usage-tasks-head" },
            h("h3", null, "Today's most expensive tasks")
          ),
          h(
            "ul",
            { className: "usage-task-list" },
            ...(report.top_tasks || []).map((task) =>
              h(
                "li",
                { key: task.team_run_id || task.title, className: "usage-task-row" },
                h(
                  "div",
                  { className: "usage-task-main" },
                  h("div", { className: "usage-task-title" }, task.title),
                  task.meta
                    ? h("div", { className: "usage-task-meta" }, task.meta)
                    : null
                ),
                h(MiniStack, { byProvider: task.by_provider }),
                h("strong", { className: "usage-task-tokens" }, formatTokens(task.total)),
                h(
                  "div",
                  { className: "usage-task-status" },
                  h(StatusDot, { status: task.status }),
                  task.status_note
                    ? h("span", { className: "usage-task-status-note" }, task.status_note)
                    : null
                )
              )
            )
          )
        )
      : null
  );
}

function RightRail({ report }) {
  const attrTotals = report.today?.totals || report.totals;
  const cache = cachedShare(attrTotals);
  const waste =
    report.waste ||
    (attrTotals?.failed_total
      ? {
          failed_total: attrTotals.failed_total,
          share:
            headlineTotal(attrTotals) > 0
              ? Math.round((attrTotals.failed_total / headlineTotal(attrTotals)) * 100)
              : 0,
        }
      : null);
  const teams = report.by_team || [];
  return h(
    "aside",
    { className: "usage-rail usage-rail-right" },
    h(
      "div",
      { className: "usage-kicker" },
      "Attribution",
      report.today ? h("span", { className: "usage-kicker-scope" }, "Today") : null
    ),
    (() => {
      const roles = (report.by_role || []).filter(
        (row) => row.role || (report.by_role || []).length > 1
      );
      if (!roles.length) {
        return h(
          "p",
          { className: "usage-partial-note" },
          "No turns carry a role yet — only team runs do."
        );
      }
      return h(
        "div",
        null,
        h("div", { className: "usage-section-label" }, "By role"),
        h(
          "ul",
          { className: "usage-role-list" },
          ...roles.map((row) =>
            h(
              "li",
              { key: row.role || "unattributed", className: "usage-role-row" },
              h(
                "div",
                { className: "usage-role-head" },
                h("span", null, roleLabel(row.role)),
                h("span", null, `${formatTokens(row.total)} · ${row.share}%`)
              ),
              h(
                "div",
                { className: "usage-role-track" },
                h("div", { className: "usage-role-fill", style: { width: `${row.share}%` } })
              ),
              row.note ? h("div", { className: "usage-role-note" }, row.note) : null
            )
          )
        )
      );
    })(),
    teams.length
      ? h(
          "div",
          null,
          h("div", { className: "usage-section-label" }, "By team"),
          h(
            "ul",
            { className: "usage-team-list" },
            ...teams.map((row) =>
              h(
                "li",
                { key: row.team, className: "usage-team-row" },
                h(
                  "div",
                  { className: "usage-role-head" },
                  h("span", null, row.team),
                  h(
                    "span",
                    null,
                    row.share != null
                      ? `${formatTokens(row.total)} · ${row.share}%`
                      : formatTokens(row.total)
                  )
                ),
                row.share != null
                  ? h(
                      "div",
                      { className: "usage-role-track" },
                      h("div", {
                        className: "usage-role-fill",
                        style: { width: `${row.share}%` },
                      })
                    )
                  : null
              )
            )
          )
        )
      : null,
    waste
      ? h(
          "div",
          { className: "usage-insight" },
          h("div", { className: "usage-insight-title" }, "Worth a look"),
          h(
            "p",
            null,
            `Retries and failed reruns burned ${formatTokens(waste.failed_total)} (${waste.share}%).`,
            waste.hotspot_total
              ? ` ${formatTokens(waste.hotspot_total)} of that came from one step (${waste.hotspot_label}).`
              : ""
          ),
          h(
            "div",
            { className: "usage-insight-actions" },
            h("button", { type: "button", disabled: true }, "Open that task"),
            h("button", { type: "button", disabled: true }, "Lower its per-task limit")
          )
        )
      : null,
    cache.meaningful
      ? h(
          "div",
          { className: "usage-cache" },
          h("div", { className: "usage-section-label" }, "Cache hits"),
          h("div", { className: "usage-cache-num" }, formatTokens(cache.cached)),
          h(
            "p",
            { className: "usage-cache-note" },
            `${Math.round(cache.share)}% of it came from cache — repeated reads of the same repo, reused.`
          )
        )
      : null
  );
}

function WeekView({ report, mode = "week" }) {
  const buckets = report.buckets || [];
  const series = stackedSeries({ buckets });
  const thisWeek = series.at(-1);
  const thisTotal = thisWeek?.total || headlineTotal(report.totals);
  const prevTotal =
    series.at(-2)?.total ?? headlineTotal(report.compare?.totals);
  const delta = deltaPercent(thisTotal, prevTotal);

  const weekGroups = buckets.at(-1)?.groups || [];
  const prevBucketGroups = report.compare?.buckets?.at(-1)?.groups || [];
  const prevByProvider = new Map(
    prevBucketGroups.map((g) => [g.provider, headlineTotal(g)])
  );

  return h(
    "section",
    { className: "usage-week" },
    h(
      "div",
      { className: "usage-center-head" },
      h(
        "h2",
        { className: "usage-center-title" },
        mode === "month"
          ? `${formatTokens(thisTotal)} so far this month`
          : `${formatTokens(thisTotal)} so far this week`
      ),
      h(
        "p",
        { className: "usage-center-sub" },
        `${formatTokens(prevTotal)} at the same point ${mode === "month" ? "last month" : "last week"}${
          delta != null ? ` · ${formatDelta(delta)}` : ""
        }`
      )
    ),
    h(StackedChart, {
      series,
      cap: null,
      projectToday: {
        projected: thisTotal * (7 / Math.max(1, new Date().getUTCDay() || 3)),
        confident: true,
      },
      providers: report.providers,
      endLabel: mode === "month" ? "This month" : "This week",
    }),
    h(
      "div",
      { className: "usage-week-table-wrap" },
      h(
        "div",
        { className: "usage-tasks-head" },
        h("h3", null, mode === "month" ? "This month by provider" : "This week by provider"),
        h(
          "span",
          { className: "usage-cost-footnote" },
          report.prices_as_of
            ? `Cost estimated from list prices as of ${report.prices_as_of}${
                priceAgeNote(report.prices_as_of)
                  ? ` — ${priceAgeNote(report.prices_as_of)}`
                  : ""
              }`
            : "Cost estimated from list prices"
        )
      ),
      h(
        "table",
        { className: "usage-week-table" },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", null, "PROVIDER"),
            h("th", null, "TOKEN"),
            h("th", null, "Change"),
            h("th", null, "Cost")
          )
        ),
        h(
          "tbody",
          null,
          ...weekGroups.map((g) => {
            const meta = providerMeta(report, g.provider);
            const silent = report.providers?.find((p) => p.key === g.provider)?.reports_usage === false;
            const total = silent ? null : headlineTotal(g);
            const prev = prevByProvider.get(g.provider);
            const d = silent || total == null ? null : deltaPercent(total, prev);
            const cost = silent
              ? { text: "—", estimated: false, title: "Usage not reported" }
              : costLabel(g);
            return h(
              "tr",
              { key: g.provider, className: silent ? "is-silent" : "" },
              h(
                "td",
                null,
                h("span", { className: `usage-swatch is-${providerTone(g.provider)}` }),
                h(
                  "span",
                  null,
                  h("strong", null, meta.label || g.provider),
                  meta.blurb ? h("span", { className: "usage-provider-blurb" }, meta.blurb) : null
                )
              ),
              h("td", null, silent ? "—" : formatTokens(total)),
              h(
                "td",
                { className: d != null && d < 0 ? "is-down" : d != null && d > 0 ? "is-up" : "" },
                silent ? "—" : formatDelta(d) || "—"
              ),
              h(
                "td",
                { className: cost.estimated ? "is-estimated" : "", title: cost.title },
                cost.text
              )
            );
          }),
          h(
            "tr",
            { className: "is-total" },
            h("td", null, "Total"),
            h("td", null, formatTokens(thisTotal)),
            h("td", null, formatDelta(delta) || "—"),
            h("td", null, costLabel(report.totals).text)
          )
        )
      ),
      report.fixture
        ? h(
            "div",
            { className: "usage-week-insight" },
            h("strong", null, "Cheaper this week, because Tester's limit was lowered"),
            h(
              "p",
              null,
              "Same nine tasks finished, and Claude burned 1.9M less. Cursor's 0.9M was all on three small frontend edits — cheap per token, worth keeping."
            )
          )
        : null
    )
  );
}

/**
 * What stands in for the report on a relay that never asked for beta features.
 *
 * The scenery is invented, and `aria-hidden` is not decoration: a screen reader
 * reading out fabricated token counts would be a lie rather than a preview. The
 * real report is not rendered and then hidden — it is never built, because blur
 * is a CSS property and devtools removes it in one click. Someone's spend is not
 * something to protect with a filter.
 */
function LockedUsage() {
  // Rough shape of the 14-day chart, so the locked screen reads as "a chart you
  // cannot see yet" rather than an error.
  const bars = [46, 58, 38, 72, 61, 66, 84, 100, 44, 63, 71, 52, 59, 67];
  return h(
    "div",
    { className: "usage-screen usage-locked" },
    h(
      "div",
      { className: "usage-locked-scenery", "aria-hidden": "true" },
      h(
        "div",
        { className: "usage-locked-bars" },
        ...bars.map((height, index) =>
          h("span", {
            key: index,
            className: "usage-locked-bar",
            style: { height: `${height}%` },
          })
        )
      )
    ),
    h(
      "div",
      { className: "usage-locked-notice", role: "status" },
      h("h2", { className: "usage-locked-title" }, "Usage is in development"),
      h(
        "p",
        { className: "usage-locked-lede" },
        "Usage shows where tokens went — by provider, by role, by task — and the daily quota can stop new work when it runs out. It is behind the beta gate until the report has been lived with a bit longer."
      )
    )
  );
}

export function UsageReportScreen({
  report,
  loading = false,
  error = null,
  bucket = "day",
  onBucketChange,
  onRetry,
  locked = false,
  onSetBudget,
  budgetPending = false,
}) {
  // First, ahead of loading and error: those branches describe a fetch this
  // build should never have made. A locked screen has nothing to say about the
  // state of a request it does not want the answer to.
  if (locked) {
    return h(LockedUsage);
  }
  if (loading && !report) {
    return h("div", { className: "usage-screen" }, h("p", { className: "usage-empty" }, "Loading…"));
  }
  if (error && !report) {
    return h(
      "div",
      { className: "usage-screen" },
      h(
        "div",
        { className: "usage-empty" },
        h("h2", null, "Could not load usage"),
        h("p", null, error),
        onRetry
          ? h(
              "button",
              { type: "button", className: "usage-retry", onClick: () => onRetry() },
              "Retry"
            )
          : null
      )
    );
  }
  const state = reportState(report);
  if (state === "loading") {
    return h("div", { className: "usage-screen" }, h("p", { className: "usage-empty" }, "Loading…"));
  }
  if (state === "disabled") {
    return h(
      "div",
      { className: "usage-screen" },
      h(
        "div",
        { className: "usage-empty" },
        h("h2", null, "Usage unavailable"),
        h("p", null, "Token ledger failed to open. The relay is fine; the report is not.")
      )
    );
  }

  const daySeries = stackedSeries({
    buckets: report.buckets || [],
  });
  const todaySpent = report.today
    ? headlineTotal(report.today.totals)
    : daySeries.at(-1)?.total || headlineTotal(report.totals);
  const elapsedMs = report.today
    ? Math.max(1, (report.today.until - report.today.since) * 1000)
    : 14 * 3600_000;
  const projection = projectWindow({
    spent: todaySpent,
    elapsedMs,
    windowMs: 24 * 3600_000,
    cap: report.daily_cap,
  });

  return h(
    "div",
    { className: "usage-screen" },
    report.fixture
      ? h(
          "div",
          { className: "usage-fixture-banner", role: "status" },
          "Sample data — /api/usage is not wired up here. Figures match mockups 14a / 14b."
        )
      : null,
    h(
      "header",
      { className: "usage-toolbar" },
      h(
        "div",
        { className: "usage-tabs", role: "tablist" },
        ...[
          ["day", "Day"],
          ["week", "Week"],
          ["month", "Month"],
        ].map(([key, label]) =>
          h(
            "button",
            {
              key,
              type: "button",
              role: "tab",
              "aria-selected": bucket === key,
              className: bucket === key ? "is-active" : "",
              onClick: () => onBucketChange?.(key),
            },
            label
          )
        )
      ),
      h(
        "div",
        { className: "usage-toolbar-right" },
        h(
          "span",
          { className: "usage-range" },
          bucket === "week"
            ? "Last 6 weeks"
            : bucket === "month"
              ? "Last 6 months"
              : shortRangeLabel(daySeries[0]?.key, daySeries.at(-1)?.key) ||
                "Last 14 days"
        ),
        h(
          "button",
          {
            type: "button",
            className: "usage-export",
            disabled: !report || reportState(report) === "empty",
            onClick: () => downloadUsageCsv(report, `usage-${bucket}.csv`),
          },
          "Export CSV"
        )
      )
    ),
    state === "empty"
      ? h(
          "div",
          { className: "usage-empty" },
          h("h2", null, "No usage yet"),
          h("p", null, "Numbers appear here after a turn that reports tokens.")
        )
      : bucket === "week" || bucket === "month"
        ? h(WeekView, { report, mode: bucket })
        : h(
            "div",
            { className: "usage-grid" },
            h(LeftRail, { report, projection, onSetBudget, budgetPending }),
            h(CenterDay, { report, series: daySeries, projection }),
            h(RightRail, { report })
          )
  );
}
