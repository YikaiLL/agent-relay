import assert from "node:assert/strict";
import test from "node:test";

import {
  createTabWorkspace,
  layoutThreadIds,
  openThreadTab,
} from "./tab-layout.js";
import { SESSIONS_KEY } from "./tab-workspace-store.js";
import {
  DEFAULT_SESSION_VIEW_DB_NAME,
  createIndexedDbSessionViewPersistence,
} from "./session-view-persistence.js";

function threadIds(workspace) {
  return (workspace?.tabs || []).flatMap((tab) => layoutThreadIds(tab.layout));
}

// Minimal IndexedDB model for this adapter. Its important fidelity is global
// serialization of readwrite transactions across independently opened database
// connections; both contenders can be created before either one reads.
function createTransactionalIndexedDb() {
  const records = new Map();
  let created = false;
  let tail = Promise.resolve();
  let activeTransactions = 0;
  let maximumActiveTransactions = 0;
  let transactionCount = 0;

  function request() {
    return {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
    };
  }

  function database() {
    return {
      objectStoreNames: {
        contains(name) {
          return created && name === "tab-workspaces";
        },
      },
      createObjectStore() {
        created = true;
        return {
          put(record) {
            records.set(record.key, structuredClone(record));
            return request();
          },
        };
      },
      transaction(_name, mode) {
        assert.equal(mode, "readwrite");
        transactionCount += 1;
        let release;
        const previous = tail;
        tail = new Promise((resolve) => {
          release = resolve;
        });
        let started = false;
        let finished = false;
        let pendingRequests = 0;
        let completionTimer = null;

        const tx = {
          error: null,
          oncomplete: null,
          onabort: null,
          onerror: null,
          abort() {
            finish("abort");
          },
          objectStore() {
            return {
              getAll() {
                const result = request();
                enqueue(() => {
                  result.result = [...records.values()].map((record) =>
                    structuredClone(record)
                  );
                  result.onsuccess?.();
                });
                return result;
              },
              put(record) {
                const result = request();
                enqueue(() => {
                  records.set(record.key, structuredClone(record));
                  result.result = record.key;
                  result.onsuccess?.();
                });
                return result;
              },
              delete(key) {
                const result = request();
                enqueue(() => {
                  records.delete(key);
                  result.result = undefined;
                  result.onsuccess?.();
                });
                return result;
              },
            };
          },
        };

        function maybeComplete() {
          clearTimeout(completionTimer);
          completionTimer = setTimeout(() => {
            if (started && pendingRequests === 0 && !finished) {
              finish("complete");
            }
          }, 0);
        }

        function enqueue(operation) {
          pendingRequests += 1;
          void previous.then(() => {
            if (!started) {
              started = true;
              activeTransactions += 1;
              maximumActiveTransactions = Math.max(
                maximumActiveTransactions,
                activeTransactions
              );
            }
            queueMicrotask(() => {
              if (finished) {
                return;
              }
              operation();
              pendingRequests -= 1;
              maybeComplete();
            });
          });
        }

        function finish(kind) {
          if (finished) {
            return;
          }
          finished = true;
          clearTimeout(completionTimer);
          if (started) {
            activeTransactions -= 1;
          }
          release();
          if (kind === "complete") {
            tx.oncomplete?.();
          } else {
            tx.onabort?.();
          }
        }

        return tx;
      },
      close() {},
    };
  }

  return {
    records,
    stats() {
      return { maximumActiveTransactions, transactionCount };
    },
    open() {
      const result = request();
      queueMicrotask(() => {
        result.result = database();
        if (!created) {
          result.onupgradeneeded?.();
        }
        queueMicrotask(() => result.onsuccess?.());
      });
      return result;
    },
  };
}

function openThreadPlan(snapshot, threadId) {
  const workspace = openThreadTab(
    createTabWorkspace(snapshot[SESSIONS_KEY]),
    threadId
  );
  return {
    value: threadId,
    writes: { [SESSIONS_KEY]: workspace },
  };
}

