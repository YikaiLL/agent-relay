import test from "node:test";
import assert from "node:assert/strict";

// A DOM-free localStorage stand-in; the module reads `window.localStorage` lazily on
// every call, so swapping the backing store between tests is enough.
function installStorage({ failRead = false, failWrite = false } = {}) {
  const data = new Map();
  global.window = {
    localStorage: {
      get length() {
        return data.size;
      },
      key(index) {
        return [...data.keys()][index] ?? null;
      },
      getItem(key) {
        if (failRead) {
          throw new Error("storage unavailable");
        }
        return data.has(key) ? data.get(key) : null;
      },
      setItem(key, value) {
        if (failWrite) {
          throw new Error("quota exceeded");
        }
        data.set(key, value);
      },
      removeItem(key) {
        data.delete(key);
      },
    },
  };
  return data;
}

const KEY = "sealwire:removed-threads";

const load = async () => (await import("./shared/removed-threads.js")).loadRemovedThreadIds();
const remember = async (id) =>
  (await import("./shared/removed-threads.js")).rememberRemovedThreadId(id);
const isRemoved = async (id, fallback) =>
  (await import("./shared/removed-threads.js")).isRemovedThreadId(id, fallback);

test("a recorded session reads back as removed", async () => {
  installStorage();
  await remember("t1");
  assert.equal(await isRemoved("t1"), true);
  assert.equal(await isRemoved("t2"), false);
  assert.deepEqual(await load(), ["t1"]);
});

test("re-recording moves an id to the newest slot instead of duplicating it", async () => {
  installStorage();
  await remember("t1");
  await remember("t2");
  await remember("t1");
  assert.deepEqual(await load(), ["t2", "t1"]);
});

test("an empty id is ignored", async () => {
  installStorage();
  await remember("t1");
  await remember("");
  await remember(null);
  assert.deepEqual(await load(), ["t1"]);
  assert.equal(await isRemoved(null), false);
});

// The guard reads storage on every call rather than caching, so a deletion made by
// another window of the same profile is honoured immediately — a cached copy loaded
// at page init would never learn about it.
test("a tombstone written by another window is seen without any reload", async () => {
  const data = installStorage();
  assert.equal(await isRemoved("t9"), false);
  // Simulate the other window's write landing directly in the shared store.
  data.set(KEY, JSON.stringify(["t9"]));
  assert.equal(await isRemoved("t9"), true);
});

// Writes merge against a fresh read, so a concurrent deletion elsewhere survives.
test("recording merges with tombstones written concurrently", async () => {
  const data = installStorage();
  await remember("mine");
  data.set(KEY, JSON.stringify(["mine", "theirs"]));
  await remember("mine-2");
  assert.deepEqual(await load(), ["mine", "theirs", "mine-2"]);
});

test("the list is capped, dropping the oldest ids first", async () => {
  installStorage();
  for (let index = 0; index < 250; index += 1) {
    await remember(`t${index}`);
  }
  const stored = await load();
  assert.equal(stored.length, 200);
  assert.equal(stored.at(-1), "t249", "newest is kept");
  assert.equal(stored.includes("t49"), false, "oldest fell off");
  assert.equal(stored[0], "t50");
});

test("corrupt or non-array stored data degrades to no tombstones", async () => {
  const data = installStorage();
  data.set(KEY, "{not json");
  assert.deepEqual(await load(), []);
  data.set(KEY, JSON.stringify({ nope: true }));
  assert.deepEqual(await load(), []);
  // Junk entries inside a valid array are dropped, valid ones survive.
  data.set(KEY, JSON.stringify(["good", 42, null, "", { x: 1 }]));
  assert.deepEqual(await load(), ["good"]);
});

test("a throwing store degrades instead of propagating", async () => {
  installStorage({ failRead: true });
  assert.deepEqual(await load(), []);
  assert.equal(await isRemoved("t1"), false);

  installStorage({ failWrite: true });
  assert.doesNotThrow(() => remember("t1"));
  assert.deepEqual(await load(), [], "a failed write leaves nothing stored");
});

// Private mode / unavailable storage still has to block resurrection within the page
// that did the deleting, which is what the in-session fallback is for.
test("the in-session fallback covers a store that cannot persist", async () => {
  installStorage({ failWrite: true });
  const fallback = new Set(["t1"]);
  assert.equal(await isRemoved("t1", fallback), true);
  assert.equal(await isRemoved("t2", fallback), false);
});

test("no window at all is not an error", async () => {
  delete global.window;
  assert.deepEqual(await load(), []);
  assert.equal(await isRemoved("t1"), false);
  assert.doesNotThrow(() => remember("t1"));
});
