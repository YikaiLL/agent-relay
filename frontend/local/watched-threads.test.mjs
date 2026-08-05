import assert from "node:assert/strict";
import test from "node:test";

import { createWatchedThreadsSync, watchedThreadIds } from "./watched-threads.js";

test("with no pinned thread, the active thread is what we watch", () => {
  assert.deepEqual(watchedThreadIds({ active_thread_id: "thread-a" }, null), ["thread-a"]);
});

// The local surface renders ONE conversation. When a background thread is pinned, that
// is what is on screen — streaming the active thread too would be text nothing draws.
test("a pinned thread replaces the active thread", () => {
  assert.deepEqual(watchedThreadIds({ active_thread_id: "thread-a" }, "thread-b"), ["thread-b"]);
});

test("with nothing open, nothing is watched", () => {
  assert.deepEqual(watchedThreadIds(null, null), []);
  assert.deepEqual(watchedThreadIds({}, null), []);
});

function stubFetch() {
  const calls = [];
  const apiFetch = async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  return { apiFetch, calls };
}

/** A fetch stub whose responses are resolved by the test, to drive in-flight races. */
function deferredFetch() {
  const calls = [];
  const gates = [];
  const apiFetch = (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return new Promise((resolve) => {
      gates.push(() => resolve({ ok: true, json: async () => ({ ok: true }) }));
    });
  };
  return { apiFetch, calls, releaseNext: () => gates.shift()?.() };
}

test("the declaration is POSTed with the device id and thread ids", async () => {
  const { apiFetch, calls } = stubFetch();
  const sync = createWatchedThreadsSync({ apiFetch, deviceId: "device-1" });

  await sync({ active_thread_id: "thread-a" }, null);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/session/watch-threads");
  assert.equal(calls[0].body.device_id, "device-1");
  assert.deepEqual(calls[0].body.thread_ids, ["thread-a"]);
});

// Callers fire this on every render. Without dedup, a routine re-render becomes a
// request — this is correctness, not an optimization.
test("an unchanged watch set does not re-POST", async () => {
  const { apiFetch, calls } = stubFetch();
  const sync = createWatchedThreadsSync({ apiFetch, deviceId: "device-1" });

  await sync({ active_thread_id: "thread-a" }, null);
  await sync({ active_thread_id: "thread-a" }, null);
  await sync({ active_thread_id: "thread-a" }, null);

  assert.equal(calls.length, 1, "only the first declaration should be sent");
});

test("changing the viewed thread re-declares", async () => {
  const { apiFetch, calls } = stubFetch();
  const sync = createWatchedThreadsSync({ apiFetch, deviceId: "device-1" });

  await sync({ active_thread_id: "thread-a" }, null);
  await sync({ active_thread_id: "thread-a" }, "thread-b");

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.thread_ids, ["thread-b"]);
});

test("with no device id nothing is declared", async () => {
  const { apiFetch, calls } = stubFetch();
  const sync = createWatchedThreadsSync({ apiFetch, deviceId: null });

  await sync({ active_thread_id: "thread-a" }, null);

  assert.equal(calls.length, 0);
});

test("the device id may be resolved lazily, for a surface that pairs after boot", async () => {
  const { apiFetch, calls } = stubFetch();
  let deviceId = null;
  const sync = createWatchedThreadsSync({ apiFetch, deviceId: () => deviceId });

  await sync({ active_thread_id: "thread-a" }, null);
  assert.equal(calls.length, 0, "no device id yet");

  deviceId = "device-late";
  await sync({ active_thread_id: "thread-a" }, null);
  assert.equal(calls.length, 1, "the declaration must fire once the device id exists");
});

