import test from "node:test";
import assert from "node:assert/strict";

import { loadSeenTasks, markTaskSeen } from "./local/task-seen-prefs.js";

function mockStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
    _map: map,
  };
}

function withStorage(store, run) {
  globalThis.window = { localStorage: store };
  try {
    return run();
  } finally {
    delete globalThis.window;
  }
}

test("a read receipt round-trips", () => {
  const store = mockStorage();
  withStorage(store, () => {
    markTaskSeen("team-1", 100);
    assert.deepEqual(loadSeenTasks(), { "team-1": 100 });
  });
});

test("a later read moves the receipt forward", () => {
  const store = mockStorage();
  withStorage(store, () => {
    markTaskSeen("team-1", 100);
    markTaskSeen("team-1", 250);
    assert.deepEqual(loadSeenTasks(), { "team-1": 250 });
  });
});

test("no storage at all degrades to nothing read, never throws", () => {
  // Privacy mode and disabled storage both surface as a throw on ACCESS, not on
  // use — so the guard has to be around the property read itself.
  const previous = globalThis.window;
  delete globalThis.window;
  assert.deepEqual(loadSeenTasks(), {});
  // Same rule as the quota case below: persistence is optional, but the answer
  // the caller renders from this frame is not.
  assert.deepEqual(markTaskSeen("team-1", 100), { "team-1": 100 });
  if (previous) globalThis.window = previous;
});

test("corrupt or hostile stored data degrades to nothing read", () => {
  for (const raw of ["not json", "null", "[]", '"a string"', '{"team-1":"soon"}']) {
    withStorage(mockStorage({ "sealwire:tasks-seen": raw }), () => {
      assert.deepEqual(loadSeenTasks(), {}, raw);
    });
  }
});

test("a write that throws still reports the read for this session", () => {
  // Quota. Losing persistence is acceptable; losing the answer the caller is
  // about to render from is not.
  const store = mockStorage();
  store.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  withStorage(store, () => {
    assert.deepEqual(markTaskSeen("team-1", 100), { "team-1": 100 });
  });
});

test("the receipt map is bounded, keeping the most recently read", () => {
  // The relay retains at most MAX_WORKFLOW_RUNS runs, so an unbounded map would
  // accumulate ids for tasks that no longer exist, forever.
  const store = mockStorage();
  withStorage(store, () => {
    for (let index = 0; index < 260; index += 1) {
      markTaskSeen(`team-${index}`, index);
    }
    const seen = loadSeenTasks();
    assert.equal(Object.keys(seen).length, 200);
    assert.ok(seen["team-259"], "the newest read survives");
    assert.equal(seen["team-0"], undefined, "the oldest is dropped");
  });
});

test("an unusable id or timestamp is ignored rather than stored", () => {
  const store = mockStorage();
  withStorage(store, () => {
    markTaskSeen("", 100);
    markTaskSeen("team-1", undefined);
    markTaskSeen("team-1", Number.NaN);
    assert.deepEqual(loadSeenTasks(), {});
  });
});
