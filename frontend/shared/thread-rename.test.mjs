import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_THREAD_NAME_CHARS,
  normalizeThreadName,
  threadCustomName,
  threadNameChanged,
  threadNameDraft,
} from "./thread-rename.js";

// Blank in every form means RESET, not "store an empty title". A nameless tab is
// strictly worse than the agent's own guess, so there is no way to ask for one.
test("every flavour of blank normalizes to a reset", () => {
  for (const blank of ["", "   ", "\t\n", null, undefined, 42, {}]) {
    assert.equal(normalizeThreadName(blank), null, `expected reset for ${JSON.stringify(blank)}`);
  }
});

test("a name is trimmed, and capped at the relay's limit", () => {
  assert.equal(normalizeThreadName("  Auth work  "), "Auth work");
  assert.equal(normalizeThreadName("x".repeat(MAX_THREAD_NAME_CHARS)).length, MAX_THREAD_NAME_CHARS);
  // Capped rather than rejected: the relay would refuse an overlong name outright, and
  // silently losing a long paste is friendlier than an error on a rename.
  assert.equal(
    normalizeThreadName("y".repeat(MAX_THREAD_NAME_CHARS + 50)).length,
    MAX_THREAD_NAME_CHARS
  );
});

// Both surfaces gate their dispatch on this, so it must agree with normalization —
// otherwise "  Auth work  " over "Auth work" would look like a change and cost a round
// trip that the relay then treats as a no-op.
test("a change is judged after normalization, not on the raw text", () => {
  assert.equal(threadNameChanged("  Auth work  ", "Auth work"), false);
  assert.equal(threadNameChanged("Auth work", "auth work"), true, "case is meaningful");
  assert.equal(threadNameChanged("Auth work", null), true);
  assert.equal(threadNameChanged("", null), false, "clearing an unset name changes nothing");
  assert.equal(threadNameChanged("", "Auth work"), true, "clearing a set name is a change");
});

// THE reason the comparison is against the OVERRIDE and not the displayed title:
// re-typing the agent's current title is a real action — it PINS that title against the
// agent's next re-derivation, which is the whole point of the feature.
test("typing the agent's own title over an unset override is a real change", () => {
  const thread = { name: "Fix the auth bug", renamed: false };
  assert.equal(
    threadNameChanged("Fix the auth bug", threadCustomName(thread)),
    true,
    "pinning the agent's current title must not be skipped as a no-op"
  );
  // ...and once pinned, submitting it again really is a no-op.
  assert.equal(threadNameChanged("Fix the auth bug", "Fix the auth bug"), false);
});

// Editing starts from what you can SEE. Opening an empty box on a session that has
// never been renamed would make "rename" mean "retype from scratch".
test("the draft is seeded from the displayed title, falling back down the chain", () => {
  assert.equal(threadNameDraft({ name: "Auth work", preview: "hello" }), "Auth work");
  assert.equal(threadNameDraft({ name: null, preview: "hello there" }), "hello there");
  assert.equal(threadNameDraft({ name: null, preview: "" }, "abc1234"), "abc1234");
  assert.equal(threadNameDraft(null, "abc1234"), "abc1234");
  assert.equal(threadNameDraft(null), "");
});

// The override is reassembled from (`renamed`, `name`) rather than sent as its own
// string: whenever an override exists it IS `name`, so a second copy would duplicate the
// title inside a byte-budgeted remote frame.
test("the override is read back from the renamed flag, not a duplicated field", () => {
  assert.equal(threadCustomName({ name: "Auth work", renamed: true }), "Auth work");
  assert.equal(threadCustomName({ name: "Fix the auth bug" }), null);
  assert.equal(threadCustomName({ name: "Fix the auth bug", renamed: false }), null);
  assert.equal(threadCustomName(null), null);
});

// A title the USER typed ending in "…" is theirs. An earlier version of this module
// stripped EVERY trailing ellipsis, on the theory that it might be one the relay added
// when compacting for the wire — which silently renamed "Waiting…" to "Waiting".
test("a title the user typed ending in an ellipsis survives verbatim", () => {
  assert.equal(normalizeThreadName("Waiting…"), "Waiting…");
  assert.equal(threadNameDraft({ name: "Waiting…", renamed: true }), "Waiting…");
  // ...including on a session with no override at all, where the strip is even eligible.
  assert.equal(threadNameDraft({ name: "Waiting…" }), "Waiting…");
});

