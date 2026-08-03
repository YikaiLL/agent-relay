// The composer's failure line on the LOCAL surface: the one place a refused
// send/settings change is reported to the user.
//
// The local shell renders its composer once (react-shell.js) and drives it
// imperatively afterwards, so this mutates the region by node instead of going
// through props — the same style as #control-banner. Everything that can fail
// under the composer routes through here, so "nothing happened when I pressed
// Send" cannot come back one call site at a time.
//
// State and rendering are deliberately separate: record/clear only touch the
// thread they name (see shared/composer-errors.js for why that matters), and
// `syncComposerError` is the ONLY thing that writes to the DOM. render-session
// calls it on every render, so navigation alone settles what is on screen and
// a call site that forgets to sync is corrected by the next frame rather than
// leaving a stale line up.

import {
  threadError,
  withThreadError,
  withoutThreadError,
} from "../shared/composer-errors.js";

/** @type {Record<string, string>} */
let errors = {};

/**
 * Remember a failure against the thread it happened to.
 * @param {{ threadId?: string | null, message?: string }} failure
 */
export function recordComposerError({ threadId = "", message = "" } = {}) {
  errors = withThreadError(errors, threadId, message);
  return errors;
}

/** Drop one thread's failure. Other threads' failures are untouched. */
export function clearComposerError(threadId) {
  errors = withoutThreadError(errors, threadId);
  return errors;
}

/**
 * Render the failure belonging to the thread now on screen (if any).
 *
 * @param {{ textContent: string, hidden: boolean } | null | undefined} node
 * @param {string | null} viewedThreadId
 */
export function syncComposerError(node, viewedThreadId) {
  const shown = threadError(errors, viewedThreadId);
  if (node) {
    node.textContent = shown;
    node.hidden = !shown;
  }
  return shown;
}

/** Test seam: drop everything, so one test's failures cannot leak into another. */
export function resetComposerErrorsForTest() {
  errors = {};
}
