// Pending proposal cards must never push the Orchestrator's composer out of
// the pane with nothing to scroll.
//
// `.task-workspace-center` is `overflow: hidden` and `.task-orch` is a
// `height: 100%` column, so whatever the proposals band asks for is taken from
// the bottom of the pane and then clipped: one tall card, or three ordinary
// ones, and the Start/Dismiss buttons plus the whole composer sat below the
// clipped edge with no scrollbar anywhere.
//
// Measured in a real browser because that is the only place the clip exists —
// jsdom has no layout, and a rule-text assertion would stay green through it.
// The pane is mounted from the app's own component and the app's own
// stylesheet, bundled with esbuild; no relay, no private build.
//
//   npm run test:browser:orch-proposal-scroll
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import * as esbuild from "esbuild";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";

const ROOT = process.cwd();
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);

const HARNESS_ENTRY = `
import React from "react";
import { createRoot } from "react-dom/client";

import { TaskTeamScreen } from ${JSON.stringify(path.join(ROOT, "frontend/shared/task-team-react.js"))};

const h = React.createElement;
const params = new URLSearchParams(window.location.search);
const count = Math.max(1, Number(params.get("proposals") || 1));

// Verbatim shape of the card in the bug report: a long "why" paragraph and all
// three seats named.
const WHY =
  "Opus 5 at xhigh leads because this is a recovery and integration job: it must " +
  "distinguish the useful uncommitted implementation from stale branch history, " +
  "preserve the old evidence, constrain the work to one developer, and insist on " +
  "browser/cross-surface proof. Sonnet 5 at xhigh is the single developer because " +
  "the implementation already exists and the remaining work is a tightly coupled " +
  "port, reconciliation, and test pass rather than parallel feature construction. " +
  "GPT-5.6-Sol at high is the reviewer because the original direct Claude task had " +
  "no independent reviewer, and the risky boundary is the contract between Rust " +
  "promotion lineage, snapshot transport, and frontend cached state.";

const proposals = Array.from({ length: count }, (_, index) => ({
  id: "proposal-" + (index + 1),
  kind: "start_task",
  title: "Recover and finish the Orchestrator pending-ID promotion fix " + (index + 1),
  why: WHY,
  team_name: "Default",
  agents: {
    tl: { provider: "claude_code", model: "default", effort: "xhigh" },
    dev: { provider: "claude_code", model: "sonnet", effort: "xhigh" },
    reviewer: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
  },
}));

createRoot(document.getElementById("root")).render(
  h(TaskTeamScreen, {
    runs: [],
    loading: false,
    orchestrator: {
      entries: [],
      loading: false,
      canWrite: true,
      proposals,
      onSend: () => {},
      onConfirmProposal: () => {},
      onDismissProposal: () => {},
    },
  })
);
`;

const HARNESS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <link rel="stylesheet" href="/styles.css">
    <style>
      html, body, #root { height: 100%; margin: 0; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/harness.js"></script>
  </body>
