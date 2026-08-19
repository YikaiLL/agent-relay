// Archive is not something every provider has. Codex has a real `thread/archive`
// RPC; Claude's bridge refuses; Cursor speaks ACP, which has no archive method at
// all. Offering the action anyway produced the worst possible outcome for Cursor:
// the relay dropped the row from its in-memory list, reported "Session archived",
// and the very next `session/list` handed the same session straight back. The
// button looked like it did nothing, because it did nothing.
//
// So the rule is the one the sheet already documents for transport-less actions:
// an action a provider cannot perform is never listed.
import test from "node:test";
import assert from "node:assert/strict";

import { providerSupportsArchive } from "./shared/thread-actions-model.js";

const CAPABILITIES = [
  { provider: "codex", native_archive: true },
  { provider: "claude_code", native_archive: false },
  { provider: "cursor", native_archive: false },
];

test("a provider is archivable only when the relay says its bridge archives", () => {
  assert.equal(
    providerSupportsArchive({ provider: "codex", capabilities: CAPABILITIES }),
    true
  );
  assert.equal(
    providerSupportsArchive({ provider: "cursor", capabilities: CAPABILITIES }),
    false,
    "Cursor speaks ACP, which has no archive method"
  );
  assert.equal(
    providerSupportsArchive({ provider: "claude_code", capabilities: CAPABILITIES }),
    false,
    "Claude's bridge refuses archive"
  );
});

// The inverse of `forkIsLossy`'s default, and deliberately so. There, assuming the
// worst means over-warning about context loss — recoverable. Here, assuming the
// worst would hide a working Codex archive behind an older relay's snapshot, and
// a control that vanishes is not something a user can reason about. An offered
// action that fails at least says why.
test("an unknown provider or an older relay's snapshot still offers archive", () => {
  assert.equal(providerSupportsArchive({ provider: "codex", capabilities: [] }), true);
  assert.equal(providerSupportsArchive({ provider: "codex" }), true);
  assert.equal(
    providerSupportsArchive({ provider: "brand-new-provider", capabilities: CAPABILITIES }),
    true,
    "a provider missing from the list is not evidence that it cannot archive"
  );
});

test("no provider at all is not treated as an archivable one", () => {
  assert.equal(providerSupportsArchive({ provider: "", capabilities: CAPABILITIES }), false);
  assert.equal(providerSupportsArchive({ capabilities: CAPABILITIES }), false);
  assert.equal(providerSupportsArchive(), false);
});

// Malformed rows must not throw the whole context menu open-handler.
test("malformed capability rows are ignored rather than fatal", () => {
  const messy = [null, undefined, {}, { provider: "cursor" }, ...CAPABILITIES];
  assert.equal(providerSupportsArchive({ provider: "cursor", capabilities: messy }), false);
  assert.equal(providerSupportsArchive({ provider: "codex", capabilities: messy }), true);
});
