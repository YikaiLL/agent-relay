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

/**
 * Whether the Usage screen should render its locked preview.
 *
 * Deliberately the same fact as `tasksLocked`, derived rather than copied: two
 * independent flags would eventually disagree, and the disagreement would show
 * up as one unfinished screen unlocked and the other not on the same relay.
 * Usage earns the gate on its own merits — its 额度 policy controls are inert
 * placeholders until M2 lands, and an ungated build shows them to everyone.
 */
export function usageLocked(snapshot) {
  return !betaFeaturesEnabled(snapshot);
}
