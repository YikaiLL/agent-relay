// A fork submit is async, and the dialog stays cancelable while it is in
// flight. So by the time a fork request resolves, the dialog on screen may no
// longer be the one that sent it: the user can cancel and reopen the dialog for
// a DIFFERENT source thread while the first request is still running.
//
// Applying a stale completion to whatever dialog happens to be open is what
// this guards. Concretely, without it:
//   - a stale SUCCESS closes the newer dialog out from under the user,
//     discarding the prompt and screenshots they had typed for it;
//   - a stale FAILURE stamps its error onto the newer dialog and clears the
//     newer request's `pending` flag while that request is still running.
//
// Each dialog opening takes a generation number; a completion may only touch
// the dialog if the generation it captured at submit time is still current.
export function forkCompletionEffect({
  capturedGeneration,
  currentGeneration,
  ok,
}) {
  if (capturedGeneration !== currentGeneration) {
    return "discard";
  }
  return ok ? "close" : "showError";
}
