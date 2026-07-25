import test from "node:test";
import assert from "node:assert/strict";

import {
  loadProjectPrefs,
  toggleProjectPin,
  setProjectOrder,
} from "./local/project-overview-prefs.js";

function mockStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test("prefs degrade to empty (and never throw) when storage is unavailable", () => {
  delete globalThis.window;
  assert.deepEqual(loadProjectPrefs("p1"), { pinned: [], order: [] });
  // The in-memory result still reflects the change; persistence is just skipped.
  assert.deepEqual(toggleProjectPin("p1", "t1"), { pinned: ["t1"], order: [] });
  assert.deepEqual(setProjectOrder("p1", ["t1"]), { pinned: [], order: ["t1"] });
});

test("prefs persist pin + order per project through storage", () => {
  globalThis.window = { localStorage: mockStorage() };
  try {
    assert.deepEqual(loadProjectPrefs("p1"), { pinned: [], order: [] });

    let prefs = toggleProjectPin("p1", "t1");
    assert.deepEqual(prefs, { pinned: ["t1"], order: [] });
    assert.deepEqual(loadProjectPrefs("p1"), { pinned: ["t1"], order: [] });

    prefs = toggleProjectPin("p1", "t1"); // toggle back off
    assert.deepEqual(prefs.pinned, []);

    // setProjectOrder sanitizes non-string entries and preserves the pinned set.
    toggleProjectPin("p1", "t9");
    prefs = setProjectOrder("p1", ["t2", "t1", 5, null, "t3"]);
    assert.deepEqual(prefs.order, ["t2", "t1", "t3"]);
    assert.deepEqual(prefs.pinned, ["t9"]);
    assert.deepEqual(loadProjectPrefs("p1").order, ["t2", "t1", "t3"]);

    // Projects are isolated from one another.
    assert.deepEqual(loadProjectPrefs("p2"), { pinned: [], order: [] });
  } finally {
    delete globalThis.window;
  }
});

test("loadProjectPrefs tolerates corrupt stored JSON", () => {
  const storage = mockStorage();
  storage.setItem("sealwire:project-overview:p1", "{ not json");
  globalThis.window = { localStorage: storage };
  try {
    assert.deepEqual(loadProjectPrefs("p1"), { pinned: [], order: [] });
  } finally {
    delete globalThis.window;
  }
});
