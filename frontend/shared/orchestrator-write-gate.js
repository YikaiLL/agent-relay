/**
 * May this device write to the Orchestrator?
 *
 * This is NOT the conversation's question, and answering it with the
 * conversation's answer is what broke the Tasks screen.
 * `canCurrentDeviceWrite` asks "is a conversation open, and do I hold ITS
 * controller lease?" — its first clause is `if (!session.active_thread_id)
 * return false`. The Orchestrator is a background thread that exists whether or
 * not a conversation does, so on a relay with nothing open that answered "no":
 * the composer refused every keystroke and the pane announced "Another device
 * has control". There was no other device, and there was no active thread —
 * the screen was simply dead until you happened to start a session first,
 * which is why it looked intermittent.
 *
 * A controller lease over the Orchestrator only exists once the relay has
 * FOCUSED it, which it does when a turn starts there (`focus_thread_runtime`
 * in state/relay.rs). Until then nobody holds it and anybody may write. Once it
 * is the active thread the ordinary rule applies again — so a second device
 * genuinely driving the Orchestrator is still reported honestly, rather than
 * this gate being a blanket `true` that silently takes control back.
 *
 * An absent thread id answers `true`, not `false`. The composer is already
 * disabled by `!orchId` while the thread is being created, and a `false` here
 * would make a pane that is merely still opening claim another device has
 * control — the exact confusion `OrchestratorPane` keeps `canWrite` and
 * `composerDisabled` separate to avoid.
 *
 * @param {object} args
 * @param {{ active_thread_id?: string|null, active_controller_device_id?: string|null }|null} args.session
 * @param {string|null} args.orchestratorThreadId
 * @param {string|null} args.deviceId
 * @returns {boolean}
 */
export function orchestratorCanWrite({ session, orchestratorThreadId, deviceId } = {}) {
  if (!orchestratorThreadId) {
    return true;
  }
  if (session?.active_thread_id !== orchestratorThreadId) {
    return true;
  }
  const controller = session?.active_controller_device_id;
  return !controller || controller === deviceId;
}
