// Changing which relay this surface IS — switching profiles, returning to the directory,
// forgetting the device.
//
// All three do two things: clear the surface (session, claim, pending actions) and move
// the stored identity (`remoteAuth` / `activeRelayId`). They are two separate
// `patchRemoteState` calls, so there is a window between them, and the ORDER decides what
// is visible in it:
//
//   reset -> move   the window shows the new identity with NO session. Harmless.
//   move -> reset   the window shows the NEW relay's id alongside the OLD relay's
//                   session, including its `active_thread_id`.
//
// The second is not a cosmetic flicker. Anything keyed on the relay id that also reads
// the session attributes one relay's thread ids to another — for the session tab set that
// means writing them into the wrong relay's IndexedDB database, which is the exact
// contamination per-relay storage exists to prevent, and it PERSISTS.
//
// React 18 batching almost certainly means no render lands in that window. "Almost
// certainly" is not a thing to store data on, and the correct order costs nothing, so the
// rule lives here with a name instead of as a habit at three call sites — one of which
// had already drifted.
//
// A failed reset deliberately aborts the move: arriving somewhere new while still holding
// the old surface is the hazard, not the recovery.

export function replaceRemoteIdentity({ resetSurface, moveIdentity } = {}) {
  resetSurface?.();
  moveIdentity?.();
}
