import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

function installBrowserStubs() {
  const storage = new Map();
  globalThis.window = {
    crypto: webcrypto,
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      removeItem(key) {
        storage.delete(key);
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
    },
  };
  globalThis.localStorage = globalThis.window.localStorage;
  globalThis.document = { body: { dataset: {} } };
}

test("remote hydration cleanup only releases the promise that still owns shared state", async () => {
  installBrowserStubs();
  const { state } = await import("../state.js");
  const { applyRemoteSurfacePatch } = await import("../surface-state.js");
  const {
    clearTranscriptHydrationPromise,
    setTranscriptHydrationIdle,
  } = await import("./store.js");

  const oldOwner = Promise.resolve("old");
  const newOwner = Promise.resolve("new");
  applyRemoteSurfacePatch({
    transcriptHydrationPromise: newOwner,
    transcriptHydrationStatus: "loading",
  });

  setTranscriptHydrationIdle(state, oldOwner);
  clearTranscriptHydrationPromise(state, oldOwner);
  assert.equal(state.transcriptHydrationPromise, newOwner);
  assert.equal(
    state.transcriptHydrationStatus,
    "loading",
    "a stale remote settle must not release the newer request's loading gate"
  );

  clearTranscriptHydrationPromise(state, newOwner);
  assert.equal(state.transcriptHydrationPromise, null);
  assert.equal(
    state.transcriptHydrationStatus,
    "idle",
    "the live remote owner must atomically clear its promise and loading status"
  );
});