</html>
`;

/**
 * The pane's geometry once every box the user can drag has been dragged to one
 * end. `overflow: hidden` boxes are deliberately left alone: they still move
 * when a script assigns scrollTop, and scrolling those is how the first version
 * of this test reported the clipped pane as reachable.
 */
async function measureAtScrollEnd(page, edge) {
  return page.evaluate((wantedEdge) => {
    const scrollers = [...document.querySelectorAll("*")].filter((el) => {
      const overflowY = getComputedStyle(el).overflowY;
      return overflowY === "auto" || overflowY === "scroll";
    });
    for (const el of scrollers) {
      el.scrollTop = wantedEdge === "bottom" ? el.scrollHeight : 0;
    }

    const clip = document.querySelector(".task-workspace-center").getBoundingClientRect();
    const box = (el) => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
    };
    const actions = [...document.querySelectorAll(".task-orch-proposal-actions")];
    return {
      clip: { top: Math.round(clip.top), bottom: Math.round(clip.bottom) },
      composer: box(document.querySelector(".task-orch-composer")),
      cardActions: actions.map(box),
      // Anything the clip is hiding must be hidden because the user has not
      // scrolled to it, not because the pane itself was scrolled off.
      clippedAncestorScrollTop: Math.round(
        document.querySelector(".task-workspace-center").scrollTop
      ),
    };
  }, edge);
}

function within(clip, rect) {
  return Boolean(rect) && rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1;
}

async function assertReachable(page, label) {
  const atTop = await measureAtScrollEnd(page, "top");
  const atBottom = await measureAtScrollEnd(page, "bottom");
  if (process.env.DEBUG_LAYOUT) {
    console.log(label, JSON.stringify({ atTop, atBottom }, null, 2));
  }

  for (const [edge, layout] of [["top", atTop], ["bottom", atBottom]]) {
    assert.equal(
      layout.clippedAncestorScrollTop,
      0,
      `${label} (${edge}): the clipped pane must not be scrolled — that would fake reachability`
    );
    assert.ok(layout.composer, `${label} (${edge}): the composer must render`);
    assert.equal(
      within(layout.clip, layout.composer),
      true,
      `${label} (${edge}): the composer must stay inside the pane — pane is ` +
        `${layout.clip.top}..${layout.clip.bottom}, composer is ` +
        `${layout.composer.top}..${layout.composer.bottom}`
    );
  }

  // Scrolled up, the first card's buttons are on screen; scrolled down, the
  // last card's are. Between them every card in the band is reachable.
  assert.ok(atTop.cardActions.length, `${label}: the proposal cards must render their actions`);
  assert.equal(
    within(atTop.clip, atTop.cardActions[0]),
    true,
    `${label}: the first card's buttons must be on screen at the top of the band — ` +
      `pane is ${atTop.clip.top}..${atTop.clip.bottom}, buttons are ` +
      `${atTop.cardActions[0]?.top}..${atTop.cardActions[0]?.bottom}`
  );
  const last = atBottom.cardActions[atBottom.cardActions.length - 1];
  assert.equal(
    within(atBottom.clip, last),
    true,
    `${label}: the last card's buttons must be on screen at the bottom of the band — ` +
      `pane is ${atBottom.clip.top}..${atBottom.clip.bottom}, buttons are ` +
      `${last?.top}..${last?.bottom}`
  );
}

async function main() {
  const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-orch-proposal-scroll-"));
  const entryPath = path.join(buildDir, "entry.js");
  await fs.writeFile(entryPath, HARNESS_ENTRY, "utf8");
  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "browser",
    absWorkingDir: ROOT,
    // The entry lives in a temp dir, so bare `react` has no node_modules to
    // walk up to.
    nodePaths: [path.join(ROOT, "node_modules")],
    outfile: path.join(buildDir, "harness.js"),
    logLevel: "silent",
  });
  await fs.rm(entryPath);
  await fs.writeFile(path.join(buildDir, "index.html"), HARNESS_HTML, "utf8");
  await fs.copyFile(path.join(ROOT, "frontend/styles.css"), path.join(buildDir, "styles.css"));

  const server = await startStaticServer({ rootDir: buildDir });
  const { browser, context } = await launchBrowser({
    contextOptions: { viewport: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  try {
    // One card that is taller than the space the pane leaves for it.
    // 1000px keeps the pane the width it has in the app, where a sidebar and
    // the 360px task-detail rail flank it; the card's paragraph wraps taller
    // than the viewport there and nowhere near it at 1280.
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto(`http://127.0.0.1:${server.port}/?proposals=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector(".task-orch-proposal-actions", { timeout: TIMEOUT_MS });
    await page.waitForTimeout(100);
    await assertReachable(page, "one tall proposal");

    // Several ordinary cards, which overflow at any height.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`http://127.0.0.1:${server.port}/?proposals=3`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector(".task-orch-proposal-actions", { timeout: TIMEOUT_MS });
    await page.waitForTimeout(100);
    await assertReachable(page, "three proposals");

    console.log("orchestrator proposal scroll e2e: ok");
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "orchestrator-proposal-scroll",
      localPage: page,
    });
    throw error;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await server.close();
    await fs.rm(buildDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
