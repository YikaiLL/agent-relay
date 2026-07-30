// Atomic browser persistence for the canonical session-view controller.
//
// A transaction reads every tab workspace, lets the store synchronously derive a
// write set, and commits that set in the SAME IndexedDB `readwrite` transaction.
// IndexedDB serializes overlapping read/write transactions for an object store,
// including transactions opened by another same-origin window. That is the
// cross-window guarantee localStorage read/write/verify sequences cannot provide.

import { createTabWorkspace } from "../shared/tab-layout.js";
import { browserTabWorkspacePersistence } from "../shared/tab-workspace-prefs.js";

const DB_NAME = "sealwire-session-view";
const DB_VERSION = 1;
const WORKSPACES_STORE = "tab-workspaces";

function defaultIndexedDb() {
  return (typeof globalThis !== "undefined" && globalThis.indexedDB) || null;
}

function requestResult(request, message) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(message));
  });
}

function transactionCompletion(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error || new Error("session-view transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error || new Error("session-view transaction failed"));
  });
}

function normalizedSnapshot(records) {
  return Object.fromEntries(
    (Array.isArray(records) ? records : [])
      .filter((record) => typeof record?.key === "string" && record.key)
      .map((record) => [record.key, createTabWorkspace(record.workspace)])
  );
}

/**
 * Create the browser transaction adapter.
 *
 * `mutate(snapshot)` must be synchronous and return
 * `{ value, writes, deletes }`, where `writes` maps workspace keys to their
 * complete next values and `deletes` names obsolete keys. Resolving `value`
 * happens only after IndexedDB commits the transaction.
 */
export function createIndexedDbSessionViewPersistence({
  indexedDb = defaultIndexedDb(),
  legacyPersistence = browserTabWorkspacePersistence,
} = {}) {
  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!indexedDb || typeof indexedDb.open !== "function") {
        reject(new Error("IndexedDB is unavailable for session-view persistence"));
        return;
      }

      const request = indexedDb.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (database.objectStoreNames.contains(WORKSPACES_STORE)) {
          return;
        }
        const store = database.createObjectStore(WORKSPACES_STORE, {
          keyPath: "key",
        });

        // One-time migration from the pre-controller localStorage adapter. Reads are
        // synchronous, so every seed write joins this database upgrade transaction.
        for (const key of legacyPersistence?.keys?.() || []) {
          const workspace = legacyPersistence?.load?.(key);
          if (workspace) {
            store.put({ key, workspace: createTabWorkspace(workspace) });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error("failed to open session-view database"));
    });
  }

  async function transact(mutate) {
    if (typeof mutate !== "function") {
      throw new TypeError("session-view persistence requires a transaction callback");
    }

    const database = await openDatabase();
    try {
      const transaction = database.transaction(WORKSPACES_STORE, "readwrite");
      const completion = transactionCompletion(transaction);
      completion.catch(() => {});
      const store = transaction.objectStore(WORKSPACES_STORE);
      const records = await requestResult(
        store.getAll(),
        "failed to read session-view workspaces"
      );

      let result;
      try {
        result = mutate(normalizedSnapshot(records));
        if (result && typeof result.then === "function") {
          throw new TypeError("session-view transaction callbacks must be synchronous");
        }
        const writeKeys = new Set(Object.keys(result?.writes || {}));
        for (const key of new Set(result?.deletes || [])) {
          if (typeof key === "string" && key && !writeKeys.has(key)) {
            store.delete(key);
          }
        }
        for (const [key, workspace] of Object.entries(result?.writes || {})) {
          if (key) {
            store.put({ key, workspace: createTabWorkspace(workspace) });
          }
        }
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // The original callback error is the useful failure.
        }
        throw error;
      }

      await completion;
      return result?.value;
    } finally {
      database.close();
    }
  }

  return { transact };
}

export const browserSessionViewPersistence =
  createIndexedDbSessionViewPersistence();
