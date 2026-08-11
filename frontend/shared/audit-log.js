// Which audit-log lines are worth showing.
//
// Log entries carry a `kind` that names the CHANNEL, not a severity: the relay
// files its own events under `info` / `error` / `approval` / …, while a provider
// bridge drains its subprocess's stderr into a channel named after the provider
// (`codex`, `claude_worker`, `cursor`, …). That raw chatter is mostly progress
// noise, so only its lifecycle lines are worth a user's attention.
//
// This used to be written as `kind !== "codex"`, which classified by vendor
// rather than by what the channel is — so every provider except Codex flooded
// the audit view. Keying on the relay's own channels instead means a provider
// added later is filtered by default, which is the safe direction: an unknown
// channel is far more likely to be a new subprocess's stderr than a new relay
// event.

/** Channels the relay writes itself. Everything else is provider chatter. */
const RELAY_LOG_KINDS = new Set([
  "agent",
  "approval",
  "command",
  "error",
  "file_change",
  "info",
  "tool",
  "warn",
]);

/** Lifecycle lines that matter even inside a noisy provider channel. */
const NOTEWORTHY = /approval|pair|revoke|connected|disconnected|take over|control|broker|session/i;

export function shouldShowAuditEntry(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  // No kind at all is the relay's own default; hiding it would lose information
  // the user has no other way to see.
  if (!kind || RELAY_LOG_KINDS.has(kind)) {
    return true;
  }
  return NOTEWORTHY.test(String(entry?.message || ""));
}
