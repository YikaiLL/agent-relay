import test from "node:test";
import assert from "node:assert/strict";

import { scopedProviderModels } from "./shared/provider-settings.js";

// Real rows, trimmed: the Claude catalog is what the relay snapshot carries as
// `available_models` while a Claude session is active, and `"default"` is the
// id behind the SDK's "Default (recommended, Opus 5)" row — the exact option
// that showed up under a Cursor launch.
const CLAUDE_MODELS = [
  { display_name: "Default (recommended, Opus 5)", is_default: true, model: "default" },
  { display_name: "Sonnet 4.6", model: "claude-sonnet-4-6" },
];

// Real rows from `cursor-agent acp` (measured 2026-08-13): the ids are opaque
// and carry their settings inline, and `default[]` ("Auto") is Cursor's own
// default — nothing here overlaps a Claude id.
const CURSOR_MODELS = [
  { display_name: "Auto", is_default: true, model: "default[]" },
  { display_name: "composer-2.5", model: "composer-2.5[fast=true]" },
];

test("a provider with no catalog yet gets an empty list, never another provider's models", () => {
  // The reported bug: with a Claude session live and Cursor picked in the
  // launch dialog, the model select listed Claude's models ("Default
  // (recommended, Opus 5)") because the snapshot's `available_models` — which
  // belong to the ACTIVE session's provider — were used as the fallback for
  // whichever provider was being launched.
  const models = scopedProviderModels("cursor", {}, "claude_code", CLAUDE_MODELS);

  assert.deepEqual(models, []);
});

test("the snapshot fallback still applies when it is that provider's own catalog", () => {
  // The fallback exists for a real window: the session snapshot arrives before
  // `/api/providers/<p>/models` resolves. Scoping it must not disable it.
  const models = scopedProviderModels("claude_code", {}, "claude_code", CLAUDE_MODELS);

  assert.deepEqual(models, CLAUDE_MODELS);
});

test("a loaded catalog wins over the snapshot fallback", () => {
  const models = scopedProviderModels(
    "cursor",
    { cursor: CURSOR_MODELS },
    "claude_code",
    CLAUDE_MODELS
  );

  assert.deepEqual(models, CURSOR_MODELS);
});

test("an empty loaded catalog does not fall through to a foreign provider", () => {
  // `refreshProviderCatalogs` writes `[]` for a provider whose catalog request
  // succeeded but returned nothing (ACP publishes models only on session/new).
  // That is "this provider has no models yet", not "borrow someone else's".
  const models = scopedProviderModels("cursor", { cursor: [] }, "claude_code", CLAUDE_MODELS);

  assert.deepEqual(models, []);
});

test("a missing or unknown fallback provider never leaks the fallback list", () => {
  assert.deepEqual(scopedProviderModels("cursor", {}, "", CLAUDE_MODELS), []);
  assert.deepEqual(scopedProviderModels("cursor", {}, undefined, CLAUDE_MODELS), []);
});

test("scoping is tolerant of the argument shapes the callers actually pass", () => {
  // Call sites pass `state.providerModels` (may be empty) and
  // `state.session?.available_models || []` (may be undefined upstream).
  assert.deepEqual(scopedProviderModels("cursor", undefined, undefined, undefined), []);
  assert.deepEqual(scopedProviderModels("", {}, "", []), []);
});
