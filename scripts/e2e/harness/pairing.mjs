import assert from "node:assert/strict";

// Devices/pairing now lives in the consolidated Settings modal's "Devices" tab
// (#settings-modal), opened from the icon-rail gear (desktop) or the header gear
// (mobile, where the rail is hidden). This helper opens Settings and activates the
// Devices tab so the pairing controls (#start-pairing-button, #pairing-link-input, …)
// are visible — same contract the callers relied on with the old #security-modal.
async function ensureSettingsEntryClicked(page) {
  const railVisible = await page
    .$("#icon-rail-settings")
    .then((el) => (el ? el.isVisible() : false));
  await page.click(railVisible ? "#icon-rail-settings" : "#open-settings-header");
}

export async function openSecurityModal(page) {
  const onDevices = await page.evaluate(() => {
    const modal = document.querySelector("#settings-modal");
    const panel = document.querySelector('[data-settings-panel="devices"]');
    return Boolean(modal?.open) && Boolean(panel) && !panel.hidden;
  });
  if (onDevices) {
    return;
  }

  const modalOpen = await page.evaluate(() =>
    Boolean(document.querySelector("#settings-modal")?.open)
  );
  if (!modalOpen) {
    await ensureSettingsEntryClicked(page);
    await page.waitForFunction(() =>
      Boolean(document.querySelector("#settings-modal")?.open)
    );
  }

  await page.click("#settings-tab-devices");
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-settings-panel="devices"]');
    return Boolean(panel) && !panel.hidden;
  });
}

export async function closeSecurityModal(page, timeoutMs) {
  const isOpen = await page.evaluate(() =>
    Boolean(document.querySelector("#settings-modal")?.open)
  );
  if (!isOpen) {
    return;
  }

  await page.click("#close-settings-modal");
  await page.waitForFunction(
    () => !document.querySelector("#settings-modal")?.open,
    null,
    { timeout: timeoutMs }
  );
}

export async function startPairingFromLocalPage(
  localPage,
  { lanIp, brokerPort, timeoutMs, previousUrl = "" }
) {
  await openSecurityModal(localPage);
  await localPage.click("#start-pairing-button");
  await localPage.waitForFunction(
    (previous) => {
      const input = document.querySelector("#pairing-link-input");
      return Boolean(
        input &&
          input.value.startsWith("http") &&
          (!previous || input.value !== previous)
      );
    },
    previousUrl,
    { timeout: timeoutMs }
  );
  const pairingUrl = await localPage.inputValue("#pairing-link-input");
  assert.ok(
    pairingUrl.startsWith(`http://${lanIp}:${brokerPort}/?pairing=`),
    `pairing url should use broker public url, got: ${pairingUrl}`
  );
  return pairingUrl;
}

export async function approvePairing(localPage, timeoutMs) {
  const approveSelector = "[data-pairing-id][data-pairing-decision='approve']";
  const modalApproveSelector = `#pairing-approval-modal[open] ${approveSelector}`;
  await localPage.waitForFunction(
    ({ approveSelector, modalApproveSelector }) =>
      Boolean(
        document.querySelector(modalApproveSelector) ||
          document.querySelector(approveSelector)
      ),
    { approveSelector, modalApproveSelector },
    { timeout: timeoutMs }
  );

  const modalApproveButton = localPage.locator(modalApproveSelector).first();
  if ((await modalApproveButton.count()) > 0) {
    await modalApproveButton.click({ timeout: timeoutMs });
    return;
  }

  await localPage.locator(approveSelector).first().click({ timeout: timeoutMs });
}

export async function waitForPairedRemote(remotePage, timeoutMs) {
  await remotePage.waitForFunction(
    () => {
      const stored = [
        "agent-relay.remote-state",
        "agent-relay.remote-state-v3",
        "agent-relay.remote-state-v2",
      ]
        .map((key) => {
          try {
            return JSON.parse(window.localStorage.getItem(key) || "null");
          } catch {
            return null;
          }
        })
        .find((value) => value?.remoteProfiles);
      const profiles = stored?.remoteProfiles || {};
      return Boolean(
        Object.keys(profiles).length &&
          (stored.activeRelayId || stored.clientAuth?.clientId)
      );
    },
    null,
    { timeout: timeoutMs }
  );
}
