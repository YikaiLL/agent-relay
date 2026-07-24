import test from "node:test";
import assert from "node:assert/strict";

import { createProjectsStore } from "./projects-store.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function payload(revision, projects = [], threadProjectId = {}) {
  return { projects_revision: revision, projects, thread_project_id: threadProjectId };
}

test("syncToRevision does an unconditional first fetch and populates state", async () => {
  let calls = 0;
  const store = createProjectsStore({
    fetchProjects: async () => {
      calls += 1;
      return payload(3, [{ id: "p", name: "P" }], { t1: "p" });
    },
  });

  store.syncToRevision(3);
  assert.equal(calls, 1, "fetches on first observation of any revision");
  await flush();
  assert.deepEqual(
    store.getState().projects.map((project) => project.id),
    ["p"]
  );
  assert.equal(store.getState().threadProjectId.t1, "p");
  assert.equal(store.getState().loading, false);
});

test("no refetch when the observed revision is unchanged", async () => {
  let calls = 0;
  const store = createProjectsStore({
    fetchProjects: async () => {
      calls += 1;
      return payload(2);
    },
  });

  store.syncToRevision(2);
  await flush();
  assert.equal(calls, 1);
  store.syncToRevision(2); // same revision → no-op
  await flush();
  assert.equal(calls, 1);
});

test("refetches when the revision changes", async () => {
  let calls = 0;
  const store = createProjectsStore({
    fetchProjects: async () => {
      calls += 1;
      return payload(calls === 1 ? 2 : 3);
    },
  });

  store.syncToRevision(2);
  await flush();
  assert.equal(calls, 1);
  store.syncToRevision(3);
  await flush();
  assert.equal(calls, 2);
});

test("a stale in-flight fetch cannot overwrite newer data", async () => {
  const gates = [deferred(), deferred()];
  let i = 0;
  const store = createProjectsStore({ fetchProjects: () => gates[i++].promise });

  store.syncToRevision(1); // fetch A
  store.syncToRevision(2); // fetch B supersedes

  // B (newest) resolves first, then the stale A.
  gates[1].resolve(payload(2, [{ id: "b", name: "B" }]));
  await flush();
  gates[0].resolve(payload(1, [{ id: "a", name: "A" }]));
  await flush();

  assert.deepEqual(
    store.getState().projects.map((project) => project.id),
    ["b"],
    "the newest fetch wins; a late stale one is dropped"
  );
});

test("refresh() force-fetches even when the revision is unchanged", async () => {
  let calls = 0;
  const store = createProjectsStore({
    fetchProjects: async () => {
      calls += 1;
      return payload(2);
    },
  });

  store.syncToRevision(2);
  await flush();
  assert.equal(calls, 1);
  store.refresh(); // e.g. right after a local mutation
  await flush();
  assert.equal(calls, 2, "refresh bypasses the revision no-op");
});

test("a malformed/null fetch payload is not latched as applied and retries", async () => {
  let calls = 0;
  const store = createProjectsStore({
    fetchProjects: async () => {
      calls += 1;
      // First call is malformed (null); second is valid.
      return calls === 1 ? null : payload(2, [{ id: "p", name: "P" }]);
    },
  });

  store.syncToRevision(2);
  await flush();
  assert.equal(calls, 1);
  assert.notEqual(store.getState().error, null, "malformed payload surfaces an error");
  assert.deepEqual(store.getState().projects, [], "no empty projects latched");

  // The revision was NOT marked applied → a repeat sync refetches and recovers.
  store.syncToRevision(2);
  await flush();
  assert.equal(calls, 2);
  assert.deepEqual(
    store.getState().projects.map((project) => project.id),
    ["p"]
  );
  assert.equal(store.getState().error, null);
});

