// P2: TRANSCRIPT_VIRTUAL_OVERSCAN (transcript-react.js) fed the real
// @tanstack/virtual-core Virtualizer with no test proving overscan does
// anything — only the 19/20 virtualization THRESHOLD was covered
// (shouldVirtualizeTranscript in transcript-react.test.mjs). Overscan is a
// Virtualizer constructor option consumed entirely inside the
// useTranscriptVirtualizer hook, so proving it behaviorally means driving
// the real library the hook drives, not re-testing the hook's React
// plumbing. This constructs a Virtualizer exactly the way
// useTranscriptVirtualizer does (headless: fake getScrollElement/
// observeElementRect/observeElementOffset callbacks, no real DOM needed —
// virtual-core's own rendering is layout-measurement-free) and asserts the
// actual rendered index range, both scrolled to the top and scrolled to the
// middle.

import test from "node:test";
import assert from "node:assert/strict";
import { Virtualizer } from "@tanstack/virtual-core";

import { TRANSCRIPT_VIRTUAL_OVERSCAN } from "./shared/transcript-react.js";

const ROW_HEIGHT = 100;
const ROW_COUNT = 100;
const VIEWPORT_HEIGHT = 500; // exactly 5 rows visible at ROW_HEIGHT

function buildVirtualizer({ overscan, scrollOffset }) {
  const fakeScrollElement = {};
  const virtualizer = new Virtualizer({
    count: ROW_COUNT,
    getScrollElement: () => fakeScrollElement,
    estimateSize: () => ROW_HEIGHT,
    overscan,
    observeElementRect: (_instance, cb) => {
      cb({ width: 300, height: VIEWPORT_HEIGHT });
      return () => {};
    },
    observeElementOffset: (_instance, cb) => {
      cb(scrollOffset, false);
      return () => {};
    },
    scrollToFn: () => {},
  });
  virtualizer._didMount();
  virtualizer._willUpdate();
  return virtualizer;
}

function indexRange(virtualizer) {
  const items = virtualizer.getVirtualItems();
  return { first: items[0]?.index, last: items[items.length - 1]?.index, count: items.length };
}

test("TRANSCRIPT_VIRTUAL_OVERSCAN is 6 — sanity, so a future accidental edit here is caught by more than a lone number", () => {
  assert.equal(TRANSCRIPT_VIRTUAL_OVERSCAN, 6);
});

test("at the top of the list, overscan renders exactly 6 extra rows past the visible window (none needed before, since index 0 is the start)", () => {
  const withOverscan = indexRange(buildVirtualizer({ overscan: TRANSCRIPT_VIRTUAL_OVERSCAN, scrollOffset: 0 }));
  const noOverscan = indexRange(buildVirtualizer({ overscan: 0, scrollOffset: 0 }));

  assert.deepEqual(noOverscan, { first: 0, last: 4, count: 5 }, "sanity: exactly 5 rows are visible in a 500px viewport of 100px rows");
  assert.deepEqual(
    withOverscan,
    { first: 0, last: 4 + TRANSCRIPT_VIRTUAL_OVERSCAN, count: 5 + TRANSCRIPT_VIRTUAL_OVERSCAN },
    "overscan must extend the rendered range by exactly its own value past the last visible row"
  );
});

test("scrolled to the middle of the list, overscan renders exactly 6 extra rows on EACH side of the visible window", () => {
  // Scrolled so rows 20-24 are exactly the visible window (2000px-2500px).
  const scrollOffset = 20 * ROW_HEIGHT;
  const withOverscan = indexRange(buildVirtualizer({ overscan: TRANSCRIPT_VIRTUAL_OVERSCAN, scrollOffset }));
  const noOverscan = indexRange(buildVirtualizer({ overscan: 0, scrollOffset }));

  assert.deepEqual(noOverscan, { first: 20, last: 24, count: 5 }, "sanity: the visible window is rows 20-24");
  assert.deepEqual(
    withOverscan,
    {
      first: 20 - TRANSCRIPT_VIRTUAL_OVERSCAN,
      last: 24 + TRANSCRIPT_VIRTUAL_OVERSCAN,
      count: 5 + TRANSCRIPT_VIRTUAL_OVERSCAN * 2,
    },
    "overscan must extend the rendered range by exactly its own value on BOTH sides once there is room on both sides"
  );
});
