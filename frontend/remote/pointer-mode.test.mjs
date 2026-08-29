import test from "node:test";
import assert from "node:assert/strict";

// `state.js` reads localStorage at import time, so the stubs must be installed before
// the dynamic imports below — the same ordering `navigation.test.mjs` uses.
function installBrowserStubs() {
  let activeMediaQuery = createMediaQuery();

  globalThis.document = {
    body: { dataset: {} },
    querySelector() {
      return null;
    },
  };
  globalThis.window = {
    innerWidth: 1280,
    localStorage: {
      getItem() {
        return null;
      },
      removeItem() {},
      setItem() {},
    },
    matchMedia() {
      return activeMediaQuery;
    },
  };

  return {
    get mediaQuery() {
      return activeMediaQuery;
    },
    replaceMediaQuery(next = {}) {
      activeMediaQuery = createMediaQuery(next);
      return activeMediaQuery;
    },
  };
}

function createMediaQuery(overrides = {}) {
  return {
    matches: false,
    handlers: new Set(),
    addCalls: 0,
    removeCalls: 0,
    addEventListener(kind, handler) {
      this.addCalls += 1;
      this.handlers.add(handler);
    },
    removeEventListener(kind, handler) {
      this.removeCalls += 1;
      this.handlers.delete(handler);
    },
    flip(next) {
      this.matches = next;
      for (const handler of this.handlers) {
        handler();
      }
    },
    ...overrides,
  };
}

const browser = installBrowserStubs();
const pointerMode = await import("./pointer-mode.js");
const { patchRemoteState, state } = await import("./state.js");

function reset() {
  pointerMode.stopRemotePointerClass();
  patchRemoteState({ remotePointerClass: "touch" });
}

// The default must be the conservative one: a phone that somehow renders before the
// measurement lands must not flash desktop-only chrome.
test("the surface starts touch-classed before anything measures", { concurrency: false }, () => {
  reset();
  assert.equal(state.remotePointerClass, "touch");
});

test("a mouse-driven window classes as desktop", { concurrency: false }, () => {
  reset();
  browser.replaceMediaQuery({ matches: true });

  pointerMode.initializeRemotePointerClass();

  assert.equal(state.remotePointerClass, "desktop");
});

test("a touch window stays touch-classed", { concurrency: false }, () => {
  reset();
  browser.replaceMediaQuery({ matches: false });

  pointerMode.initializeRemotePointerClass();

  assert.equal(state.remotePointerClass, "touch");
});

// The point of observing rather than sampling: attaching a mouse, or detaching a
// tablet's keyboard, has to move the class without a reload.
test("the class follows the pointer in both directions", { concurrency: false }, () => {
  reset();
  const query = browser.replaceMediaQuery({ matches: false });

  pointerMode.initializeRemotePointerClass();
  assert.equal(state.remotePointerClass, "touch");

  query.flip(true);
  assert.equal(state.remotePointerClass, "desktop");

  query.flip(false);
  assert.equal(state.remotePointerClass, "touch");
});

test("re-initializing replaces the previous listener rather than stacking one", { concurrency: false }, () => {
  reset();
  const first = browser.replaceMediaQuery({ matches: true });
  pointerMode.initializeRemotePointerClass();
  assert.equal(first.addCalls, 1);
  assert.equal(first.removeCalls, 0);

  const second = browser.replaceMediaQuery({ matches: false });
  pointerMode.initializeRemotePointerClass();

  assert.equal(first.removeCalls, 1);
  assert.equal(second.addCalls, 1);
  assert.equal(state.remotePointerClass, "touch");

  // The detached query must no longer be able to steer the surface.
  first.matches = true;
  for (const handler of first.handlers) {
    handler();
  }
  assert.equal(state.remotePointerClass, "touch");
});

test("stopping detaches the listener", { concurrency: false }, () => {
  reset();
  const query = browser.replaceMediaQuery({ matches: false });
  pointerMode.initializeRemotePointerClass();

  pointerMode.stopRemotePointerClass();
  assert.equal(query.removeCalls, 1);

  query.flip(true);
  assert.equal(state.remotePointerClass, "touch");
});
