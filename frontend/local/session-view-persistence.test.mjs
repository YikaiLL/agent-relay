import assert from "node:assert/strict";
import test from "node:test";

import {
  createTabWorkspace,
  layoutThreadIds,
  openThreadTab,
} from "../shared/tab-layout.js";
import { SESSIONS_KEY } from "../shared/tab-workspace-store.js";
import {
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
