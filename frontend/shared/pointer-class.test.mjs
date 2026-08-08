import assert from "node:assert/strict";
import test from "node:test";

import {
  hasDesktopPointer,
  hasFinePrimaryPointer,
  observeDesktopPointer,
} from "./pointer-class.js";
import { defaultEnterSubmits } from "./composer-keys.js";

// A window whose matchMedia answers from a map of query -> matches. Anything not named
// is false, which is what a real browser reports for a query it understands but does
// not satisfy.
function fakeWindow(matches = {}, { listenerStyle = "modern" } = {}) {
  const listeners = new Map();
  return {
    listeners,
    matchMedia(query) {
      const list = {
        media: query,
        matches: Boolean(matches[query]),
      };
      if (listenerStyle === "modern") {
        list.addEventListener = (kind, handler) => {
          listeners.set(handler, { kind, list });
        };
        list.removeEventListener = (kind, handler) => {
          listeners.delete(handler);
        };
      } else if (listenerStyle === "legacy") {
        list.addListener = (handler) => listeners.set(handler, { kind: "change", list });
        list.removeListener = (handler) => listeners.delete(handler);
      }
      return list;
    },
    // Test helper: flip the query result and notify.
    flip(query, next) {
      matches[query] = next;
      for (const [handler, entry] of listeners) {
        if (entry.list.media === query) {
          entry.list.matches = next;
          handler();
        }
      }
    },
  };
}

const DESKTOP = "(hover: hover) and (pointer: fine)";
const FINE = "(pointer: fine)";

test("a mouse-driven machine has both a fine primary pointer and a desktop pointer", () => {
  const win = fakeWindow({ [FINE]: true, [DESKTOP]: true });
  assert.equal(hasFinePrimaryPointer(win), true);
  assert.equal(hasDesktopPointer(win), true);
});

test("a touch device has neither", () => {
  const win = fakeWindow({ [FINE]: false, [DESKTOP]: false });
  assert.equal(hasFinePrimaryPointer(win), false);
  assert.equal(hasDesktopPointer(win), false);
});

// The iPad-with-Magic-Keyboard case, which is the whole reason this module gates on the
// PRIMARY pointer. `any-pointer: fine` would be true here; both of ours must be false.
test("an accessory mouse on a touch-first device is not a desktop pointer", () => {
  const win = fakeWindow({
    "(any-pointer: fine)": true,
    [FINE]: false,
    [DESKTOP]: false,
  });
  assert.equal(hasFinePrimaryPointer(win), false);
  assert.equal(hasDesktopPointer(win), false);
});

// A pointer that cannot hover would be handed hover-revealed controls it can never
// show. `hasFinePrimaryPointer` does not care; `hasDesktopPointer` must.
test("hover is required for a desktop pointer, and only for that", () => {
  const win = fakeWindow({ [FINE]: true, [DESKTOP]: false });
  assert.equal(hasFinePrimaryPointer(win), true);
  assert.equal(hasDesktopPointer(win), false);
});

// The two defaults are deliberately opposite. If these ever agree, one of the two
// callers has silently changed meaning.
test("an unanswerable environment fails open for fine, closed for desktop", () => {
  for (const win of [undefined, null, {}, { matchMedia: null }]) {
    assert.equal(hasFinePrimaryPointer(win), true, `fine: ${JSON.stringify(win)}`);
    assert.equal(hasDesktopPointer(win), false, `desktop: ${JSON.stringify(win)}`);
  }
});

test("a matchMedia that throws fails the same way as one that is absent", () => {
  const win = {
    matchMedia() {
      throw new Error("unsupported feature query");
    },
  };
  assert.equal(hasFinePrimaryPointer(win), true);
  assert.equal(hasDesktopPointer(win), false);
});

// The composer's Enter behaviour is the pre-existing caller. Its fail-open default is
// load-bearing — a composer that cannot answer must still submit on Enter — so this
// pins that the refactor did not adopt `hasDesktopPointer`'s stricter contract.
test("defaultEnterSubmits keeps its own semantics after the extraction", () => {
  assert.equal(defaultEnterSubmits(fakeWindow({ [FINE]: true })), true);
  assert.equal(defaultEnterSubmits(fakeWindow({ [FINE]: false })), false);
  assert.equal(defaultEnterSubmits(undefined), true);
  assert.equal(defaultEnterSubmits({}), true);
  // Hover is irrelevant to the composer: a fine pointer that cannot hover still submits.
  assert.equal(defaultEnterSubmits(fakeWindow({ [FINE]: true, [DESKTOP]: false })), true);
});

test("observeDesktopPointer reports flips in both directions and detaches", () => {
  const win = fakeWindow({ [DESKTOP]: false });
  const seen = [];
  const detach = observeDesktopPointer(win, (next) => seen.push(next));

  win.flip(DESKTOP, true);
  win.flip(DESKTOP, false);
  assert.deepEqual(seen, [true, false]);

  detach();
  win.flip(DESKTOP, true);
  assert.deepEqual(seen, [true, false], "a detached observer must stop reporting");
  assert.equal(win.listeners.size, 0);
});

test("observeDesktopPointer falls back to the deprecated listener form", () => {
  const win = fakeWindow({ [DESKTOP]: false }, { listenerStyle: "legacy" });
  const seen = [];
  const detach = observeDesktopPointer(win, (next) => seen.push(next));
  win.flip(DESKTOP, true);
  assert.deepEqual(seen, [true]);
  detach();
  assert.equal(win.listeners.size, 0);
});

// Returning a no-op rather than undefined means callers never branch on support, and a
// cleanup that runs anyway cannot throw.
test("observeDesktopPointer degrades to a callable no-op", () => {
  for (const [win, handler] of [
    [undefined, () => {}],
    [{}, () => {}],
    [fakeWindow({}), null],
    [fakeWindow({}, { listenerStyle: "none" }), () => {}],
    [
      {
        matchMedia() {
          throw new Error("nope");
        },
      },
      () => {},
    ],
  ]) {
    const detach = observeDesktopPointer(win, handler);
    assert.equal(typeof detach, "function");
    detach();
  }
});
