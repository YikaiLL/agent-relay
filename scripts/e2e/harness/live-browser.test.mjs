// The invariant: the harness enumerates matches and refuses to guess which one
// you meant. Runs in Node — the in-page function closes over nothing.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  describeMatchesInPage,
  isLiveBrowserUp,
  liveUsage,
  parseLiveArgs,
  resolveChrome,
  resolveOne,
  toEvaluationSource,
} from "./live-browser.mjs";

// --- fake DOM ---------------------------------------------------------------

function makeElement(spec) {
  const [x, y, w, h] = spec.box || [0, 0, 0, 0];
  const el = {
    tagName: spec.tag || "DIV",
    id: spec.id || "",
    className: spec.className || "",
    hidden: Boolean(spec.hidden),
    disabled: spec.disabled,
    _dialog: spec.dialog || null,
    _style: { position: "absolute", display: "block", ...(spec.style || {}) },
    getBoundingClientRect: () => ({ x, y, width: w, height: h, right: x + w, bottom: y + h }),
    closest: (sel) => (sel === "dialog" ? el._dialog : null),
    getAttribute: (name) => (name === "aria-expanded" ? (spec.ariaExpanded ?? null) : null),
    contains: (other) => other === el,
  };
  return el;
}

/** Install a fake document/window, run `fn`, always restore. */
async function withDom({ elements, within = null, viewport = [1200, 675], topAt }, fn) {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    getComputedStyle: globalThis.getComputedStyle,
  };
  const root = {
    querySelectorAll: () => elements,
  };
  globalThis.document = {
    querySelectorAll: () => elements,
    querySelector: (sel) => (within && sel === within ? root : null),
    elementFromPoint: (x, y) => (topAt ? topAt(x, y) : null),
  };
  globalThis.window = {
    innerWidth: viewport[0],
    innerHeight: viewport[1],
    visualViewport: null,
  };
  globalThis.getComputedStyle = (el) => ({
    position: "",
    display: "",
    overflow: "",
    overflowY: "",
    zIndex: "",
    top: "",
    left: "",
    right: "",
    bottom: "",
    width: "",
    maxWidth: "",
    maxHeight: "",
    transform: "",
    visibility: "visible",
    ...el._style,
  });
  try {
    return await fn();
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.getComputedStyle = saved.getComputedStyle;
  }
}

/** A `page` whose evaluate just runs the in-page function here in Node. */
const fakePage = { evaluate: async (fn, arg) => fn(arg) };

/** The real shape of the bug hunt: a rail picker and a dialog picker, same class. */
function twoPickers() {
  const dialog = { id: "workspace-diff-modal", className: "panel-modal", open: true };
  return [
    makeElement({ className: "workspace-picker-panel", box: [1083, 213, 498, 518], dialog: null }),
    makeElement({ className: "workspace-picker-panel", box: [470, 100, 420, 340], dialog }),
  ];
}

// --- enumeration ------------------------------------------------------------

test("describeMatchesInPage reports every match, not just the first", async () => {
  const elements = twoPickers();
  const report = await withDom({ elements }, () =>
    describeMatchesInPage({ selector: ".workspace-picker-panel" })
  );

  assert.equal(report.count, 2, "both pickers must be reported — taking the first is the whole bug");
  assert.equal(report.matches[0].dialogHost, null, "the rail picker belongs to no dialog");
  assert.equal(
    report.matches[1].dialogHost,
    "workspace-diff-modal",
    "the dialog picker must be attributed to its dialog by id, so the two can never be confused"
  );
  assert.equal(report.matches[1].dialogOpen, true, "a closed host explains a zero-sized box");
});

test("describeMatchesInPage flags a menu that escapes the viewport", async () => {
  const report = await withDom({ elements: twoPickers(), viewport: [1440, 759] }, () =>
    describeMatchesInPage({ selector: ".workspace-picker-panel" })
  );

  // 1083 + 498 = 1581, i.e. 141px past a 1440px viewport — the anomaly that
  // started the investigation. Whatever element it is, that is a real defect.
  assert.equal(report.matches[0].overflowsViewport.right, true, "1581 > 1440 must be called out");
  assert.equal(report.matches[1].overflowsViewport.right, false, "the in-dialog picker fits");
});

