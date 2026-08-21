// The beta gate.
//
// The relay reports it on the session snapshot (`beta_features_enabled`, set
// from `sealwire --beta`), which both surfaces already consume — so no fetch and
// no client-side toggle. A browser-owned flag would unlock a screen whose every
// action the server still refuses.

/**
 * Whether in-development features are unlocked on the relay we are talking to.
 *
 * `=== true`, not truthiness: this reads JSON off a wire, so `"false"`, `"0"`
 * and `1` are all shapes a producer could send, and each must leave an
 * unfinished feature locked. Absence means locked too.
 */
export function betaFeaturesEnabled(snapshot) {
  return snapshot?.beta_features_enabled === true;
}

/** Whether the Task screen should render its locked preview. */
export function tasksLocked(snapshot) {
  return !betaFeaturesEnabled(snapshot);
}
