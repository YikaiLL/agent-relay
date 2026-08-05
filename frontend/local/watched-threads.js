// Declaring which threads this surface has on screen.
//
// The relay streams transcript deltas only to the devices watching a thread. That is
// what makes it affordable for EVERY thread to stream live instead of only the single
// globally-active one: a background thread nobody is looking at costs nothing, and a
// thread you open starts streaming without taking control of it.
//
// A device that has never declared falls back to "the active thread" on the relay side,
// which is exactly the pre-subscription behavior — so failing to declare degrades to
// the old experience rather than going silent.

/**
 * The threads a local surface actually renders live.
 *
 * The local surface shows ONE conversation at a time: either the relay's active thread,
 * or a pinned thread being read view-only. Declaring more than that would stream text
 * nothing is drawing.
 *
 * @param {object|null} session latest REAL session snapshot (never the view-only projection)
 * @param {string|null} viewThreadId thread the user is looking at, if not the active one
 * @returns {string[]} deduped, sorted thread ids
 */
export function watchedThreadIds(session, viewThreadId) {
  const ids = new Set();
  if (viewThreadId) {
    ids.add(viewThreadId);
  } else if (session?.active_thread_id) {
    ids.add(session.active_thread_id);
  }
  // Sorted so an unchanged set always produces an identical key, whatever order the
  // ids were added in — otherwise every render could look like a change and re-POST.
  return [...ids].sort();
}

/**
 * Create a declarer that POSTs only when the watch set actually changes.
 *
 * Callers fire this on every render, so deduping is not an optimization: without it a
 * routine re-render would become a request.
 */
export function createWatchedThreadsSync({
  apiFetch,
  deviceId,
  surfaceId,
  surfaceGeneration = null,
  onError = () => {},
}) {
  let lastKey = null;
  let inFlight = false;
  let pending = null;

  async function post(threadIds) {
    const resolvedDeviceId = typeof deviceId === "function" ? deviceId() : deviceId;
    const response = await apiFetch("/api/session/watch-threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: resolvedDeviceId,
        surface_id: typeof surfaceId === "function" ? surfaceId() : surfaceId,
        // Which connection this declaration belongs to. A stale page's in-flight POST
        // must not overwrite the watch set its replacement already declared.
        surface_generation:
          typeof surfaceGeneration === "function" ? surfaceGeneration() : surfaceGeneration,
        thread_ids: threadIds,
      }),
    });
    // A 4xx/5xx is NOT a delivered declaration. Treating it as one would cache a
    // subscription the relay never stored, and the dedupe below would then suppress
    // every retry — stranding this surface on the previous set forever.
    if (response && response.ok === false) {
      throw new Error(`watch-threads failed with HTTP ${response.status ?? "error"}`);
    }
  }

  const syncWatchedThreads = async function syncWatchedThreads(session, viewThreadId) {
    const resolvedDeviceId = typeof deviceId === "function" ? deviceId() : deviceId;
    if (!resolvedDeviceId) {
      return false;
    }
    const threadIds = watchedThreadIds(session, viewThreadId);
    const key = threadIds.join(" ");
    if (key === lastKey) {
      return false;
    }
    if (inFlight) {
      // Remember the LATEST target and let the in-flight call deliver it when it
      // lands. Dropping it outright is how switching A -> B mid-request ended up
      // leaving the relay subscribed to A.
      pending = threadIds;
      return false;
    }

    inFlight = true;
    let target = threadIds;
    try {
      // Loop so a target that arrived while we were posting is delivered too, rather
      // than waiting for some later unrelated render to notice.
      for (;;) {
        pending = null;
        await post(target);
        lastKey = target.join(" ");
        if (!pending) {
          return true;
        }
        target = pending;
      }
    } catch (error) {
      // The relay still holds the PREVIOUS set, so forget the key and let the next
      // render retry rather than caching a declaration that never arrived.
      lastKey = null;
      onError(error);
      return false;
    } finally {
      inFlight = false;
      pending = null;
    }
  };

  syncWatchedThreads.reset = () => {
    lastKey = null;
  };

  return syncWatchedThreads;
}

/**
 * Forget what was declared, so the next call re-declares.
 *
 * The relay drops watch sets when a connection ends. A client that remembers what it
 * "already sent" would then never re-declare after a reconnect, and its background
 * threads would silently fall back to polling until the user switched threads.
 */
export function resetWatchedThreadsDeclaration(sync) {
  sync?.reset?.();
}
