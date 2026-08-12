import test from "node:test";
import assert from "node:assert/strict";

import { shouldShowAuditEntry } from "./audit-log.js";

test("relay-owned channels always show", () => {
  for (const kind of [
    "info",
    "error",
    "warn",
    "approval",
    "agent",
    "tool",
    "command",
    "file_change",
  ]) {
    assert.equal(
      shouldShowAuditEntry({ kind, message: "anything at all" }),
      true,
      `${kind} is the relay talking about itself and must not be filtered`,
    );
  }
});

test("raw provider chatter is filtered down to the interesting lines", () => {
  // The filter was keyed on the literal kind `codex`, so every OTHER provider's
  // raw stderr went straight to the audit view unfiltered — `claude_worker`
  // already did, and each new provider joined it. The rule is about *what the
  // channel is*, not which vendor happens to own it.
  for (const kind of ["codex", "claude_worker", "cursor"]) {
    assert.equal(
      shouldShowAuditEntry({ kind, message: "tokenizer warmup 43%" }),
      false,
      `${kind} is raw provider chatter and should be filtered`,
    );
    assert.equal(
      shouldShowAuditEntry({ kind, message: "provider disconnected" }),
      true,
      `${kind} must still surface lifecycle lines`,
    );
  }
});

test("an unknown channel is treated as provider chatter, not as relay news", () => {
  // Safe by default: a channel nobody has classified is far more likely to be a
  // new provider's stderr than a new relay event.
  assert.equal(shouldShowAuditEntry({ kind: "some-future-agent", message: "noise" }), false);
  assert.equal(
    shouldShowAuditEntry({ kind: "some-future-agent", message: "broker connected" }),
    true,
  );
});

test("malformed entries do not throw and do not vanish", () => {
  // A log line with no kind is the relay's own default; hiding it would lose
  // information the user has no other way to see.
  assert.equal(shouldShowAuditEntry({ message: "no kind" }), true);
  assert.equal(shouldShowAuditEntry({}), true);
  assert.equal(shouldShowAuditEntry(null), true);
  assert.equal(shouldShowAuditEntry({ kind: "INFO", message: "upper case" }), true);
});
