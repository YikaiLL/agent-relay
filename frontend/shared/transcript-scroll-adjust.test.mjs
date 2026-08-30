import test from "node:test";
import assert from "node:assert/strict";

import { createTranscriptScrollAdjuster } from "./transcript-scroll-adjust.js";

// `virtual-core` asks for a row-size correction as
// `_scrollToOffset(getScrollOffset(), { adjustments: scrollAdjustments += delta })`.
// `getScrollOffset()` is the last OBSERVED offset, which lags the real one until the
// browser dispatches `scroll`. Applying `staleBase + adjustments` therefore throws away
// whatever the reader scrolled in between — which is how a reader who had just wheeled
// up got put back at the bottom and re-glued there.
//
// Only that one call site passes a defined `adjustments`; every explicit
// scrollToIndex/scrollToOffset path passes `adjustments: undefined`, so this is an exact
// test for "is this a size correction?" and explicit scrolls must stay untouched.

function fakeInstance(scrollTop) {
  const listeners = new Map();
  const element = {
    scrollTop,
    scrollTo({ top }) {
      this.scrollTop = top;
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener() {},
  };
  return {
    scrollElement: element,
    // `observeElementOffset` bails out without a `targetWindow`, and debounces its
    // trailing "scrolling stopped" call through it. A no-op timer keeps that trailing
    // callback from firing after the test ends.
    targetWindow: { setTimeout: () => 0, clearTimeout: () => {} },
    options: {
      horizontal: false,
      isRtl: false,
      useScrollendEvent: false,
      isScrollingResetDelay: 150,
    },
    fireScroll() {
      for (const handler of listeners.get("scroll") || []) handler();
    },
  };
}

test("a size correction moves by its delta from the LIVE scrollTop, not a stale base", () => {
  const { scrollToFn } = createTranscriptScrollAdjuster();
  // The reader has wheeled up to 2000. `virtual-core` still believes 3000 (no `scroll`
  // event yet) and wants to shed 50px because a row measured smaller than estimated.
  const instance = fakeInstance(2000);

  scrollToFn(3000, { adjustments: -50 }, instance);

  assert.equal(
    instance.scrollElement.scrollTop,
    1950,
    "the correction must be relative to where the reader actually is"
  );
});

test("cumulative adjustments are applied as increments, not re-applied in full", () => {
  const { scrollToFn } = createTranscriptScrollAdjuster();
  const instance = fakeInstance(2000);

  // `virtual-core` accumulates: -50, then -50 + -30 = -80.
  scrollToFn(3000, { adjustments: -50 }, instance);
  scrollToFn(3000, { adjustments: -80 }, instance);

  assert.equal(
    instance.scrollElement.scrollTop,
    1920,
    "the second call carries the running total, so only the new -30 may be applied"
  );
});

test("an explicit scroll (no adjustments) still lands exactly where asked", () => {
  const { scrollToFn } = createTranscriptScrollAdjuster();
  const instance = fakeInstance(2000);

  // scrollToIndex / scrollToOffset / mount all pass `adjustments: undefined`.
  scrollToFn(500, { adjustments: undefined }, instance);

  assert.equal(
    instance.scrollElement.scrollTop,
    500,
    "explicit positioning must not be reinterpreted as a delta"
  );
});

test("an observed scroll resets the running total, matching virtual-core", () => {
  const adjuster = createTranscriptScrollAdjuster();
  const instance = fakeInstance(2000);

  adjuster.observeElementOffset(instance, () => {});
  adjuster.scrollToFn(3000, { adjustments: -50 }, instance);
  assert.equal(instance.scrollElement.scrollTop, 1950);

  // `virtual-core` zeroes `scrollAdjustments` when it observes a scroll, so the next
  // cumulative figure starts from 0 again and we must not treat it as an increment.
  instance.fireScroll();
  adjuster.scrollToFn(1950, { adjustments: -20 }, instance);

  assert.equal(
    instance.scrollElement.scrollTop,
    1930,
    "after an observed scroll the total restarts, so -20 is the whole increment"
  );
});
