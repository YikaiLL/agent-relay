// Rendered geometry: equal token amounts on bars, the quota line, and the cap
// tick must share a vertical coordinate. Markup % strings alone cannot prove
// this once padding/margin split the percentage reference boxes.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";

import { UsageReportScreen } from "./shared/usage-report-react.js";

const h = React.createElement;
const stylesPath = fileURLToPath(new URL("./styles.css", import.meta.url));
const styles = readFileSync(stylesPath, "utf8");

const report = {
  enabled: true,
  daily_cap: 5_000_000,
  providers: [
    { key: "claude_code", label: "Claude", reports_usage: true },
    { key: "codex", label: "Codex", reports_usage: true },
  ],
  totals: { total: 5_000_000 },
  today: {
    since: 1_787_702_400,
    until: 1_787_702_400 + 14 * 3600,
    totals: { total: 5_000_000 },
    groups: [
      { provider: "claude_code", total: 3_000_000 },
      { provider: "codex", total: 2_000_000 },
    ],
    compare_totals: { total: 4_000_000 },
  },
  by_role: [],
  top_tasks: [],
  buckets: [
    { key: "2026-08-13", groups: [{ provider: "claude_code", total: 1_000_000 }] },
    {
      key: "2026-08-26",
      groups: [
        { provider: "claude_code", total: 3_000_000 },
        { provider: "codex", total: 2_000_000 },
      ],
    },
  ],
};

test("rendered bar tip, quota line, and cap tick share one y for equal values", async () => {
  const markup = renderToStaticMarkup(
    h(UsageReportScreen, { report, bucket: "day" })
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<!doctype html><html><head><style>${styles}</style></head><body>${markup}</body></html>`,
      { waitUntil: "load" }
    );
    const geometry = await page.evaluate(() => {
      const stack = document.querySelector(".usage-chart-col.is-today .usage-chart-stack");
      const cap = document.querySelector(".usage-chart-cap");
      const tick = document.querySelector(".usage-chart-yaxis > span.is-cap");
      if (!stack || !cap || !tick) {
        return { ok: false, reason: "missing stack/cap/tick" };
      }
      const stackRect = stack.getBoundingClientRect();
      const capRect = cap.getBoundingClientRect();
      const tickRect = tick.getBoundingClientRect();
      return {
        ok: true,
        barTop: stackRect.top,
        capTop: capRect.top,
        tickCenter: tickRect.top + tickRect.height / 2,
      };
    });
    assert.equal(geometry.ok, true, geometry.reason || "geometry probe failed");
    // Cap uses border-top; compare against the line's top edge. Tick is
    // translateY(50%)-centered on the same bottom:% anchor.
    assert.ok(
      Math.abs(geometry.barTop - geometry.capTop) <= 2,
      `bar top ${geometry.barTop} vs cap ${geometry.capTop}`
    );
    assert.ok(
      Math.abs(geometry.barTop - geometry.tickCenter) <= 3,
      `bar top ${geometry.barTop} vs tick center ${geometry.tickCenter}`
    );
  } finally {
    await browser.close();
  }
});
