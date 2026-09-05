// react-app.js cannot be imported directly in this test runner: it transitively
// pulls in shared/build-badge.js, which reads import.meta.env.BASE_URL — a
// Vite-only global that does not exist under plain `node --test` (confirmed:
// no test in this repo imports react-app.js). frontend/local/render-session.test.mjs
// hits the same wall for the local surface and is explicit about the fallback
// ("a real DOM-driven test isn't the point here ... the source itself is the
// artifact under test") — this file follows that same precedent.
//
// P1 regression this guards: stableTranscriptOptions (added to stabilize the
// transcriptOptions identity RemoteTranscriptPanel hands to React.memo'd
// transcript entries) only reuses the previous object when every field is
// equal. ensureFileChangeDetail used to be declared as a plain per-render
// `async function`, and the ask-user-answers handler passed into the
// transcript props was an inline method — both fresh references every
// render, so stableTranscriptOptions could never actually reuse the remote
// options object. The first two tests pin the source-level fix (the only
// thing checkable without executing RemoteApp); the rest exercise
// transcriptOptionValueEqual/stableTranscriptOptions themselves, extracted
// live from the current source and run for real, against the exact input
// shape RemoteApp now produces (stable handler references, but collection
// fields that are still fresh-but-equal instances every call — e.g.
// buildExpandedTranscriptDetailEntries always returns a new Map).

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

// Pulls a top-level `export function NAME(...) { ... }` out of the source by
// brace-matching and returns it with the `export` keyword stripped, so it can
// be embedded in a `new Function` body. Fragile only insofar as the function
// must stay a straightforward named declaration — true today for both.
function extractFunctionSource(name) {
  const marker = `export function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `expected to find ${marker} in react-app.js`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > braceStart, `expected to find the end of ${name}'s body`);
  return source.slice(start, end).replace(/^export /, "");
}

const { transcriptOptionValueEqual, stableTranscriptOptions } = new Function(
  `${extractFunctionSource("transcriptOptionValueEqual")}\n${extractFunctionSource("stableTranscriptOptions")}\nreturn { transcriptOptionValueEqual, stableTranscriptOptions };`
)();

test("stableTranscriptOptions reuses the previous object when handlers are stable but collection fields are fresh-but-equal instances", () => {
  // Mirrors the REAL shape RemoteApp now produces: onEnsureFileChangeDetail
  // and onSubmitAskUserAnswers are the SAME reference across both calls (the
  // fix), but detailEntries/askUserErrors/askUserDetailErrors/
  // askUserDetailLoadingRequestIds are fresh instances each call (unchanged
  // upstream behavior — buildExpandedTranscriptDetailEntries always builds a
  // new Map, and the two-branch `instanceof Map ? x : new Map()` fallbacks
  // allocate fresh when nothing is pending).
  const onEnsureFileChangeDetail = () => {};
  const onSubmitAskUserAnswers = () => {};
  const pendingAskUserQuestions = [];

  function buildOptions() {
    return {
      currentCwd: "/repo",
      detailEntries: new Map(),
      enableFileChangeActions: true,
      expandedItemIds: new Set(["a"]),
      expandedKeys: new Set(["a"]),
      loadingItemIds: new Set(),
      canFork: true,
      provider: "claude",
      onEnsureFileChangeDetail,
      pendingAskUserQuestions,
      onSubmitAskUserAnswers,
      askUserSubmittingRequestId: "",
      askUserErrors: new Map(),
      askUserDetailErrors: new Map(),
      askUserDetailLoadingRequestIds: new Set(),
    };
  }

  const first = stableTranscriptOptions(null, buildOptions());
  const second = stableTranscriptOptions(first, buildOptions());

  assert.equal(second, first, "identical-by-value input must reuse the previous object");
});

test("stableTranscriptOptions does NOT reuse the object when a handler's reference changes — the exact regression a per-render closure caused", () => {
  function buildOptions(handler) {
    return {
      currentCwd: "/repo",
      detailEntries: new Map(),
      onEnsureFileChangeDetail: handler,
      onSubmitAskUserAnswers: () => {},
    };
  }

  const first = stableTranscriptOptions(null, buildOptions(() => {}));
  // A DIFFERENT handler reference each call — reproduces the pre-fix bug
  // (ensureFileChangeDetail as a plain function, recreated every render).
  const second = stableTranscriptOptions(first, buildOptions(() => {}));

  assert.notEqual(
    second,
    first,
    "a changed handler reference must correctly invalidate the cache — proves the equality check " +
      "isn't accidentally ignoring function fields"
  );
});

test("transcriptOptionValueEqual treats two empty (or identically-populated) Maps/Sets as equal despite different references", () => {
  assert.equal(transcriptOptionValueEqual(new Map(), new Map()), true);
  assert.equal(transcriptOptionValueEqual(new Set(), new Set()), true);
  assert.equal(transcriptOptionValueEqual(new Map([["a", 1]]), new Map([["a", 1]])), true);
  assert.equal(transcriptOptionValueEqual(new Map([["a", 1]]), new Map([["a", 2]])), false);
  assert.equal(transcriptOptionValueEqual([], []), true);
  assert.equal(transcriptOptionValueEqual([1, 2], [1, 2]), true);
  assert.equal(transcriptOptionValueEqual([1], [1, 2]), false);
});
