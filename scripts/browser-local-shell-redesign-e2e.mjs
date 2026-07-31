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

    // --- Icon rail: logo + gear only ---
    // The rail's Projects folder was retired: it duplicated the sidebar's own
    // Sessions/Projects toggle, and the one job only it did — bringing a collapsed
    // nav panel back — belongs to #toggle-left-panel (asserted below).
    const rail = await page.evaluate(() => {
      const r = document.querySelector(".icon-rail");
      return {
        present: !!r,
        hasLogo: !!r?.querySelector(".icon-rail-logo"),
        hasHome: !!r?.querySelector("#icon-rail-home"),
        hasGear: !!r?.querySelector("#icon-rail-settings"),
        buttons: r ? r.querySelectorAll("button").length : 0,
      };
    });
    assert.ok(rail.present && rail.hasLogo && rail.hasGear, `icon rail: ${JSON.stringify(rail)}`);
    assert.equal(rail.hasHome, false, `the rail's Projects folder is retired: ${JSON.stringify(rail)}`);
    assert.equal(rail.buttons, 1, "icon rail is the gear only (no home, no bell)");

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

    // --- A collapsed sidebar can be brought back ---
    // This used to go through the icon rail's folder. That button is gone, so the
    // header's panel toggle is now the only way back — which makes this assertion
    // more important, not less: it is the sole escape from a collapsed sidebar.
    // It is rendered only while `body.sidebar-collapsed`, so it cannot be clicked
    // before the collapse lands.
    await page.click("#sidebar-top-toggle");
    await page.waitForFunction(() => document.body.classList.contains("sidebar-collapsed"), { timeout: TIMEOUT_MS });
    await page.click("#toggle-left-panel");
    await page.waitForFunction(() => !document.body.classList.contains("sidebar-collapsed"), { timeout: TIMEOUT_MS });

    // --- Project actions: visible button opens the menu, Rename works ---
    await page.click("#threads-view-projects");
    await openThreadDrawer(page);
    await page.click("#projects-create-button");
    // Projects mode now lists each project as a GROUP HEADER with its sessions nested
    // underneath, so project actions moved from a "⋯ opens a menu" row onto inline
    // buttons on the header. The three access paths this guards are unchanged:
    // visible/tappable, mouse (right-click), and keyboard.
    await page.waitForSelector("#threads-list .thread-group-header-project", {
      state: "visible",
      timeout: TIMEOUT_MS,
    });
    const projectName = () =>
      page.evaluate(
        () => document.querySelector("#threads-list .thread-group-name")?.textContent || ""
      );

    // (a) the inline Rename button (keyboard/touch reachable) renames directly
    promptValue = "Beta Project";
    await page.locator('#threads-list .thread-group-action[title="Rename project"]').first().click();
    await page.waitForFunction(
      () => (document.querySelector("#threads-list .thread-group-name")?.textContent || "").includes("Beta"),
      { timeout: TIMEOUT_MS }
    );

    // (b) right-click on the project header still opens the actions menu (mouse path)
    promptValue = "Gamma Project";
    await page.locator("#threads-list .thread-group-header-project").first().click({ button: "right" });
    await page.waitForSelector("#project-context-menu:not([hidden])", { timeout: TIMEOUT_MS });
    await page.click("#rename-project-button");
    await page.waitForFunction(
      () => (document.querySelector("#threads-list .thread-group-name")?.textContent || "").includes("Gamma"),
      { timeout: TIMEOUT_MS }
    );
    assert.match(await projectName(), /Gamma/, "the header shows the renamed project");

    // (c) keyboard path: the inline action buttons are focusable, so project
    // management is not mouse-only.
    const renameButton = page.locator('#threads-list .thread-group-action[title="Rename project"]').first();
    await renameButton.focus();
    const renameFocusable = await page.evaluate(
      () => document.activeElement?.getAttribute("title") === "Rename project"
    );
    assert.ok(renameFocusable, "Rename is keyboard-focusable on the project header");

    // --- Deleting the selected project must not strand a stale selection ---
    // Add a sibling so there's something to fall back to after deletion.
    promptValue = "Second Project";
    await page.click("#projects-create-button");
    await page.waitForFunction(
      () => [...document.querySelectorAll("#threads-list .thread-group-name")].some((n) => /Second/.test(n.textContent || "")),
      { timeout: TIMEOUT_MS }
    );
    // Select "Gamma" so it's the active project entering the delete. The name is the
    // click target (the header also hosts action buttons), and the main-area card
    // overview is retired — selection now shows only as the header's active state,
    // which is what decides the tab set a new session joins.
    await page
      .locator("#threads-list .thread-group-header-project", { hasText: "Gamma" })
      .first()
      .locator(".thread-group-name-button")
      .click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("#threads-list .thread-group-header-project.is-active .thread-group-name")
          ?.textContent?.trim() === "Gamma Project",
      { timeout: TIMEOUT_MS }
    );
    // Delete it -> the sibling "Second Project" must auto-select (not linger on the dead id).
    await page.locator("#threads-list .thread-group-header-project", { hasText: "Gamma" }).first().click({ button: "right" });
    await page.waitForSelector("#project-context-menu:not([hidden])", { timeout: TIMEOUT_MS });
    await page.click("#delete-project-button");
    await page.waitForFunction(
      () => {
        const names = [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim());
        const active = document.querySelector("#threads-list .thread-group-header-project.is-active .thread-group-name")?.textContent?.trim();
        return !names.some((n) => /Gamma/.test(n)) && active === "Second Project";
      },
      { timeout: TIMEOUT_MS }
    );
    // Delete the LAST remaining project -> the selection clears.
    await page.locator("#threads-list .thread-group-header-project", { hasText: "Second" }).first().click({ button: "right" });
    await page.waitForSelector("#project-context-menu:not([hidden])", { timeout: TIMEOUT_MS });
    await page.click("#delete-project-button");
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#threads-list .thread-group-header-project").length === 0
        && !document.querySelector("#threads-list .thread-group-header-project.is-active"),
      { timeout: TIMEOUT_MS }
    );
    // A newly-created project auto-selects again (the stale id no longer blocks it).
    promptValue = "Fresh Project";
    await page.click("#projects-create-button");
    await page.waitForFunction(
      () => {
        const active = document.querySelector("#threads-list .thread-group-header-project.is-active .thread-group-name")?.textContent?.trim();
        return active === "Fresh Project";
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
