// Where this remote surface was last looking, kept in the browser.
//
// This is remote's stand-in for something local gets for free. On local, "which project
// workspace am I in" lives in `window.history.state` and "which session" lives in the
// URL's `?thread=`, so a reload re-enters through `restoreHistory(...)` and lands exactly
// where it left — see `app.js`'s boot. Remote has no URL routing at all
// (`historyAdapter: null` in session-tabs-host.js), so a reload had nowhere to read that
// from and always fell back to whatever thread the relay happened to be running.
//
// Nothing here goes near the relay. It is the client's own view state, and storing it
// server-side would make one browser's scroll position into shared state.
//
// Only the CONTEXT is remembered, deliberately. A workspace already persists its own
// `focusedTabId`, and the location's thread is DEFINED as that workspace's focused thread
// (`sessionViewInvariantErrors` enforces exactly this). Writing the thread here too would
// create a second copy of a fact that already round-trips, and second copies disagree.
//
// PER RELAY, and not negotiable: a context is a project id, and project ids are unique
// only within one relay. A shared key would let relay A's remembered project select a
// workspace under relay B — the same class of hazard `relay-scoped-state.js` exists to
// prevent, and one the older `sealwire:removed-threads` key still has.
//
// Fail-soft like the other prefs modules: storage unavailable, full, or corrupt degrades
// to "nothing remembered", which is precisely today's behaviour. It never throws, because
// a navigation must not fail on a bookkeeping write.
//
// Two browser tabs on the SAME relay share one key, last write wins — deliberately, and
// unlike the tab workspaces, which IndexedDB serializes per key. A memo is one small fact
// about "where was I", the loser of a race is one reload landing in the other tab's
// workspace, and the alternative (a per-tab key) would mean nothing is remembered at all
// after the tab that wrote it closes, which is the case this exists to serve.

const KEY_PREFIX = "sealwire:remote-session-location:";
const MEMO_VERSION = 1;

export function sessionLocationMemoKey(relayScope) {
  return `${KEY_PREFIX}${relayScope}`;
}

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * A location memo shaped as a session-view HISTORY ADAPTER.
 *
 * The controller already calls `historyAdapter.write(...)` on exactly the commits that
 * move the surface, and skips the ones that do not (pin/move/promote are "none"). That
 * is the same set of moments this needs to record, so wiring it in as the adapter means
 * there is no second list of call sites to keep in step — the one on local is the
 * browser's history, the one here is a single storage key.
 *
 * `read()` is not part of what the controller calls; boot calls it directly, the way
 * app.js reads `window.history.state` itself.
 */
export function createSessionLocationMemo({ relayScope, storage = defaultStorage() } = {}) {
  const key = sessionLocationMemoKey(relayScope);

  return {
    key,

    /** The remembered entry, in the shape `restoreHistory`/`contextFromHistory` expect. */
    read() {
      if (!storage) {
        return null;
      }
      try {
        const parsed = JSON.parse(storage.getItem(key) || "null");
        return parsed?.version === MEMO_VERSION && parsed.context ? parsed : null;
      } catch {
        return null;
      }
    },

    write({ entry } = {}) {
      // An entry with no context is not a location, and must not overwrite one that is.
      if (!storage || !entry?.context) {
        return;
      }
      try {
        storage.setItem(
          key,
          JSON.stringify({ version: MEMO_VERSION, context: entry.context })
        );
      } catch {
        // A full or blocked store loses the memory, not the navigation.
      }
    },

    /** Teardown for "forget this relay" — the same duty state.js and relay-nicknames.js have. */
    forget() {
      try {
        storage?.removeItem?.(key);
      } catch {
        // Nothing here is worth failing a teardown for.
      }
    },
  };
}
