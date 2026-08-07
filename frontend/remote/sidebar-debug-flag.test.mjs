// Whether the remote sidebar's gesture tracer is armed.
//
// The tracer logs every pointerdown / touchstart / wheel / scroll over the sidebar and
// its two lists, and it does so through `renderLog()` — which is `patchRemoteState`, i.e.
// a RE-RENDER. That is the exact shape that swallows a click: a `click` only fires when
// mousedown and mouseup resolve to the same node, and the sidebar's icons are injected
// with `dangerouslySetInnerHTML`, so a re-render landing between the two halves of a tap
// replaces the <svg> and the browser fires no click at all.
//
// `.inline-icon { pointer-events: none }` defends the buttons that have it.
// `.project-switcher-trigger`'s svg does NOT, and a real e2e run shows the tracer firing
// with that svg as the pointerdown target. So the tracer is not a passive observer of the
// region it watches; it is a live hazard in it.
//
// It has been on unconditionally for ~590 commits behind a
// `TODO(remote-monitor-debug): remove after scroll bugs are fixed`. Rather than delete a
// tool that only works on the device that needs it — you often cannot reach a console on a
// phone, which is presumably why it renders into the log panel at all — it is now opt-in.
// Default off means no listeners, so no gesture can trigger a render.
import test from "node:test";
import assert from "node:assert/strict";

import { sidebarGestureDebugEnabled } from "./sidebar-debug-flag.js";

function storage(values = {}) {
  return { getItem: (key) => (key in values ? values[key] : null) };
}

test("off by default — the tracer installs nothing unless asked for", () => {
  assert.equal(sidebarGestureDebugEnabled({ search: "", storage: storage() }), false);
  assert.equal(sidebarGestureDebugEnabled({}), false);
  assert.equal(sidebarGestureDebugEnabled(), false, "no argument at all is still off");
});

test("a query parameter arms it, which is the phone-friendly way in", () => {
  for (const search of ["?sidebarDebug=1", "?foo=bar&sidebarDebug=1", "sidebarDebug=1"]) {
    assert.equal(sidebarGestureDebugEnabled({ search, storage: storage() }), true, search);
  }
});

// Survives a reload, so a bug that needs a fresh load to reproduce can still be traced.
test("a stored flag arms it too", () => {
  assert.equal(
    sidebarGestureDebugEnabled({ search: "", storage: storage({ "sealwire:sidebar-debug": "1" }) }),
    true
  );
});

// Explicit off beats a stored on, or a flag set once during an investigation would be
// impossible to shake off without clearing storage by hand.
test("an explicit ?sidebarDebug=0 wins over a stored flag", () => {
  assert.equal(
    sidebarGestureDebugEnabled({
      search: "?sidebarDebug=0",
      storage: storage({ "sealwire:sidebar-debug": "1" }),
    }),
    false
  );
});

test("only a real on-value counts", () => {
  for (const value of ["", "0", "false", "no", "off"]) {
    assert.equal(
      sidebarGestureDebugEnabled({ search: `?sidebarDebug=${value}`, storage: storage() }),
      false,
      `?sidebarDebug=${value} is not on`
    );
  }
});

// Reading `localStorage` THROWS in Safari private browsing and under some embedded
// webviews — which is exactly the phone-shaped environment this tracer exists for. A
// throw here would take down `bootRemoteRuntime`, so the whole surface would fail to
// start over a debug flag.
test("a storage that throws leaves it off instead of taking the surface down", () => {
  const hostile = {
    getItem() {
      throw new Error("SecurityError: localStorage is not available");
    },
  };
  assert.doesNotThrow(() => sidebarGestureDebugEnabled({ search: "", storage: hostile }));
  assert.equal(sidebarGestureDebugEnabled({ search: "", storage: hostile }), false);
  // The query parameter still works, so a device with no usable storage is not locked out.
  assert.equal(sidebarGestureDebugEnabled({ search: "?sidebarDebug=1", storage: hostile }), true);
});
