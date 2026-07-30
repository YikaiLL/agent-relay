// Drives the local web UI to verify the shell redesign: the far-left icon rail, the
// consolidated Settings modal (Providers/Devices/Log/Appearance), Settings reachability
// on a narrow (mobile) viewport, the project actions menu (visible button + right-click),
// the icon-rail folder re-expanding a collapsed sidebar, and the live footer status.
// Run: AGENT_PROVIDERS=fake node scripts/browser-local-shell-redesign-e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);

// Open the sessions/projects <details> drawer so its list rows are laid out (it's
// collapsed off the conversation view).
async function openThreadDrawer(page) {
  await page.evaluate(() => {
    const d = document.querySelector(".sidebar-drawer");
    if (d && !d.open) {
      d.open = true;
      d.dispatchEvent(new Event("toggle"));
    }
  });
}

async function run() {
  const relayPort = await getFreePort();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "shell-redesign-e2e-"));
  const relay = startLocalRelay({
    relayPort,
    relayStatePath: path.join(tmp, "session.json"),
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });

  let browser;
  const consoleErrors = [];
  const pageErrors = [];
  try {
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
    const launched = await launchBrowser();
    browser = launched.browser;
    const page = await launched.context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    let promptValue = "Alpha Project";
    page.on("dialog", async (d) => {
      await d.accept(d.type() === "prompt" ? promptValue : undefined);
    });

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".local-frame", { timeout: TIMEOUT_MS });
    await page.waitForTimeout(500);

    // --- Icon rail: logo + home(active) + gear, no bell ---
    const rail = await page.evaluate(() => {
      const r = document.querySelector(".icon-rail");
      return {
        present: !!r,
        hasLogo: !!r?.querySelector(".icon-rail-logo"),
        homeActive: !!r?.querySelector("#icon-rail-home.is-active"),
        hasGear: !!r?.querySelector("#icon-rail-settings"),
        buttons: r ? r.querySelectorAll("button").length : 0,
      };
    });
    assert.ok(rail.present && rail.hasLogo && rail.homeActive && rail.hasGear, `icon rail: ${JSON.stringify(rail)}`);
    assert.equal(rail.buttons, 2, "icon rail has exactly home + gear (no bell)");

    // --- Settings modal + tabs (desktop entry: rail gear) ---
    await page.click("#icon-rail-settings");
    await page.waitForFunction(() => document.querySelector("#settings-modal")?.open, { timeout: TIMEOUT_MS });
    for (const tab of ["providers", "devices", "log", "appearance"]) {
      await page.click(`#settings-tab-${tab}`);
      const ok = await page.evaluate((t) => {
        const panel = document.querySelector(`[data-settings-panel="${t}"]`);
        const others = [...document.querySelectorAll("[data-settings-panel]")].filter(
          (p) => p.getAttribute("data-settings-panel") !== t
        );
        return panel && !panel.hidden && others.every((p) => p.hidden);
      }, tab);
      assert.ok(ok, `settings tab "${tab}" activates its panel`);
    }
    // Devices tab carries the pairing controls the harness relies on.
    await page.click("#settings-tab-devices");
    const devicesOk = await page.evaluate(() =>
      ["#pending-pairings-list", "#allowed-roots-form", "#paired-devices-list", "#start-pairing-button"].every(
        (s) => !!document.querySelector(s)
      )
    );
    assert.ok(devicesOk, "Devices tab exposes pairing/roots/devices controls");
    await page.click("#close-settings-modal");
    await page.waitForFunction(() => !document.querySelector("#settings-modal")?.open);

    // --- Footer status reflects the live SSE stream (connected -> Live) ---
    const footer = await page.evaluate(() => {
      const el = document.querySelector("#sidebar-host-status");
      return { text: document.querySelector("#sidebar-host-label")?.textContent || "", degraded: el?.classList.contains("is-degraded") };
    });
    assert.ok(/Live/.test(footer.text) && !footer.degraded, `footer live while stream connected: ${JSON.stringify(footer)}`);

    // --- Folder re-expands a collapsed sidebar ---
    await page.click("#sidebar-top-toggle");
    await page.waitForFunction(() => document.body.classList.contains("sidebar-collapsed"), { timeout: TIMEOUT_MS });
    await page.click("#icon-rail-home");
    await page.waitForFunction(() => !document.body.classList.contains("sidebar-collapsed"), { timeout: TIMEOUT_MS });

    // --- Project actions: visible button opens the menu, Rename works ---
    await page.click("#threads-view-projects");
    await openThreadDrawer(page);
    await page.click("#projects-create-button");
    await page.waitForSelector("#threads-list .project-sidebar-row", { state: "visible", timeout: TIMEOUT_MS });

    // (a) the visible actions button (keyboard/touch reachable) opens the menu
    await page.locator("#threads-list .project-sidebar-more").first().click();
    await page.waitForSelector("#project-context-menu:not([hidden])", { timeout: TIMEOUT_MS });
    // Rename via the menu -> prompt -> row text updates
    promptValue = "Beta Project";
    await page.click("#rename-project-button");
    await page.waitForFunction(
      () => (document.querySelector("#threads-list .project-sidebar-name")?.textContent || "").includes("Beta"),
      { timeout: TIMEOUT_MS }
    );

    // (b) right-click also opens the menu AND executes a rename (mouse path)
    promptValue = "Gamma Project";
    await page.locator("#threads-list .project-sidebar-row").first().click({ button: "right" });
    await page.waitForSelector("#project-context-menu:not([hidden])", { timeout: TIMEOUT_MS });
    await page.click("#rename-project-button");
    await page.waitForFunction(
      () => (document.querySelector("#threads-list .project-sidebar-name")?.textContent || "").includes("Gamma"),
      { timeout: TIMEOUT_MS }
    );

    // (c) keyboard path: focus the ⋯ button, Enter opens the menu, and the menu's
    // Rename/Delete buttons are focusable (project management is not mouse-only).
    await page.locator("#threads-list .project-sidebar-more").first().focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector("#project-context-menu:not([hidden])", { timeout: TIMEOUT_MS });
    await page.locator("#rename-project-button").focus();
    const renameFocusable = await page.evaluate(() => document.activeElement?.id === "rename-project-button");
    assert.ok(renameFocusable, "Rename is keyboard-focusable in the project actions menu");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("#project-context-menu")?.hidden, { timeout: TIMEOUT_MS });

    // --- Deleting the selected project must not strand a stale selection ---
    // Add a sibling so there's something to fall back to after deletion.
    promptValue = "Second Project";
    await page.click("#projects-create-button");
    await page.waitForFunction(
      () => [...document.querySelectorAll("#threads-list .project-sidebar-name")].some((n) => /Second/.test(n.textContent || "")),
      { timeout: TIMEOUT_MS }
    );
    // Select "Gamma" so it's the active project entering the delete.
    await page.locator("#threads-list .project-sidebar-row", { hasText: "Gamma" }).first().click();
    await page.waitForFunction(
      () => {
        const active = document.querySelector("#threads-list .project-sidebar-row.is-active .project-sidebar-name")?.textContent?.trim();
        return active === "Gamma Project" && document.querySelector(".chat-shell")?.getAttribute("data-view") === "project-overview";
      },
      { timeout: TIMEOUT_MS }
    );
    // Delete it -> the sibling "Second Project" must auto-select (not linger on the dead id).
    await page.locator("#threads-list .project-sidebar-row", { hasText: "Gamma" }).first().click({ button: "right" });
    await page.waitForSelector("#project-context-menu:not([hidden])", { timeout: TIMEOUT_MS });
    await page.click("#delete-project-button");
    await page.waitForFunction(
      () => {
        const names = [...document.querySelectorAll("#threads-list .project-sidebar-name")].map((n) => n.textContent.trim());
        const active = document.querySelector("#threads-list .project-sidebar-row.is-active .project-sidebar-name")?.textContent?.trim();
        return !names.some((n) => /Gamma/.test(n)) && active === "Second Project" &&
          document.querySelector(".chat-shell")?.getAttribute("data-view") === "project-overview";
      },
      { timeout: TIMEOUT_MS }
    );
    // Delete the LAST remaining project -> the selection clears (view leaves the overview).
    await page.locator("#threads-list .project-sidebar-row", { hasText: "Second" }).first().click({ button: "right" });
    await page.waitForSelector("#project-context-menu:not([hidden])", { timeout: TIMEOUT_MS });
    await page.click("#delete-project-button");
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#threads-list .project-sidebar-row").length === 0 &&
        document.querySelector(".chat-shell")?.getAttribute("data-view") !== "project-overview",
      { timeout: TIMEOUT_MS }
    );
    // A newly-created project auto-selects again (the stale id no longer blocks it).
    promptValue = "Fresh Project";
    await page.click("#projects-create-button");
    await page.waitForFunction(
      () => {
        const active = document.querySelector("#threads-list .project-sidebar-row.is-active .project-sidebar-name")?.textContent?.trim();
        return active === "Fresh Project" && document.querySelector(".chat-shell")?.getAttribute("data-view") === "project-overview";
      },
      { timeout: TIMEOUT_MS }
    );

    // --- Real SSE disconnect -> polling -> reconnect updates the footer status ---
    // Block the stream so the client falls back to /api/session polling (footer
    // "Polling"), then restore it so the stream reconnects (footer "Live").
    const streamPage = await launched.context.newPage();
    await streamPage.route("**/api/stream", (route) => route.abort());
    await streamPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await streamPage.waitForSelector(".local-frame", { timeout: TIMEOUT_MS });
    await streamPage.waitForFunction(
      () => {
        const el = document.querySelector("#sidebar-host-status");
        return (
          el?.classList.contains("is-degraded") &&
          /Polling/.test(document.querySelector("#sidebar-host-label")?.textContent || "")
        );
      },
      { timeout: TIMEOUT_MS }
    );
    await streamPage.unroute("**/api/stream");
    await streamPage.waitForFunction(
      () => {
        const el = document.querySelector("#sidebar-host-status");
        return (
          !el?.classList.contains("is-degraded") &&
          /Live/.test(document.querySelector("#sidebar-host-label")?.textContent || "")
        );
      },
      { timeout: TIMEOUT_MS }
    );
    await streamPage.close();

    // --- Mobile (narrow) viewport: rail hidden, header gear reaches Settings ---
    // Reload into a clean state so the stacked mobile layout puts the sticky header
    // near the top (the prior projects/drawer state would push it far down).
    // View context now deliberately survives reload, so select Sessions explicitly
    // instead of relying on reload to reset a preceding Projects-mode scenario.
    await page.click("#threads-view-sessions");
    await page.waitForFunction(
      () => document.querySelector(".sidebar")?.dataset.threadView === "sessions",
      { timeout: TIMEOUT_MS }
    );
    await page.setViewportSize({ width: 390, height: 780 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".local-frame", { timeout: TIMEOUT_MS });
    await page.waitForTimeout(400);
    const mobile = await page.evaluate(() => {
      const rail = document.querySelector(".icon-rail");
      const railHidden = !rail || getComputedStyle(rail).display === "none" || rail.offsetParent === null;
      const gear = document.querySelector("#open-settings-header");
      const gearVisible = !!gear && getComputedStyle(gear).display !== "none";
      return { railHidden, gearVisible };
    });
    assert.ok(mobile.railHidden, "icon rail is hidden on narrow viewport");
    assert.ok(mobile.gearVisible, "header Settings gear is visible on narrow viewport");
    await page.click("#open-settings-header");
    await page.waitForFunction(() => document.querySelector("#settings-modal")?.open, { timeout: TIMEOUT_MS });
    await page.click("#settings-tab-log");
    const mobileLogOk = await page.evaluate(() => {
      const panel = document.querySelector('[data-settings-panel="log"]');
      return panel && !panel.hidden;
    });
    assert.ok(mobileLogOk, "Settings tabs switch on narrow viewport");

    // --- 320px: the Settings modal + its tab strip must not overflow horizontally ---
    await page.setViewportSize({ width: 320, height: 700 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".local-frame", { timeout: TIMEOUT_MS });
    await page.waitForTimeout(300);
    await page.click("#open-settings-header");
    await page.waitForFunction(() => document.querySelector("#settings-modal")?.open, { timeout: TIMEOUT_MS });
    const narrow = await page.evaluate(() => {
      const modal = document.querySelector("#settings-modal");
      const tabs = document.querySelector(".settings-tabs");
      return {
        modalOverflowsX: modal.scrollWidth > modal.clientWidth + 2,
        modalWithinViewport: Math.ceil(modal.getBoundingClientRect().right) <= window.innerWidth,
        // tabs wrap rather than scroll, so all four stay reachable without overflow
        tabsOverflowX: tabs ? tabs.scrollWidth > tabs.clientWidth + 2 : true,
      };
    });
    assert.ok(!narrow.modalOverflowsX, `settings modal must not overflow horizontally at 320px: ${JSON.stringify(narrow)}`);
    assert.ok(narrow.modalWithinViewport, `settings modal fits the 320px viewport: ${JSON.stringify(narrow)}`);
    assert.ok(!narrow.tabsOverflowX, `settings tab strip wraps instead of overflowing at 320px: ${JSON.stringify(narrow)}`);

    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(" | ")}`);
    assert.equal(consoleErrors.length, 0, `console errors: ${consoleErrors.join(" | ")}`);

    console.log("browser-local-shell-redesign-e2e: PASS");
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopManagedProcess(relay).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((error) => {
  console.error("browser-local-shell-redesign-e2e: FAIL");
  console.error(error);
  process.exit(1);
});