// A failed declaration means the relay still holds the PREVIOUS set. Remembering the
// key we failed to send would strand this surface on a stale subscription.
test("a failed declaration is retried on the next call", async () => {
  const calls = [];
  let failNext = true;
  const apiFetch = async (path, options) => {
    calls.push(JSON.parse(options.body));
    if (failNext) {
      failNext = false;
      throw new Error("network down");
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const errors = [];
  const sync = createWatchedThreadsSync({
    apiFetch,
    deviceId: "device-1",
    onError: (error) => errors.push(error),
  });

  await sync({ active_thread_id: "thread-a" }, null);
  await sync({ active_thread_id: "thread-a" }, null);

  assert.equal(calls.length, 2, "the same set must be retried after a failure");
  assert.equal(errors.length, 1);
});


// REVIEW P2: switching A -> B while A's request is still in flight used to drop B
// entirely, leaving the relay subscribed to A while the user looked at B.
test("a target that changes mid-request is still delivered", async () => {
  const { apiFetch, calls, releaseNext } = deferredFetch();
  const sync = createWatchedThreadsSync({ apiFetch, deviceId: "device-1" });

  const first = sync({ active_thread_id: "thread-a" }, null);
  await sync({ active_thread_id: "thread-a" }, "thread-b");
  // Release A, let the loop notice the queued B and post it, then release B. `first`
  // only settles once the whole chain drains, so it must be awaited last.
  releaseNext();
  await new Promise((resolve) => setImmediate(resolve));
  releaseNext();
  await first;

  assert.deepEqual(
    calls.map((call) => call.body.thread_ids),
    [["thread-a"], ["thread-b"]],
    "the newer target must be delivered after the in-flight one lands"
  );
});

// REVIEW P2: a non-2xx is not a delivered declaration. Recording it as one would let
// the dedupe suppress every retry.
test("an HTTP error is not cached as a successful declaration", async () => {
  const calls = [];
  let ok = false;
  const apiFetch = async (path, options) => {
    calls.push(JSON.parse(options.body));
    const response = { ok, status: ok ? 200 : 500, json: async () => ({ ok }) };
    ok = true;
    return response;
  };
  const errors = [];
  const sync = createWatchedThreadsSync({
    apiFetch,
    deviceId: "device-1",
    onError: (error) => errors.push(error),
  });

  await sync({ active_thread_id: "thread-a" }, null);
  await sync({ active_thread_id: "thread-a" }, null);

  assert.equal(calls.length, 2, "a 500 must be retried, not deduped away");
  assert.equal(errors.length, 1);
});

// REVIEW P1: the relay drops watch sets when a connection ends. Without a reset the
// client would think it had already declared and never re-subscribe after reconnect.
test("reset makes the next call re-declare an unchanged set", async () => {
  const { apiFetch, calls } = stubFetch();
  const sync = createWatchedThreadsSync({ apiFetch, deviceId: "device-1" });

  await sync({ active_thread_id: "thread-a" }, null);
  await sync({ active_thread_id: "thread-a" }, null);
  assert.equal(calls.length, 1);

  sync.reset();
  await sync({ active_thread_id: "thread-a" }, null);

  assert.equal(calls.length, 2, "after a reconnect the same set must be re-declared");
});

test("the surface id is sent so two tabs are told apart", async () => {
  const { apiFetch, calls } = stubFetch();
  const sync = createWatchedThreadsSync({
    apiFetch,
    deviceId: "device-1",
    surfaceId: "tab-7",
  });

  await sync({ active_thread_id: "thread-a" }, null);

  assert.equal(calls[0].body.surface_id, "tab-7");
});

// REVIEW P2: the declaration must carry the connection generation, so a stale page's
// in-flight POST can be refused after a reload instead of clobbering the live watch set.
test("the connection generation rides along with the declaration", async () => {
  const { apiFetch, calls } = stubFetch();
  const sync = createWatchedThreadsSync({
    apiFetch,
    deviceId: "device-1",
    surfaceId: "tab-1",
    surfaceGeneration: () => 1730000000000,
  });

  await sync({ active_thread_id: "thread-a" }, null);

  assert.equal(calls[0].body.surface_generation, 1730000000000);
});
