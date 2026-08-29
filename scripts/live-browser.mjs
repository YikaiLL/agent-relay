// CLI for the live-browser harness. See scripts/e2e/harness/live-browser.mjs.
import process from "node:process";

import {
  attachLivePage,
  clickLive,
  findLive,
  gotoLive,
  liveUsage,
  openLiveBrowser,
  parseLiveArgs,
  pressLive,
  screenshotLive,
  toEvaluationSource,
  waitForLive,
} from "./e2e/harness/live-browser.mjs";

function emit(value) {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

let args;
try {
  args = parseLiveArgs(process.argv.slice(2));
} catch (error) {
  console.error(`${error.message}\n\n${liveUsage()}`);
  process.exit(1);
}

const { command, target, within, nth, touch, state, timeout, file, selector, match, port } = args;

if (command === "open") {
  const info = await openLiveBrowser({ url: target, port });
  if (info.isSystemChrome === false) {
    // The premise is the user's own browser, so name it when it is not.
    console.error(
      "[live] WARNING: no system Chrome found — fell back to Playwright's Chromium. " +
        "Reproductions here are NOT in the user's browser."
    );
  }
  emit(info);
  process.exit(0);
}

const { page, pages, detach } = await attachLivePage({
  match: match ?? process.env.LIVE_MATCH,
  port,
});
console.error(`[live] ${pages.length} page(s); driving ${page.url().slice(0, 80)}`);

try {
  await run();
} catch (error) {
  // Operating errors: the message is the payload, so print it bare.
  console.error(`[live] ${error.message}`);
  process.exitCode = 1;
} finally {
  await detach();
}

async function run() {
  if (command === "pages") {
    emit(await Promise.all(pages.map(async (p) => ({ url: p.url(), title: await p.title() }))));
  } else if (command === "eval") {
    emit(await page.evaluate(toEvaluationSource(target)));
  } else if (command === "find") {
    emit(await findLive(page, { selector: target, within }));
  } else if (command === "click" || command === "tap") {
    const result = await clickLive(page, { selector: target, within, nth, touch });
    if (result.blockedBy) {
      console.error(
        `[live] WARNING: the click landed on ${result.blockedBy.tag}.${result.blockedBy.class} — ` +
          "something is covering the target."
      );
    }
    emit(result);
  } else if (command === "wait") {
    const result = await waitForLive(page, { selector: target, within, state, timeout });
    emit(result);
    if (!result.ok) process.exitCode = 2;
  } else if (command === "shot") {
    emit(await screenshotLive(page, { file, selector, within, nth }));
  } else if (command === "key") {
    emit(await pressLive(page, { key: target }));
  } else if (command === "goto") {
    const result = await gotoLive(page, { url: target, timeout });
    if (result.url !== result.requested) {
      console.error(
        `[live] NOTE: asked for ${result.requested} but landed on ${result.url} — ` +
          "the app rewrote the URL."
      );
    }
    emit(result);
  }
}
