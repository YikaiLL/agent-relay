// Deferred window→array projection, shared by local and remote. Appending a
// delta to the loaded window (applyTranscriptDeltaToWindow,
// transcript-hydration-store.js) is O(1) — a Map write. Projecting it back
// onto a rendered array (renderedTranscriptFromWindow) is O(n) in the loaded
// window, so that step is deferred: a delta only raises a pending flag, and
// settleTranscriptProjection does the actual rebuild, once, whenever it is
// next called. See .sealwire/PLAN.md, "The one lesson that keeps costing us".
//
// Previously local (frontend/local/transcript/store.js) and remote
// (frontend/remote/session-ops.js) each carried their own pending flag and
// settle function — remote's flag lived in a module-scoped variable instead
// of on `state`, and its settle function was hand-duplicated to cover its
// second session slot (state.realSession, for a pinned background thread).
// One implementation here, parameterized by which `state` properties hold a
// session that might need resettling.

import { renderedTranscriptFromWindow, transcriptWindowIsLoaded } from "./transcript-hydration-store.js";

/// Marks that a live delta appended to the loaded window without yet being
/// reflected in a rendered session's `.transcript`. The O(n) rebuild that
/// would reflect it is deferred until settleTranscriptProjection actually
/// runs, so a burst of deltas costs one rebuild instead of one per delta.
export function markTranscriptWindowProjectionPending(state) {
  state.transcriptWindowProjectionPending = true;
}

/// Idempotently materialise any pending window projection into one or more
/// session-shaped slots on `state`. Cheap when nothing is pending; safe to
/// call re-entrantly or from many call sites (flush start, the renderSession
/// chokepoint, or any path about to read/rewrite a transcript array) since it
/// always re-derives from the CURRENT window rather than trusting a
/// remembered array reference. That matters because array-identity detection
/// (the bug this replaces) has a blind spot: a write that rebuilds the array
/// — e.g. a transcript_entry_patch reducer — produces a new reference every
/// time, so identity comparison misses on exactly the case it needs to catch.
/// Settling before every read closes that gap: by the time a patch reads the
/// array to rebuild it, the pending delta is already baked in and rides
/// along in the patch's own rebuild.
///
/// `sessionKeys` lists which properties on `state` hold a session that might
/// need resettling — local has one (`["session"]`, the default); remote has
/// two (`["realSession", "session"]`), since a pinned background thread makes
/// those genuinely different objects. When two keys alias the same object
/// (the common, unpinned case), it is rebuilt once and both stay aliased,
/// rather than forking into two separately-rebuilt but value-identical ones.
///
/// The pending flag is always consumed, even with no session to settle into
/// (an auth loss or teardown that nulled every session slot) — otherwise it
/// would survive to the NEXT session (e.g. after re-auth) and that session's
/// first settle would splice in whatever the (unrelated, stale) window
/// currently holds. See .sealwire/PLAN.md, "Discarding the session must
/// discard pending derived state".
///
/// Returns whether it materialised anything, so a caller holding a
/// session-shaped copy (spread from a session before this ran) knows whether
/// it needs to fold the freshly-settled transcript back in (adoptSettledTranscript).
export function settleTranscriptProjection(state, sessionKeys = ["session"]) {
  if (!state?.transcriptWindowProjectionPending) {
    return false;
  }
  state.transcriptWindowProjectionPending = false;
  const threadId = state.transcriptHydrationThreadId || null;
  if (!transcriptWindowIsLoaded(state, threadId)) {
    return false;
  }

  let changed = false;
  const rebuiltByIdentity = new Map();
  for (const key of sessionKeys) {
    const session = state[key];
    if (!session || session.active_thread_id !== threadId) {
      continue;
    }
    if (!rebuiltByIdentity.has(session)) {
      rebuiltByIdentity.set(session, {
        ...session,
        transcript: renderedTranscriptFromWindow(state, session),
      });
    }
    state[key] = rebuiltByIdentity.get(session);
    changed = true;
  }
  return changed;
}

/// Reconcile a `session` a caller is about to render against a settle that
/// may have just reassigned one of `state`'s session slots out from under it
/// — a spread copy (`{...state.session, override}`) or an earlier read both
/// hold the pre-settle `.transcript`. Matched by active_thread_id, not
/// identity, for the same reason settleTranscriptProjection itself does not
/// trust identity. Checks `sessionKeys` in order (local's single slot by
/// default; remote passes `["realSession", "session"]`, checking the live
/// session before the (possibly-pinned) projected one).
export function adoptSettledTranscript(state, session, settled, sessionKeys = ["session"]) {
  if (!settled || !session?.active_thread_id) {
    return session;
  }
  for (const key of sessionKeys) {
    const candidate = state[key];
    if (candidate?.active_thread_id === session.active_thread_id) {
      return { ...session, transcript: candidate.transcript };
    }
  }
  return session;
}
