// Attach to a real Chrome over CDP with a persistent profile, so the page under
// test carries the state a human put there. Dev tool: never wire it into CI.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

export const LIVE_DEBUG_PORT = Number(process.env.LIVE_CHROME_PORT || 9222);
// A dedicated profile keeps app state stable across attaches.
export const LIVE_PROFILE_DIR =
  process.env.LIVE_CHROME_PROFILE || path.join(os.homedir(), ".cache", "sealwire-live-chrome");

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

/** Prefer the Chrome the user browses with, and say so when it is a fallback. */
export async function resolveChrome({ candidates = CHROME_CANDIDATES } = {}) {
  for (const bin of candidates) {
    try {
      await fs.access(bin);
      return { bin, isSystemChrome: true };
    } catch {
      /* next */
    }
  }
  return { bin: chromium.executablePath(), isSystemChrome: false };
}

export async function isLiveBrowserUp(port = LIVE_DEBUG_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The Chrome build on the debug port, so a report can name it. */
export async function liveBrowserVersion(port = LIVE_DEBUG_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const info = await res.json();
    return info.Browser || null;
  } catch {
    return null;
  }
}

/** Start the live browser if it is not already up. */
export async function openLiveBrowser({ port = LIVE_DEBUG_PORT, url } = {}) {
  if (await isLiveBrowserUp(port)) {
    return { alreadyRunning: true, port, browser: await liveBrowserVersion(port) };
  }
  await fs.mkdir(LIVE_PROFILE_DIR, { recursive: true });
  const { bin, isSystemChrome } = await resolveChrome();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${LIVE_PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (url) args.push(url);
  // Detached, so the browser outlives this process.
  const child = spawn(bin, args, { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 60; i += 1) {
    if (await isLiveBrowserUp(port)) {
      return {
        alreadyRunning: false,
        bin,
        isSystemChrome,
        port,
        browser: await liveBrowserVersion(port),
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`live browser did not expose ${port} — is another Chrome holding the profile?`);
}

/** Attach and drive the first page whose URL contains `match`, else the frontmost. */
export async function attachLivePage({ match, port = LIVE_DEBUG_PORT } = {}) {
  if (!(await isLiveBrowserUp(port))) {
    throw new Error(
      `nothing is listening on ${port}. Start it with: node scripts/live-browser.mjs open <url>`
    );
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const pages = browser.contexts().flatMap((c) => c.pages());
  if (!pages.length) throw new Error("the live browser has no open pages");
  const page = (match ? pages.find((p) => p.url().includes(match)) : null) || pages[0];
  // Severs the CDP connection only, leaving the user's Chrome up.
  const detach = () => browser.close();
  return { browser, page, pages, detach };
}

/** Wrap and invoke, so both an expression and a function source return a value. */
export function toEvaluationSource(source) {
  const trimmed = String(source ?? "").trim();
  if (!trimmed) throw new Error("nothing to evaluate");
  // Match on `function` or an arrow: a parenthesised expression also starts "(".
  const looksLikeFunction =
    /^(async\s+)?function\b/.test(trimmed) ||
    /^(async\s+)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(trimmed);
  return looksLikeFunction ? `(${trimmed})()` : `(() => (${trimmed}))()`;
}

// --- CLI parsing: pure and exported, so it is covered without a browser ---

const VALUE_FLAGS = new Set([
  "within",
  "nth",
  "state",
  "timeout",
  "file",
  "selector",
  "match",
  "port",
]);
const BOOLEAN_FLAGS = new Set(["touch"]);
const NUMERIC_FLAGS = new Set(["nth", "timeout", "port"]);
const WAIT_STATES = new Set(["attached", "detached", "visible", "hidden"]);

/** command → does it require a positional target (a selector or expression)? */
export const LIVE_COMMANDS = {
  open: { target: "optional", help: "open [url]" },
  pages: { target: "none", help: "pages" },
  eval: { target: "required", help: "eval '<js>'" },
  find: { target: "required", help: "find '<selector>' [--within <sel>]" },
  click: { target: "required", help: "click '<selector>' [--within <sel>] [--nth N] [--touch]" },
  tap: { target: "required", help: "tap '<selector>' [--within <sel>] [--nth N]" },
  wait: {
    target: "required",
    help: "wait '<selector>' [--state visible|hidden|attached|detached] [--timeout ms]",
  },
  shot: { target: "none", help: "shot [--file <path>] [--selector <sel>] [--nth N]" },
  key: { target: "required", help: "key '<Escape|Enter|…>'" },
  goto: { target: "required", help: "goto '<url>'" },
};

export function liveUsage() {
  return [
    "usage: live-browser.mjs <command>",
    ...Object.values(LIVE_COMMANDS).map((c) => `  ${c.help}`),
  ].join("\n");
}

export function parseLiveArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new Error("no command given");
  const spec = LIVE_COMMANDS[command];
  if (!spec) throw new Error(`unknown command ${command}`);

  const options = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const flag = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
    if (BOOLEAN_FLAGS.has(flag)) {
      options[flag] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown flag --${flag}`);
    const value = eq === -1 ? rest[++i] : token.slice(eq + 1);
    if (value === undefined) throw new Error(`--${flag} needs a value`);
    if (NUMERIC_FLAGS.has(flag)) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`--${flag} must be a non-negative integer, got ${value}`);
      }
      options[flag] = parsed;
    } else {
      options[flag] = value;
    }
  }

  if (spec.target === "required" && !positional.length) {
    throw new Error(`${command} needs a target: ${spec.help}`);
  }
  if (positional.length > 1) {
    // Two positionals is almost always a forgotten quote around a selector.
    throw new Error(
      `${command} takes one target, got ${positional.length}: ${positional.join(", ")}`
    );
  }
  if (options.state !== undefined && !WAIT_STATES.has(options.state)) {
    throw new Error(`--state must be one of ${[...WAIT_STATES].join(", ")}, got ${options.state}`);
  }

  const touch = command === "tap" ? true : Boolean(options.touch);
  return { command, target: positional[0], ...options, touch };
}

// --- Element reporting: always enumerate, never pick a node on the caller's behalf ---

/** Runs in the page; closes over nothing, so it also runs in Node on a fake DOM. */
export function describeMatchesInPage({ selector, within }) {
  const root = within ? document.querySelector(within) : document;
  if (!root) return { error: `no element matches within-selector ${within}` };
  const round = (n) => Math.round(n * 100) / 100;
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: round(r.x),
      y: round(r.y),
      w: round(r.width),
      h: round(r.height),
      right: round(r.right),
      bottom: round(r.bottom),
    };
  };
  const nodes = [...root.querySelectorAll(selector)];
  return {
    selector,
    within: within || null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    // Reported alongside layout rects, which live in a different frame when displaced.
    visualViewport: window.visualViewport
      ? {
          w: round(window.visualViewport.width),
          h: round(window.visualViewport.height),
          offsetLeft: round(window.visualViewport.offsetLeft),
          offsetTop: round(window.visualViewport.offsetTop),
        }
      : null,
    count: nodes.length,
    matches: nodes.map((el, i) => {
      const style = getComputedStyle(el);
      const box = rect(el);
      const host = el.closest("dialog");
      const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      const hit = box.w && box.h ? document.elementFromPoint(centre.x, centre.y) : null;
      return {
        i,
        tag: el.tagName,
        id: el.id || null,
        class: typeof el.className === "string" ? el.className : null,
        box,
        // Names the owning dialog, so two same-class pickers stay distinguishable.
        dialogHost: host ? host.id || host.className || "(anonymous dialog)" : null,
        dialogOpen: host ? host.open : null,
        disabled: "disabled" in el ? el.disabled : null,
        ariaExpanded: el.getAttribute("aria-expanded"),
        hidden: el.hidden || style.display === "none" || style.visibility === "hidden",
        style: {
          position: style.position,
          display: style.display,
          overflow: style.overflow,
          overflowY: style.overflowY,
          zIndex: style.zIndex,
          top: style.top,
          left: style.left,
          right: style.right,
          bottom: style.bottom,
          width: style.width,
          maxWidth: style.maxWidth,
          maxHeight: style.maxHeight,
          transform: style.transform,
        },
        // A menu past the viewport edge is a defect whatever element it is.
        overflowsViewport: {
          right: box.right > window.innerWidth,
          bottom: box.bottom > window.innerHeight,
          left: box.x < 0,
          top: box.y < 0,
        },
        // An element can be laid out correctly and still sit under a backdrop.
        hitTest: hit
          ? {
              tag: hit.tagName,
              class: typeof hit.className === "string" ? hit.className : null,
              isSelf: hit === el,
              isDescendant: el.contains(hit),
            }
          : null,
      };
    }),
  };
}

/** Enumerate every match for `selector`, with its dialog host and hit test. */
export async function findLive(page, { selector, within } = {}) {
  return page.evaluate(describeMatchesInPage, { selector, within });
}

// Resolve one element to act on; ambiguity is an error the caller settles
// with `within`/`nth`.
export async function resolveOne(page, { selector, within, nth }) {
  const report = await findLive(page, { selector, within });
  if (report.error) throw new Error(report.error);
  if (report.count === 0) {
    throw new Error(`no element matches ${selector}${within ? ` within ${within}` : ""}`);
  }
  if (report.count > 1 && nth === undefined) {
    const hosts = report.matches
      .map(
        (m) =>
          `  [${m.i}] ${m.tag}${m.id ? `#${m.id}` : ""} dialog=${m.dialogHost ?? "none"} box=${m.box.x},${m.box.y} ${m.box.w}x${m.box.h}`
      )
      .join("\n");
    throw new Error(
      `${selector} matches ${report.count} elements — say which with --nth or scope with --within:\n${hosts}`
    );
  }
  const index = nth ?? 0;
  const match = report.matches[index];
  if (!match) throw new Error(`--nth ${index} is out of range (${report.count} matches)`);
  return { report, match, index };
}

// A real pointer click at the measured centre, so layout and the pointer
// pipeline both have to be right for it to land.
export async function clickLive(page, { selector, within, nth, touch = false } = {}) {
  const resolved = await resolveOne(page, { selector, within, nth });
  const { index } = resolved;

  // Scroll first, as a user would, then re-measure: scrolling invalidates rects.
  let scrolled = false;
  try {
    await page
      .locator(within ? `${within} ${selector}` : selector)
      .nth(index)
      .scrollIntoViewIfNeeded({ timeout: 2000 });
    scrolled = true;
  } catch {
    // Already visible, or not in a scroller; the measurement below decides.
  }

  const { match, report } = scrolled
    ? await resolveOne(page, { selector, within, nth: index })
    : resolved;
  const { box } = match;
  if (!box.w || !box.h) {
    throw new Error(`${selector}[${index}] has a zero-sized box — it is not on screen`);
  }
  const x = box.x + box.w / 2;
  const y = box.y + box.h / 2;
  const blockedBy =
    match.hitTest && !match.hitTest.isSelf && !match.hitTest.isDescendant ? match.hitTest : null;

  if (touch) {
    // Drive the protocol: `page.tap()` needs `hasTouch`, unsettable on an
    // already-existing CDP context.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.click(x, y);
  }
  return { clicked: { selector, index, x, y, touch, scrolled }, blockedBy, before: report };
}

// A real navigation, plus the resulting URL: an app owning its router may
// consume the query and rewrite it.
export async function gotoLive(page, { url, waitUntil = "load", timeout = 15000 } = {}) {
  if (!url) throw new Error("goto needs a url");
  await page.goto(url, { waitUntil, timeout });
  return { requested: url, url: page.url(), title: await page.title() };
}

/** Send a real key, usually Escape to clear a menu left open by the last command. */
export async function pressLive(page, { key } = {}) {
  await page.keyboard.press(key);
  return { pressed: key };
}

/** Wait for a selector to reach a state, reporting the enumeration either way. */
export async function waitForLive(
  page,
  { selector, within, state = "visible", timeout = 5000 } = {}
) {
  const scoped = within ? `${within} ${selector}` : selector;
  try {
    await page.waitForSelector(scoped, { state, timeout });
    return { ok: true, state, ...(await findLive(page, { selector, within })) };
  } catch (error) {
    return {
      ok: false,
      state,
      error: error.message.split("\n")[0],
      ...(await findLive(page, { selector, within })),
    };
  }
}

/** Screenshot the live page, or one element. */
export async function screenshotLive(page, { file, selector, within, nth } = {}) {
  const target = file || path.join(os.tmpdir(), `sealwire-live-${Date.now()}.png`);
  if (selector) {
    const { match, index } = await resolveOne(page, { selector, within, nth });
    const locator = page.locator(within ? `${within} ${selector}` : selector).nth(index);
    await locator.screenshot({ path: target });
    return { file: target, of: `${selector}[${index}]`, box: match.box };
  }
  await page.screenshot({ path: target });
  return { file: target, of: "viewport" };
}
