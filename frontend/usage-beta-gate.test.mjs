// The beta gate for the Usage screen — same shape as Tasks.
// Locked means the real numbers never reach the DOM (blur is not the gate).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { betaFeaturesEnabled, usageLocked } from "./shared/beta-gate.js";
import { USAGE_FIXTURE } from "./shared/usage-fixture.js";
import { UsageReportScreen } from "./shared/usage-report-react.js";
import { SidebarNav, SidebarNavRail } from "./shared/sidebar-nav.js";

const h = React.createElement;
const noop = () => {};
const ALL = { onOpenSessions: noop, onOpenTasks: noop, onOpenUsage: noop };

test("the usage gate fails closed on anything that does not explicitly enable beta", () => {
  // Same wire-shaped hostility the task gate is pinned against: this is JSON,
  // so "1" and 1 are both things a producer could send and neither unlocks.
  assert.equal(usageLocked({ beta_features_enabled: true }), false);
  assert.equal(usageLocked({ beta_features_enabled: false }), true);
  assert.equal(usageLocked({ beta_features_enabled: "1" }), true);
  assert.equal(usageLocked({ beta_features_enabled: 1 }), true);
  assert.equal(usageLocked({}), true);
  assert.equal(usageLocked(null), true);
  assert.equal(usageLocked(undefined), true);
  // And it is the SAME fact as the task gate, not a second flag that could drift.
  assert.equal(usageLocked({}), !betaFeaturesEnabled({}));
});

test("a locked Usage screen shows the in-development notice, not the real spend", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { locked: true, report: USAGE_FIXTURE, bucket: "day" })
  );
  assert.ok(
    html.includes("usage-locked"),
    "the locked screen should render the locked preview wrapper"
  );
  assert.match(html, /in development|building this/i);
  // The gate is absence, not blur.
  assert.ok(
    !html.includes("2.9M"),
    "a locked screen must not render the real headline total"
  );
  assert.doesNotMatch(
    html,
    /Running work finishes|When the quota runs out/,
    "a locked screen must not render the quota policy controls"
  );
  assert.doesNotMatch(
    html,
    /still stubs|quota controls on it are still stubs/i,
    "budget is real now — locked copy must not call quota a stub"
  );
});

test("a locked Usage screen hides its placeholder from assistive tech", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { locked: true, report: USAGE_FIXTURE, bucket: "day" })
  );
  // Anchored to the scenery element, not to any `aria-hidden` on the page: a bare
  // /aria-hidden="true"/ match passes on every screen that renders one decorative
  // glyph, so it would have gone green before this preview existed at all.
  // A screen reader reading out invented token counts would be a lie, not a preview.
  assert.match(html, /class="usage-locked-scenery"[^>]*aria-hidden="true"/);
  // The notice itself must stay announceable — it is the only true thing here.
  assert.match(html, /role="status"/);
});

test("an unlocked Usage screen is untouched by the gate", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { locked: false, report: USAGE_FIXTURE, bucket: "day" })
  );
  assert.match(html, /2\.9M/);
  assert.ok(!html.includes("usage-locked"));
});

test("the nav marks Usage as Beta while it is locked, and only Usage", () => {
  for (const Component of [SidebarNav, SidebarNavRail]) {
    const html = renderToStaticMarkup(
      h(Component, { ...ALL, usageBeta: true, tasksBeta: false })
    );
    assert.ok(
      html.includes("data-destination=\"usage\""),
      `${Component.name} must still offer Usage while it is locked — beta says so, it does not hide`
    );
  }
  // The pill is a labelled-row affordance; the icon rail has no room for it.
  const rows = renderToStaticMarkup(h(SidebarNav, { ...ALL, usageBeta: true, tasksBeta: false }));
  assert.ok(rows.includes("sidebar-nav-beta"), "the Usage row should carry a Beta pill");
  assert.equal(
    rows.match(/sidebar-nav-beta/g).length,
    1,
    "only the locked destination should be badged"
  );
});

// The local surface's half of the gate. These are source assertions for the same
// reason sidebar-chrome.test.mjs uses them: render-session is imperative and owns
// its own mounts, so there is no seam to render it through. The invariant is worth
// pinning anyway — it is the one part of the gate a user could observe over the
// network rather than on screen.
const renderSession = readFileSync(
  fileURLToPath(new URL("./local/render-session.js", import.meta.url)),
  "utf8"
);

test("a locked build never asks the relay for a usage report", () => {
  // The guard belongs in the loader, not at its call sites: the screen is loaded
  // from the render pass, from a bucket switch and from Retry, and a guard per
  // call site is a guard somebody forgets to add to the fourth one.
  const loader = renderSession.slice(renderSession.indexOf("async function loadUsageReport"));
  const body = loader.slice(0, loader.indexOf("\n  }\n"));
  assert.ok(
    /usageLocked\(/.test(body),
    "loadUsageReport must consult the beta gate before fetching"
  );
  assert.ok(
    body.indexOf("usageLocked(") < body.indexOf("fetchUsage("),
    "the gate must be checked BEFORE the fetch, not alongside it"
  );
});

test("the local surface passes the gate down to both the screen and the nav", () => {
  assert.match(
    renderSession,
    /locked:\s*usageLocked\(/,
    "the Usage screen must be told it is locked, or it renders the real report"
  );
  assert.match(
    renderSession,
    /usageBeta:\s*usageLocked\(/,
    "the nav must badge Usage from the same fact the screen locks on"
  );
});

test("the two beta pills are independent facts", () => {
  const neither = renderToStaticMarkup(
    h(SidebarNav, { ...ALL, usageBeta: false, tasksBeta: false })
  );
  assert.ok(!neither.includes("sidebar-nav-beta"));

  const both = renderToStaticMarkup(h(SidebarNav, { ...ALL, usageBeta: true, tasksBeta: true }));
  assert.equal(both.match(/sidebar-nav-beta/g).length, 2);
});