// The relay caps USER titles at the smallest wire budget, so an override is never
// shortened in transit. It caps nothing on the PROVIDER's titles, though — Claude derives
// one from the first prompt, which is easily longer than 96 — so a never-renamed session
// can arrive compacted. Confirming the prompt there would persist the ellipsis as part of
// the stored name.
//
// The tail cannot be recovered client-side (it never arrived); dropping the marker is the
// one honest thing left. Detection is exact: compaction leaves a result that is EXACTLY
// the budget long AND ends in the marker, and it is only consulted for titles the relay
// says are not the user's.
test("a relay-compacted provider title does not carry its ellipsis into a rename", () => {
  const compacted = `${"x".repeat(MAX_THREAD_NAME_CHARS - 1)}…`;
  assert.equal([...compacted].length, MAX_THREAD_NAME_CHARS, "the compaction signature");
  assert.equal(threadNameDraft({ name: compacted }), "x".repeat(MAX_THREAD_NAME_CHARS - 1));

  // A user's own title of the same shape is NOT touched — `renamed` puts it out of reach.
  assert.equal(threadNameDraft({ name: compacted, renamed: true }), compacted);

  // Nor is anything that merely ends in an ellipsis without the length signature.
  assert.equal(threadNameDraft({ name: "short…" }), "short…");
  // ...or is the right length without the marker.
  const exact = "y".repeat(MAX_THREAD_NAME_CHARS);
  assert.equal(threadNameDraft({ name: exact }), exact);
});

// THE reason the cap is 96 and not 200: it is the smallest budget any surface applies to
// a name, so a user-set title is never truncated on its way to a client. The rename
// dialogs seed themselves from the title they were shown, so a truncated one would let
// the user confirm an ellipsised prefix and destroy the tail.
test("the cap matches the smallest wire budget, so a stored title is never truncated", () => {
  assert.equal(MAX_THREAD_NAME_CHARS, 96, "must equal the remote list's max_name_chars");
  const atCap = "x".repeat(MAX_THREAD_NAME_CHARS);
  assert.equal(normalizeThreadName(atCap), atCap);
  assert.equal(threadNameDraft({ name: atCap, renamed: true }), atCap);
});

// The relay counts with `chars().count()` (Unicode scalar values); `String.slice` counts
// UTF-16 code units. Cutting with `slice` disagrees on any astral character and can slice
// a surrogate PAIR in half, producing a lone surrogate that is not valid UTF-8 on the
// wire — a request the relay cannot even parse.
test("the cap counts code points, and never splits a surrogate pair", () => {
  const emoji = "🙂";
  assert.equal([...emoji].length, 1, "one code point");
  assert.equal(emoji.length, 2, "...but two UTF-16 code units");

  // Exactly at the cap in code points: kept whole, even though `.length` is far over.
  const atCap = emoji.repeat(MAX_THREAD_NAME_CHARS);
  assert.equal([...normalizeThreadName(atCap)].length, MAX_THREAD_NAME_CHARS);
  assert.equal(normalizeThreadName(atCap), atCap);

  // The boundary a code-unit slice would corrupt: cutting mid-pair leaves a lone
  // surrogate, which round-trips through JSON as an unpaired escape.
  const boundary = "a".repeat(MAX_THREAD_NAME_CHARS - 1) + emoji + "tail";
  const normalized = normalizeThreadName(boundary);
  assert.equal([...normalized].length, MAX_THREAD_NAME_CHARS);
  assert.ok(normalized.endsWith(emoji), "the emoji must survive whole or not at all");
  for (const unit of normalized) {
    assert.ok(!(unit >= "\ud800" && unit <= "\udfff") || [...normalized].includes(unit),
      "no lone surrogate may remain");
  }
  assert.equal(JSON.parse(JSON.stringify(normalized)), normalized);
});
