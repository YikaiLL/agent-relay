import test from "node:test";
import assert from "node:assert/strict";

import {
  createSessionLocationMemo,
  sessionLocationMemoKey,
} from "./session-location-memo.js";

// A store that behaves, plus the knobs for the ways a real one misbehaves.
function fakeStorage({ throwOnWrite = false, seed = {} } = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem(key, value) {
      if (throwOnWrite) {
        throw new Error("QuotaExceededError");
      }
      map.set(key, String(value));
    },
    removeItem: (key) => map.delete(key),
  };
}

const KEY = sessionLocationMemoKey("relay-a");

test("a written context reads back", () => {
  const storage = fakeStorage();
  const memo = createSessionLocationMemo({ relayScope: "relay-a", storage });

  memo.write({ entry: { version: 1, context: { kind: "project", projectId: "P" } } });

  assert.deepEqual(memo.read().context, { kind: "project", projectId: "P" });
});

// The scoping claim, stated as a key rather than inferred from behaviour: a context is a
// project id, and project ids are unique only within one relay.
test("each relay scope keys its own memo, and unpaired gets its own", () => {
  assert.notEqual(sessionLocationMemoKey("relay-a"), sessionLocationMemoKey("relay-b"));
  assert.notEqual(sessionLocationMemoKey("unpaired"), sessionLocationMemoKey("relay-a"));

  const storage = fakeStorage();
  createSessionLocationMemo({ relayScope: "relay-a", storage }).write({
    entry: { version: 1, context: { kind: "project", projectId: "P" } },
  });

  assert.equal(
    createSessionLocationMemo({ relayScope: "relay-b", storage }).read(),
    null,
    "relay B must not read relay A's remembered workspace"
  );
});

// Everything below is the "fail soft, never throw" contract. Each degrades to "nothing
// remembered", which is exactly the behaviour that shipped before this module existed —
// so a broken store costs the restore and nothing else.
test("corrupt JSON reads as nothing remembered", () => {
  const memo = createSessionLocationMemo({
    relayScope: "relay-a",
    storage: fakeStorage({ seed: { [KEY]: "{not json" } }),
  });
  assert.equal(memo.read(), null);
});

test("a memo from a future version is ignored rather than half-read", () => {
  const memo = createSessionLocationMemo({
    relayScope: "relay-a",
    storage: fakeStorage({
      seed: { [KEY]: JSON.stringify({ version: 2, context: { kind: "sessions" } }) },
    }),
  });
  assert.equal(memo.read(), null);
});

test("a memo with no context is ignored", () => {
  const memo = createSessionLocationMemo({
    relayScope: "relay-a",
    storage: fakeStorage({ seed: { [KEY]: JSON.stringify({ version: 1 }) } }),
  });
  assert.equal(memo.read(), null);
});

// Safari private mode and a full quota both throw from setItem. A navigation must not
// fail because its bookkeeping did.
test("a store that refuses writes loses the memory, not the navigation", () => {
  const memo = createSessionLocationMemo({
    relayScope: "relay-a",
    storage: fakeStorage({ throwOnWrite: true }),
  });

  assert.doesNotThrow(() =>
    memo.write({ entry: { version: 1, context: { kind: "sessions" } } })
  );
  assert.equal(memo.read(), null);
});

test("no storage at all degrades to nothing remembered", () => {
  const memo = createSessionLocationMemo({ relayScope: "relay-a", storage: null });

  assert.equal(memo.read(), null);
  assert.doesNotThrow(() =>
    memo.write({ entry: { version: 1, context: { kind: "sessions" } } })
  );
});

// The controller calls `write` for every commit it decides is a navigation, and passes
// whatever the history-entry builder produced. An entry with no context is not a location
// and must not overwrite the one that is remembered.
test("a write with no usable entry leaves the previous memory intact", () => {
  const storage = fakeStorage();
  const memo = createSessionLocationMemo({ relayScope: "relay-a", storage });
  memo.write({ entry: { version: 1, context: { kind: "project", projectId: "P" } } });

  memo.write({});
  memo.write({ entry: null });
  memo.write({ entry: { version: 1 } });

  assert.deepEqual(memo.read().context, { kind: "project", projectId: "P" });
});

test("forgetting a relay drops its memo and nobody else's", () => {
  const storage = fakeStorage();
  const a = createSessionLocationMemo({ relayScope: "relay-a", storage });
  const b = createSessionLocationMemo({ relayScope: "relay-b", storage });
  a.write({ entry: { version: 1, context: { kind: "project", projectId: "P" } } });
  b.write({ entry: { version: 1, context: { kind: "project", projectId: "Q" } } });

  a.forget();

  assert.equal(a.read(), null);
  assert.deepEqual(b.read().context, { kind: "project", projectId: "Q" });
});