test("reset() tears down the payload, emits, and refetches an equal revision (relay switch)", async () => {
  const gates = [deferred(), deferred()];
  let i = 0;
  const store = createProjectsStore({ fetchProjects: () => gates[i++].promise });

  // Relay A loads its projects at revision 7.
  store.syncToRevision(7);
  gates[0].resolve(payload(7, [{ id: "a", name: "Relay-A Project" }], { t1: "a" }));
  await flush();
  assert.equal(store.getState().loaded, true);
  assert.deepEqual(store.getState().projects.map((p) => p.id), ["a"]);

  // Switching relays: reset must CLEAR the payload, mark it unloaded, and EMIT — so
  // relay A's names/controls can't linger while relay B connects (fail closed).
  let emitted = false;
  const unsub = store.subscribe(() => {
    emitted = true;
  });
  store.reset();
  unsub();
  assert.equal(emitted, true, "reset emits so subscribers re-render");
  assert.equal(store.getState().loaded, false, "reset marks the payload unloaded");
  assert.deepEqual(store.getState().projects, [], "reset clears the previous relay's projects");
  assert.deepEqual(store.getState().threadProjectId, {}, "reset clears membership");
  assert.equal(store.getState().error, null);

  // Relay B advertises the SAME revision 7 (independent relays) → must still refetch.
  store.syncToRevision(7);
  assert.equal(i, 2, "an equal revision from a DIFFERENT relay refetches after reset");
  gates[1].resolve(payload(7, [{ id: "b", name: "Relay-B Project" }], { t2: "b" }));
  await flush();
  assert.deepEqual(store.getState().projects.map((p) => p.id), ["b"]);
});

test("reset() drops an in-flight fetch so a late previous-relay response can't apply", async () => {
  const gates = [deferred(), deferred()];
  let i = 0;
  const store = createProjectsStore({ fetchProjects: () => gates[i++].promise });

  // Relay A fetch is IN FLIGHT (unresolved).
  store.syncToRevision(7);
  await flush();
  assert.equal(store.getState().loading, true);

  // Switch relays mid-flight: reset clears loading and supersedes the in-flight fetch.
  store.reset();
  assert.equal(store.getState().loading, false, "reset clears the loading flag");

  // Relay B fetches at the same revision.
  store.syncToRevision(7);
  assert.equal(i, 2, "relay B launches exactly one replacement fetch");
  // Relay A's fetch resolves LATE — it must be dropped, not applied to relay B's view.
  gates[0].resolve(payload(7, [{ id: "a", name: "Relay-A" }], { t1: "a" }));
  await flush();
  assert.equal(
    store.getState().projects.some((p) => p.id === "a"),
    false,
    "a late response from the previous relay is dropped after reset"
  );
  // The generation-cleanup race: a same-revision snapshot arriving AFTER the stale A
  // resolved but BEFORE B resolves must NOT launch a third fetch (A's finally must not
  // have cleared B's in-flight marker).
  store.syncToRevision(7);
  assert.equal(i, 2, "no extra fetch is launched while relay B is still in flight");
  // Relay B resolves and applies.
  gates[1].resolve(payload(7, [{ id: "b", name: "Relay-B" }], { t2: "b" }));
  await flush();
  assert.deepEqual(store.getState().projects.map((p) => p.id), ["b"]);
});

test("reset() forces a refetch even at the same revision", async () => {
  let calls = 0;
  const store = createProjectsStore({
    fetchProjects: async () => {
      calls += 1;
      return payload(2);
    },
  });

  store.syncToRevision(2);
  await flush();
  assert.equal(calls, 1);
  store.syncToRevision(2); // no-op
  await flush();
  assert.equal(calls, 1);

  store.reset(); // relay/channel identity changed
  store.syncToRevision(2); // same revision, but reset → refetch
  await flush();
  assert.equal(calls, 2);
});

test("`loaded` gates fail-closed: false until a fetch actually succeeds", async () => {
  // Fail closed is the whole point of the flag: the sidebar must not present
  // sessions as authoritative Project membership (everything "Unassigned") until the
  // dedicated payload has really arrived. A rejected or malformed fetch must leave
  // `loaded` false so the consumer keeps showing a loading/error placeholder.
  let mode = "reject";
  const store = createProjectsStore({
    fetchProjects: async () => {
      if (mode === "reject") throw new Error("boom");
      if (mode === "malformed") return null;
      return payload(4, [{ id: "p", name: "P" }], { t1: "p" });
    },
  });

  // Initial state before any fetch settles: not loaded, no error.
  assert.equal(store.getState().loaded, false, "starts un-loaded");
  assert.equal(store.getState().error, null);

  // A rejected fetch surfaces an error but must NOT flip `loaded`.
  store.syncToRevision(4);
  await flush();
  assert.equal(store.getState().loaded, false, "a rejected fetch stays un-loaded");
  assert.equal(store.getState().error, "boom");

  // A malformed payload likewise stays un-loaded (and, per the retry contract, the
  // revision was not latched, so re-syncing retries).
  mode = "malformed";
  store.syncToRevision(4);
  await flush();
  assert.equal(store.getState().loaded, false, "a malformed fetch stays un-loaded");

  // Only a real success flips `loaded` true and clears the error.
  mode = "ok";
  store.syncToRevision(4);
  await flush();
  assert.equal(store.getState().loaded, true, "a successful fetch is loaded");
  assert.equal(store.getState().error, null);
  assert.deepEqual(
    store.getState().projects.map((project) => project.id),
    ["p"]
  );
});

