// CSS defects the suite cannot see, because jsdom has no layout: a 420px panel in a
// 320px clipped rail scrolled the whole column sideways when the filter took focus.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAW_CSS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "styles.css"),
  "utf8"
);
// Stripped once: the prose comments in this stylesheet contain braces, semicolons and
// selector names, any of which would truncate the backwards scan for a rule head.
const CSS = RAW_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

// Matches a WHOLE comma-separated selector, never a rule that merely ends with the
// text — `.workspace-picker-panel` must not be answered by `.foo .workspace-picker-panel`.
function ruleBody(selector, css = CSS) {
  for (let from = 0; ; ) {
    const at = css.indexOf(selector, from);
    assert.notEqual(at, -1, `no rule found for ${selector}`);
    from = at + selector.length;

    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    if (open === -1 || close === -1) continue;

    const headStart =
      Math.max(
        css.lastIndexOf("}", at),
        css.lastIndexOf("{", at),
        css.lastIndexOf(";", at)
      ) + 1;
    const selectors = css
      .slice(headStart, open)
      .split(",")
      .map((one) => one.trim());
    if (!selectors.includes(selector)) continue;
    return css.slice(open + 1, close);
  }
}

function declaration(body, property) {
  const match = body.match(new RegExp(`(?:^|;|\\n)\\s*${property}\\s*:\\s*([^;\\n]+)`));
  return match ? match[1].trim() : null;
}

test("the panel is sized to its column inside the rail, which clips horizontally", () => {
  const railed = ruleBody(".right-rail .workspace-picker-panel");
  assert.equal(
    declaration(railed, "width"),
    "100%",
    "a panel wider than the rail makes the rail scrollable, and focusing the filter "
      + "input then scrolls the whole column sideways"
  );
});

test("the unscoped panel still gets a width, so the dialogs keep the roomier one", () => {
  const base = ruleBody(".workspace-picker-panel");
  const width = declaration(base, "width");
  assert.ok(width, "the panel must declare a width somewhere");
  assert.match(
    width,
    /min\(/,
    "the dialog panel is viewport-clamped rather than fixed, so a narrow window cannot cut it off"
  );
});

// The LIST scrolls, not the panel: otherwise the filter and the footer scroll away with
// the rows, and the footer is the only route to an unseen directory.
test("the list scrolls, not the panel", () => {
  const panel = ruleBody(".workspace-picker-panel");
  assert.equal(declaration(panel, "overflow"), "hidden");
  assert.ok(
    declaration(panel, "max-height"),
    "without a cap the panel grows past the viewport instead of scrolling"
  );

  const list = ruleBody(".workspace-picker-groups");
  assert.equal(declaration(list, "overflow-y"), "auto");
  assert.equal(
    declaration(list, "min-height"),
    "0",
    "a flex child will not shrink below its content without this, so it never scrolls"
  );
});

// `justify-content: center` is set globally on `button`, which makes `text-align: left`
// alone a no-op on a flex button — the same trap the project-switcher guard exists for.
test("left-aligned picker buttons set both text-align and justify-content", () => {
  for (const selector of [".workspace-picker-row", ".workspace-picker-footer"]) {
    const body = ruleBody(selector);
    assert.equal(declaration(body, "text-align"), "left", `${selector} text-align`);
    assert.equal(
      declaration(body, "justify-content"),
      "flex-start",
      `${selector} needs justify-content too, or the global button rule centres it`
    );
  }
});

// Long branch names are the norm here (`feature/public-broker-db-persistence`). In a
// 304px column every one of these must be able to shrink rather than push the row wide.
test("every long-text cell in a row can actually ellipsize", () => {
  for (const selector of [
    ".workspace-picker-row-primary",
    ".workspace-picker-row-where",
    ".workspace-picker-footer-action",
  ]) {
    const body = ruleBody(selector);
    assert.equal(declaration(body, "min-width"), "0", `${selector} needs min-width: 0 to shrink`);
    assert.equal(declaration(body, "overflow"), "hidden", `${selector} overflow`);
    assert.equal(
      declaration(body, "text-overflow"),
      "ellipsis",
      `${selector} must ellipsize, not clip mid-glyph`
    );
    assert.equal(declaration(body, "white-space"), "nowrap", `${selector} white-space`);
  }
});