test("describeMatchesInPage hit-tests each match against what is actually on top", async () => {
  const elements = twoPickers();
  const backdrop = makeElement({ tag: "DIALOG", className: "panel-modal" });
  const report = await withDom({ elements, topAt: () => backdrop }, () =>
    describeMatchesInPage({ selector: ".workspace-picker-panel" })
  );

  // Laid out correctly and still untappable: `showModal()` makes everything
  // outside the dialog inert, so a portalled menu sits behind the backdrop.
  assert.equal(report.matches[0].hitTest.isSelf, false);
  assert.equal(report.matches[0].hitTest.isDescendant, false);
  assert.equal(report.matches[0].hitTest.class, "panel-modal");
});

test("describeMatchesInPage reports a bad within-selector instead of silently scanning the document", async () => {
  const report = await withDom({ elements: twoPickers(), within: "#present" }, () =>
    describeMatchesInPage({ selector: ".x", within: "#absent" })
  );
  assert.match(report.error, /#absent/, "a typo'd scope must fail loudly, not widen the search");
});

// --- refusing to guess ------------------------------------------------------

test("resolveOne refuses an ambiguous selector and names the candidates", async () => {
  await withDom({ elements: twoPickers() }, async () => {
    await assert.rejects(
      () => resolveOne(fakePage, { selector: ".workspace-picker-panel" }),
      (error) => {
        assert.match(error.message, /matches 2 elements/, "it must say why it stopped");
        assert.match(error.message, /workspace-diff-modal/, "and list the dialog hosts to choose from");
        return true;
      },
      "picking the first of two pickers is exactly the mistake this harness exists to prevent"
    );
  });
});

test("resolveOne accepts an explicit --nth and returns that element", async () => {
  await withDom({ elements: twoPickers() }, async () => {
    const { match, index } = await resolveOne(fakePage, {
      selector: ".workspace-picker-panel",
      nth: 1,
    });
    assert.equal(index, 1);
    assert.equal(match.dialogHost, "workspace-diff-modal", "--nth 1 must select the dialog's picker");
  });
});

test("resolveOne rejects an out-of-range --nth rather than returning undefined", async () => {
  await withDom({ elements: twoPickers() }, async () => {
    await assert.rejects(
      () => resolveOne(fakePage, { selector: ".workspace-picker-panel", nth: 7 }),
      /out of range \(2 matches\)/
    );
  });
});

test("resolveOne is happy when the selector is unambiguous", async () => {
  await withDom({ elements: [twoPickers()[1]] }, async () => {
    const { index } = await resolveOne(fakePage, { selector: ".workspace-picker-panel" });
    assert.equal(index, 0, "one match needs no disambiguation");
  });
});

test("resolveOne says nothing matched, distinctly from ambiguity", async () => {
  await withDom({ elements: [] }, async () => {
    await assert.rejects(
      () => resolveOne(fakePage, { selector: ".nope" }),
      /no element matches \.nope/
    );
  });
});

// --- evaluation source ------------------------------------------------------

// A string reaching `page.evaluate` is an expression, and an uncalled function
// is unserialisable, so every form must come back called.
test("toEvaluationSource produces a called expression for every input shape", () => {
  assert.equal(toEvaluationSource("document.title"), "(() => (document.title))()");
  assert.equal(toEvaluationSource("() => document.title"), "(() => document.title)()");
  assert.equal(toEvaluationSource("(a) => a"), "((a) => a)()");
  assert.equal(toEvaluationSource("x => x"), "(x => x)()");
  assert.equal(toEvaluationSource("async () => 1"), "(async () => 1)()");
  assert.equal(toEvaluationSource("function () { return 1 }"), "(function () { return 1 })()");
  assert.equal(
    toEvaluationSource("  1 + 1  "),
    "(() => (1 + 1))()",
    "surrounding space must not change the shape"
  );
  assert.equal(
    toEvaluationSource("(1 + 2)"),
    "(() => ((1 + 2)))()",
    "a parenthesised expression is not an arrow function — calling it would throw"
  );
  assert.throws(() => toEvaluationSource(""), /nothing to evaluate/);
  assert.throws(() => toEvaluationSource(undefined), /nothing to evaluate/);
});

// --- argument parsing -------------------------------------------------------

test("parseLiveArgs reads flags in both --flag value and --flag=value form", () => {
  const spaced = parseLiveArgs(["click", ".btn", "--within", "#dlg", "--nth", "1"]);
  assert.deepEqual(
    { command: spaced.command, target: spaced.target, within: spaced.within, nth: spaced.nth },
    { command: "click", target: ".btn", within: "#dlg", nth: 1 }
  );
  const inline = parseLiveArgs(["click", ".btn", "--within=#dlg", "--nth=1"]);
  assert.equal(inline.within, "#dlg");
  assert.equal(inline.nth, 1, "numeric flags must arrive as numbers, not strings");
});

test("parseLiveArgs keeps --nth 0 rather than losing it to falsiness", () => {
  const args = parseLiveArgs(["click", ".btn", "--nth", "0"]);
  assert.equal(args.nth, 0, "index 0 is a legitimate choice and must survive parsing");
});

test("parseLiveArgs makes tap a touch click", () => {
  assert.equal(parseLiveArgs(["tap", ".btn"]).touch, true);
  assert.equal(parseLiveArgs(["click", ".btn"]).touch, false);
  assert.equal(parseLiveArgs(["click", ".btn", "--touch"]).touch, true);
});

test("parseLiveArgs rejects a selector that was split by an unquoted shell", () => {
  assert.throws(
    () => parseLiveArgs(["click", ".workspace-picker-panel", ".other"]),
    /takes one target, got 2/,
    "two positionals almost always means a forgotten quote — guessing would act on the wrong node"
  );
});

test("parseLiveArgs rejects unknown commands and flags", () => {
  assert.throws(() => parseLiveArgs(["frobnicate"]), /unknown command frobnicate/);
  assert.throws(() => parseLiveArgs([]), /no command given/);
  assert.throws(() => parseLiveArgs(["click", ".btn", "--wihtin", "#d"]), /unknown flag --wihtin/);
  assert.throws(() => parseLiveArgs(["click", ".btn", "--within"]), /--within needs a value/);
});

test("parseLiveArgs validates numeric and enum flags", () => {
  assert.throws(() => parseLiveArgs(["click", ".b", "--nth", "abc"]), /--nth must be a non-negative integer/);
  assert.throws(() => parseLiveArgs(["click", ".b", "--nth", "-1"]), /--nth must be a non-negative integer/);
  assert.throws(() => parseLiveArgs(["wait", ".b", "--state", "vissible"]), /--state must be one of/);
  assert.equal(parseLiveArgs(["wait", ".b", "--state", "hidden"]).state, "hidden");
});

test("parseLiveArgs enforces which commands need a target", () => {
  assert.throws(() => parseLiveArgs(["click"]), /click needs a target/);
  assert.throws(() => parseLiveArgs(["eval"]), /eval needs a target/);
  assert.equal(parseLiveArgs(["open"]).target, undefined, "open may be bare");
  assert.equal(parseLiveArgs(["pages"]).command, "pages");
  assert.equal(parseLiveArgs(["shot", "--file", "/tmp/a.png"]).file, "/tmp/a.png");
});

test("parseLiveArgs takes a key to press", () => {
  assert.equal(parseLiveArgs(["key", "Escape"]).target, "Escape");
  assert.throws(() => parseLiveArgs(["key"]), /key needs a target/);
});

test("liveUsage lists every command, so the help can never drift from the parser", () => {
  const usage = liveUsage();
  for (const name of ["open", "pages", "eval", "find", "click", "tap", "wait", "shot", "key"]) {
    assert.match(usage, new RegExp(`\\b${name}\\b`), `${name} must appear in the usage text`);
  }
});

// --- browser resolution -----------------------------------------------------

test("resolveChrome reports whether it found the real Chrome or fell back", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-chrome-"));
  try {
    const chrome = path.join(dir, "Google Chrome");
    await fs.writeFile(chrome, "#!/bin/sh\n");

    const found = await resolveChrome({ candidates: [path.join(dir, "absent"), chrome] });
    assert.deepEqual(found, { bin: chrome, isSystemChrome: true }, "a later candidate must still win");

    const fallback = await resolveChrome({ candidates: [path.join(dir, "absent")] });
    assert.equal(
      fallback.isSystemChrome,
      false,
      "falling back to Playwright's Chromium must be visible — it is no longer the user's browser, " +
        "which is the entire premise of this harness"
    );
    assert.ok(fallback.bin, "a fallback binary path is still returned");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("isLiveBrowserUp treats a non-ok response and a dead port alike", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true });
    assert.equal(await isLiveBrowserUp(9222), true);

    globalThis.fetch = async () => ({ ok: false });
    assert.equal(await isLiveBrowserUp(9222), false, "a 4xx from the debug port is not a live browser");

    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    assert.equal(await isLiveBrowserUp(9222), false, "a refused connection must not escape as a throw");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