// The renderer's fail-closed predicate, replicated so these tests pin the exact
// condition the sidebar guards on (render-session.js): show a placeholder unless we
// hold a payload we can vouch for as current.
const failsClosed = (s) => Boolean(s.error || !s.loaded || s.loading);

test("a pending revision refresh signals loading so the renderer fails closed", async () => {
  const gate = deferred();
  let calls = 0;
  const store = createProjectsStore({
    fetchProjects: () => {
      calls += 1;
      // rev 1 resolves immediately; rev 2's fetch is deferred (still in flight).
      return calls === 1 ? Promise.resolve(payload(1, [{ id: "p", name: "P" }], { t1: "p" })) : gate.promise;
    },
  });

  store.syncToRevision(1);
  await flush();
  assert.equal(store.getState().loaded, true);
  assert.equal(failsClosed(store.getState()), false, "settled + loaded → render groups");

  // A newer revision arrives; its fetch has not resolved yet.
  store.syncToRevision(2);
  await flush();
  const mid = store.getState();
  assert.equal(mid.loading, true, "the newer revision is in flight");
  assert.equal(mid.loaded, true, "prior data is retained in the store (not wiped)…");
  assert.deepEqual(mid.projects.map((p) => p.id), ["p"], "…but not yet advanced to rev 2");
  assert.equal(failsClosed(mid), true, "…so the renderer must fail closed while it is pending");

  gate.resolve(payload(2, [{ id: "p", name: "P" }, { id: "q", name: "Q" }], { t1: "p" }));
  await flush();
  assert.equal(failsClosed(store.getState()), false, "once the fetch resolves, groups render again");
  assert.deepEqual(store.getState().projects.map((p) => p.id), ["p", "q"]);
});

test("a failed revision refresh keeps the error latched across retries (no stale-grouping flash)", async () => {
  let calls = 0;
  const store = createProjectsStore({
    fetchProjects: () => {
      calls += 1;
      // rev 1 succeeds; every later revision fetch fails.
      return calls === 1
        ? Promise.resolve(payload(1, [{ id: "p", name: "P" }], { t1: "p" }))
        : Promise.reject(new Error("boom"));
    },
  });

  store.syncToRevision(1);
  await flush();
  assert.equal(store.getState().error, null);

  // rev 2 fails → error surfaces, renderer fails closed.
  store.syncToRevision(2);
  await flush();
  assert.equal(store.getState().error, "boom");
  assert.equal(failsClosed(store.getState()), true);

  // A retry (rev 3, still failing) must NOT transiently clear the error at fetch
  // start — that `error === null` window is exactly what lets a renderer's error
  // guard flash the prior (stale) grouping back in mid-retry. The store keeps the
  // error latched until a fetch actually succeeds.
  let errorEverCleared = false;
  const unsub = store.subscribe((s) => {
    if (s.error === null) errorEverCleared = true;
  });
  store.syncToRevision(3);
  await flush();
  unsub();
  assert.equal(errorEverCleared, false, "error stays latched through the failing retry (no stale-grouping window)");
  assert.equal(failsClosed(store.getState()), true);
  assert.equal(store.getState().error, "boom");
});

test("the response's revision is latched, not the triggering one", async () => {
  let calls = 0;
  const store = createProjectsStore({
    fetchProjects: async () => {
      calls += 1;
      // The triggering snapshot said 2, but the relay advanced: response carries 5.
      return payload(5, [{ id: "p", name: "P" }]);
    },
  });

  store.syncToRevision(2);
  await flush();
  assert.equal(calls, 1);
  // A later snapshot advertising 5 is a no-op — we already applied the response's 5.
  store.syncToRevision(5);
  await flush();
  assert.equal(calls, 1, "already have the response's revision");
});
