// Which thread is actually on screen, and which entries belong to it.
//
// Detail expansion and file-diff loading resolve and fetch against THIS thread.
// Getting it wrong does not fail loudly: the details you asked for never load,
// and an item-id collision can surface a different thread's detail under the
// message you clicked.
//
// There are three ways a thread can be the one on screen, and they are checked
// most-specific first:
//
//   1. The Tasks screen is up, and it draws the Orchestrator. This is the only
//      one where the displayed thread is a SIBLING of the conversation rather
//      than a substitute for it, which is exactly why it was missed.
//   2. A view-only pin — a thread being read without taking control of it.
//   3. Otherwise the relay's active thread, which the conversation shows.

/**
 * @param {object|null} state the local surface's mutable state bag
 * @returns {string|null}
 */
export function displayedThreadIdFrom(state) {
  return (
    state?.orchestratorOnScreenThreadId
    || state?.viewOnlyThread?.threadId
    || state?.session?.active_thread_id
    || null
  );
}

/**
 * The entries rendered for `displayedThreadIdFrom(state)`.
 *
 * `hydratedTranscript` is passed rather than computed so this stays pure: the
 * conversation's entries come from the hydration window, which only the
 * transcript controller knows how to restore.
 *
 * @param {object|null} state
 * @param {object[]} hydratedTranscript entries for the ACTIVE thread
 * @returns {object[]}
 */
export function displayedEntriesFrom(state, hydratedTranscript = []) {
  if (state?.orchestratorOnScreenThreadId) {
    // While the Orchestrator IS the active thread its live entries are the
    // session transcript, not the cached page — the same source the pane draws
    // from, so a click resolves against what you can actually see.
    if (state.session?.active_thread_id === state.orchestratorOnScreenThreadId) {
      return hydratedTranscript || [];
    }
    return state.orchestratorEntries || [];
  }
  if (state?.viewOnlyThread) {
    return state.viewOnlyThread.entries || [];
  }
  return hydratedTranscript || [];
}
