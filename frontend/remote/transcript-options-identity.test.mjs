// react-app.js cannot be imported directly in this test runner: it transitively
// pulls in shared/build-badge.js, which reads import.meta.env.BASE_URL — a
// Vite-only global that does not exist under plain `node --test`. So these
// two guards check the source text directly instead of executing RemoteApp.
//
// P1 regression this guards: stableTranscriptOptions (see
// ../shared/transcript-options-identity.js) only reuses the previous
// transcriptOptions object when every field is equal, which requires
// ensureFileChangeDetail and the ask-user-answers handler to be stable
// references. Both used to be recreated every render (a plain per-render
// `async function` and an inline method respectively), which silently
// defeated stableTranscriptOptions. These tests pin the useCallback fix.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./react-app.js", import.meta.url), "utf8");

test("ensureFileChangeDetail is hoisted via useCallback, not recreated as a plain function every render", () => {
  assert.doesNotMatch(
    source,
    /async function ensureFileChangeDetail\(/,
    "ensureFileChangeDetail must not be a plain per-render function declaration — it flows into " +
      "transcriptOptions and a fresh reference every render defeats stableTranscriptOptions"
  );
  assert.match(
    source,
    /const ensureFileChangeDetail = useCallback\(/,
    "ensureFileChangeDetail must be hoisted via useCallback so its identity survives an unrelated re-render"
  );
});

test("the ask-user-answers handler passed into the transcript props is a hoisted, stable reference", () => {
  assert.doesNotMatch(
    source,
    /onSubmitAskUserAnswers\(requestId, answers\) \{/,
    "the transcript props must not carry an inline onSubmitAskUserAnswers method — a fresh closure " +
      "every render defeats stableTranscriptOptions exactly like ensureFileChangeDetail did"
  );
  assert.match(
    source,
    /onSubmitAskUserAnswers: handleSubmitAskUserAnswers,/,
    "the transcript props must reference a hoisted, useCallback-stabilized handler"
  );
  assert.match(
    source,
    /const handleSubmitAskUserAnswers = useCallback\(/,
    "handleSubmitAskUserAnswers must itself be a useCallback with an empty dependency array " +
      "(it only ever reads handlersRef.current, never closure-captures `handlers` directly)"
  );
});
