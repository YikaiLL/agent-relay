import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

function createRequest() {
  return {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
  };
}

function createIndexedDbStub() {
  const databases = new Map();

  function createDatabase() {
    const stores = new Map();

    return {
      objectStoreNames: {
        contains(name) {
          return stores.has(name);
        },
      },
      createObjectStore(name, options = {}) {
        if (!stores.has(name)) {
          stores.set(name, {
            keyPath: options.keyPath || "id",
            records: new Map(),
          });
        }
        return {};
      },
      transaction(name) {
        const storeState = stores.get(name);
        const transaction = {
          error: null,
          oncomplete: null,
          onabort: null,
          onerror: null,
          objectStore() {
            return {
              get(key) {
                const request = createRequest();
                queueMicrotask(() => {
                  request.result = storeState.records.get(key);
                  request.onsuccess?.();
                  queueMicrotask(() => transaction.oncomplete?.());
                });
                return request;
              },
              put(value) {
                const request = createRequest();
                queueMicrotask(() => {
                  storeState.records.set(value[storeState.keyPath], value);
                  request.result = value[storeState.keyPath];
                  request.onsuccess?.();
                  queueMicrotask(() => transaction.oncomplete?.());
                });
                return request;
              },
            };
          },
        };
        return transaction;
      },
      close() {},
    };
  }

  return {
    open(name) {
      const request = createRequest();
      queueMicrotask(() => {
        let database = databases.get(name);
        const isNew = !database;
        if (!database) {
          database = createDatabase();
          databases.set(name, database);
        }
        request.result = database;
        if (isNew) {
          request.onupgradeneeded?.();
        }
        queueMicrotask(() => request.onsuccess?.());
      });
      return request;
    },
    peek(dbName, storeName, recordId) {
      return databases.get(dbName)?.transaction(storeName).objectStore().get(recordId);
    },
  };
}

function installBrowserStubs({ subtleAvailable, indexedDb = createIndexedDbStub() }) {
  const cryptoObject = {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  };
  if (subtleAvailable) {
    cryptoObject.subtle = webcrypto.subtle;
  }

  globalThis.window = {
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    },
    location: { href: "http://192.168.1.47:8788/" },
    history: {
      replaceState() {},
    },
    atob(value) {
      return Buffer.from(value, "base64").toString("binary");
    },
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    },
    crypto: cryptoObject,
    indexedDB: indexedDb,
  };

  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: cryptoObject,
  });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: indexedDb,
  });

  return { indexedDb };
}

async function importCrypto(tag) {
  return import(`./crypto.js?${tag}`);
}

test("ensureDeviceKeypair falls back to software storage when WebCrypto subtle is unavailable", async () => {
  const { indexedDb } = installBrowserStubs({ subtleAvailable: false });
  const { ensureDeviceKeypair } = await importCrypto(`software-fallback-${Date.now()}`);

  const keypair = await ensureDeviceKeypair();
  const signature = await keypair.sign(new TextEncoder().encode("agent-relay:test"));

  assert.ok(keypair.verifyKey);
  assert.ok(signature instanceof Uint8Array);

  const request = indexedDb.peek("agent-relay-crypto", "device-keys", "remote-device-keypair-v1");
  await new Promise((resolve, reject) => {
    request.onsuccess = () => {
      assert.equal(request.result.kind, "software");
      assert.ok(request.result.signingSeed);
      resolve();
    };
    request.onerror = () => reject(request.error || new Error("failed to inspect key store"));
  });
});

test("software-stored device keypair persists across module reloads", async () => {
  const indexedDb = createIndexedDbStub();
  installBrowserStubs({ subtleAvailable: false, indexedDb });
  const firstCrypto = await importCrypto(`software-persist-a-${Date.now()}`);
  const firstKeypair = await firstCrypto.ensureDeviceKeypair();

  installBrowserStubs({ subtleAvailable: false, indexedDb });
  const secondCrypto = await importCrypto(`software-persist-b-${Date.now()}`);
  const secondKeypair = await secondCrypto.ensureDeviceKeypair();

  assert.equal(secondKeypair.verifyKey, firstKeypair.verifyKey);
});
