// Layout guards for the Usage centre column: bar value labels must sit on the
// bar tip (not the plot top), and the expensive-task row must collapse on the
// *centre* width — viewport media alone misses "wide window + fat side rails".

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { UsageReportScreen } from "./shared/usage-report-react.js";

const h = React.createElement;
const stylesPath = fileURLToPath(new URL("./styles.css", import.meta.url));
const styles = readFileSync(stylesPath, "utf8");

test("usage centre is a size container so chart/task layout can track it", () => {
  assert.match(
    styles,
    /\.usage-center\s*,\s*\.usage-week\s*\{[^}]*container-type:\s*inline-size/s,
    "usage-center must establish an inline-size container"
  );
  assert.match(
    styles,
    /container-name:\s*usage-center/,
    "container name usage-center for @container queries"
  );
  assert.match(
    styles,
    /@container\s+usage-center\s*\(max-width:\s*\d+px\)/,
    "narrow usage-center must restyle chart values and task rows"
  );
});

test("narrow usage-center collapses the expensive-task row before titles wrap into the cost column", () => {
  const atIdx = styles.search(/@container\s+usage-center\s*\(max-width:\s*\d+px\)/);
  assert.ok(atIdx >= 0);
  const openBrace = styles.indexOf("{", atIdx);
  let depth = 1;
  let scan = openBrace + 1;
  while (scan < styles.length && depth > 0) {
    const ch = styles[scan];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    scan += 1;
  }
  const block = styles.slice(openBrace + 1, scan - 1);
  assert.match(
    block,
    /\.usage-task-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s
  );
  assert.match(block, /\.usage-mini-stack/);
  assert.match(block, /\.usage-task-status/);
  assert.match(
    block,
    /\.usage-chart-value:not\(\.is-today-value\)\s*\{[^}]*visibility:\s*hidden/s,
    "narrow centre hides non-today tip labels by default"
  );
  assert.match(
    block,
    /\.usage-chart-col:hover\s+\.usage-chart-value/,
    "hover must re-show the tip label under the narrow-centre rule"
  );
  assert.match(
    block,
    /\.usage-chart-col\.is-selected\s+\.usage-chart-value/,
    "selection must re-show the tip label under the narrow-centre rule"
  );
});

test("chart columns are selectable; rails follow the selection", () => {
  assert.match(
    styles,
    /\.usage-chart-col:hover\s+\.usage-chart-value:not\(\.is-empty\)/,
    "hover reveals tip labels"
  );
  assert.match(styles, /\.usage-chart-col\.is-selected/);
  assert.match(styles, /\.usage-chart-day-hint/);
});

test("usage chart plot and y-axis share one unpadded scale box", () => {
  // Percentage heights on bars resolve against the plot content box; absolute
  // `bottom:%` on the quota line resolves against the padding box. Top padding
  // on the plot (or a mismatched y-axis margin) makes equal % strings paint at
  // different pixel rows — tip-label headroom belongs on the frame, not the plot.
  const plotIdx = styles.search(/\.usage-chart-plot\s*\{/);
  assert.ok(plotIdx >= 0);
  const plotOpen = styles.indexOf("{", plotIdx);
  const plotClose = styles.indexOf("}", plotOpen);
  const plotBlock = styles.slice(plotOpen + 1, plotClose);
  assert.match(plotBlock, /height:\s*200px/);
  assert.doesNotMatch(
    plotBlock,
    /padding(?:-top)?:\s*(?:[1-9]\d*)px/,
    "plot must not use vertical padding that desyncs bar % from cap %"
  );

  const axisIdx = styles.search(/\.usage-chart-yaxis\s*\{/);
  assert.ok(axisIdx >= 0);
  const axisOpen = styles.indexOf("{", axisIdx);
  const axisClose = styles.indexOf("}", axisOpen);
  const axisBlock = styles.slice(axisOpen + 1, axisClose);
  assert.match(axisBlock, /height:\s*200px/);
  assert.doesNotMatch(
    axisBlock,
    /margin-top:\s*(?:[1-9]\d*)px/,
    "yaxis must not be offset relative to the plot scale box"
  );

  const frameIdx = styles.search(/\.usage-chart-frame\s*\{/);
  assert.ok(frameIdx >= 0);
  const frameOpen = styles.indexOf("{", frameIdx);
  const frameClose = styles.indexOf("}", frameOpen);
  const frameBlock = styles.slice(frameOpen + 1, frameClose);
  assert.match(
    frameBlock,
    /padding-top:\s*(?:1[6-9]|[2-9]\d)px/,
    "tip-label headroom must live on the shared frame above the scale box"
  );
});

test("chart columns keep tip labels paintable above near-max bars", () => {
  assert.match(
    styles,
    /\.usage-chart-col\s*\{[^}]*overflow:\s*visible/s,
    "chart columns must not clip tip labels"
  );
  assert.match(
    styles,
    /\.usage-chart-stack\s*\{/,
    "bar + value share a stack sized to the bar so the label rides the tip"
  );
});

test("day chart wraps each bar value in a height-matched stack", () => {
  const report = {
    enabled: true,
    daily_cap: 5_000_000,
    providers: [
      { key: "claude_code", label: "Claude", reports_usage: true },
      { key: "codex", label: "Codex", reports_usage: true },
    ],
    totals: { total: 3_000_000 },
    today: {
      since: 1_787_702_400,
      until: 1_787_702_400 + 14 * 3600,
      totals: { total: 2_400_000 },
      groups: [
        { provider: "claude_code", total: 1_600_000 },
        { provider: "codex", total: 800_000 },
      ],
      compare_totals: { total: 2_000_000 },
    },
    by_role: [],
    top_tasks: [
      {
        title: "Stabilize LLM streaming UI rendering",
        team_run_id: "t1",
        total: 482_000_000,
        status: "running",
        by_provider: { claude_code: 0.8, codex: 0.2 },
      },
    ],
    buckets: [
      {
        key: "2026-08-13",
        groups: [{ provider: "claude_code", total: 1_000_000 }],
      },
      {
        key: "2026-08-26",
        groups: [
          { provider: "claude_code", total: 4_000_000 },
          { provider: "codex", total: 1_000_000 },
        ],
      },
    ],
  };
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report, bucket: "day" })
  );
  assert.match(html, /class="[^"]*usage-chart-stack/);
  assert.match(html, /usage-chart-stack"[^>]*style="[^"]*height:\s*\d/);
  // Equal token amounts must share one vertical scale: a bar at the daily
  // quota reaches the same % as the dashed quota line and the cap tick.
  // Compressing only bars (e.g. ×0.86 for tip labels) makes a 5M spend look
  // short of a 5M quota.
  const heights = [...html.matchAll(/usage-chart-stack"[^>]*style="height:\s*([0-9.]+)%/g)].map(
    (m) => Number(m[1])
  );
  assert.ok(heights.length > 0, "expected stack heights");
  assert.ok(
    Math.max(...heights) === 100,
    `a day at the 5M quota on a 5M scale must paint at 100%, got ${heights}`
  );
  assert.match(
    html,
    /usage-chart-cap"[^>]*style="[^"]*bottom:\s*100%/,
    "quota line must sit at the same 100% as a bar that hits the quota"
  );
  assert.match(
    html,
    /is-cap"[^>]*style="[^"]*bottom:\s*100%/,
    "cap tick must share the quota line's vertical coordinate"
  );
  assert.match(html, /usage-task-main/);
  assert.match(html, /Stabilize LLM streaming UI rendering/);
  assert.match(html, /role="option"/);
  assert.match(html, /left and right panels follow/);
  assert.match(html, /aria-selected="true"/);
});
