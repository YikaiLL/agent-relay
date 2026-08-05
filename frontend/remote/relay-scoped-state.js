// What has to be forgotten when the surface points at a DIFFERENT relay.
//
// Extracted from the effect that used to inline it, because "which pieces of UI state
// are relay-scoped" is a rule, not an implementation detail — and because an effect
// body is only checkable by rendering the whole app, which is how the second entry
// below went in unverified.
//
// The shared hazard: both of these are keyed by ids that are only unique WITHIN one
// relay. Carried across a switch they do not merely go stale, they can silently attach
// to a different relay's object that happens to share an id.
//
//   - The bell's retention map is keyed by THREAD id, so one relay's remembered states
//     would decide which of another's sessions the bell keeps listed.
//   - The Project switcher's selection is a PROJECT id, so a pin could land on a
//     project the user never chose. (The switcher fails open on an id it cannot
//     resolve, so the usual outcome is a harmless no-op — but "usually harmless"
//     is not the same as correct, and a collision is silent when it happens.)
//
// Anything else added here should meet the same test: is it keyed by something only one
// relay issues?
export function resetRelayScopedState({ remoteUiStore, threadListStore } = {}) {
  remoteUiStore?.getState?.().setThreadFilterRetained?.(new Map());
  threadListStore?.getState?.().setActiveProject?.(null);
}