test("overlapping adapters use one cross-connection readwrite transaction at a time", async () => {
  const indexedDb = createTransactionalIndexedDb();
  const firstWindow = createIndexedDbSessionViewPersistence({
    indexedDb,
    legacyPersistence: null,
  });
  const secondWindow = createIndexedDbSessionViewPersistence({
    indexedDb,
    legacyPersistence: null,
  });

  // Both transactions are requested before either getAll request runs.
  await Promise.all([
    firstWindow.transact((snapshot) => openThreadPlan(snapshot, "window-a")),
    secondWindow.transact((snapshot) => openThreadPlan(snapshot, "window-b")),
  ]);

  let finalSnapshot;
  await firstWindow.transact((snapshot) => {
    finalSnapshot = snapshot;
    return { value: null, writes: {} };
  });

  assert.deepEqual(
    threadIds(finalSnapshot[SESSIONS_KEY]),
    ["window-a", "window-b"]
  );
  assert.deepEqual(indexedDb.stats(), {
    maximumActiveTransactions: 1,
    transactionCount: 3,
  });
});

test("an asynchronous mutation callback is rejected instead of escaping the transaction", async () => {
  const persistence = createIndexedDbSessionViewPersistence({
    indexedDb: createTransactionalIndexedDb(),
    legacyPersistence: null,
  });

  await assert.rejects(
    persistence.transact(async () => ({ value: null, writes: {} })),
    /must be synchronous/
  );
});

test("workspace deletes commit in the same object-store transaction", async () => {
  const indexedDb = createTransactionalIndexedDb();
  const persistence = createIndexedDbSessionViewPersistence({
    indexedDb,
    legacyPersistence: null,
  });

  await persistence.transact(() => ({
    value: null,
    writes: {
      "deleted-project": openThreadTab(
        createTabWorkspace(),
        "stale-thread"
      ),
    },
  }));
  await persistence.transact((snapshot) => {
    assert.deepEqual(threadIds(snapshot["deleted-project"]), ["stale-thread"]);
    return {
      value: null,
      writes: {},
      deletes: ["deleted-project"],
    };
  });

  let finalSnapshot;
  await persistence.transact((snapshot) => {
    finalSnapshot = snapshot;
    return { value: null, writes: {} };
  });
  assert.equal(finalSnapshot["deleted-project"], undefined);
  assert.equal(indexedDb.records.has("deleted-project"), false);
});

// A tab set is keyed by thread and project ids, which are only unique within one
// relay. Surfaces that can point at more than one relay therefore need their own
// database, or one relay's tabs would attach to another's sessions. Local keeps the
// historical name so its stored tabs survive this becoming a parameter.
//
// The fake fails the open outright: the assertion is about the NAME the adapter asks
// for, and a fake that also had to complete a transaction would be all scaffolding.
test("the database name is the caller's, defaulting to the local surface's", async () => {
  const opened = [];
  const indexedDb = {
    open(name) {
      opened.push(name);
      const request = { result: null, error: new Error("refused"), onsuccess: null, onerror: null };
      queueMicrotask(() => request.onerror?.());
      return request;
    },
  };

  assert.equal(DEFAULT_SESSION_VIEW_DB_NAME, "sealwire-session-view");

  const scoped = createIndexedDbSessionViewPersistence({
    indexedDb,
    legacyPersistence: null,
    dbName: "sealwire-session-view-remote-relay-a",
  });
  await assert.rejects(() => scoped.transact(() => ({ value: null, writes: {} })));

  const local = createIndexedDbSessionViewPersistence({
    indexedDb,
    legacyPersistence: null,
  });
  await assert.rejects(() => local.transact(() => ({ value: null, writes: {} })));

  assert.deepEqual(opened, [
    "sealwire-session-view-remote-relay-a",
    "sealwire-session-view",
  ]);
});

test("a blocked database open rejects instead of hanging the caller indefinitely", async () => {
  let openRequest;
  let lateCloseCalls = 0;
  const indexedDb = {
    open() {
      const request = {
        result: null,
        error: null,
        onblocked: null,
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
      };
      openRequest = request;
      queueMicrotask(() => request.onblocked?.());
      return request;
    },
  };
  const persistence = createIndexedDbSessionViewPersistence({
    indexedDb,
    legacyPersistence: null,
  });

  const outcome = await Promise.race([
    persistence.transact(() => ({ value: null, writes: {} })).then(
      () => "resolved",
      (error) => `rejected:${error.message}`
    ),
    new Promise((resolve) => setTimeout(() => resolve("timed out"), 25)),
  ]);

  assert.match(outcome, /^rejected:.*blocked/i);

  openRequest.result = {
    close() {
      lateCloseCalls += 1;
    },
  };
  openRequest.onsuccess();
  assert.equal(
    lateCloseCalls,
    1,
    "a blocked request that later succeeds must not leak an unused database connection"
  );
});
