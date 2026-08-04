# Handover — file-diff renderer, patch appliability, duplicate cards

Trigger: a one-character edit to `package-lock.json` rendered in the transcript as
`−1395` with no additions — visually identical to the file having been deleted.

Three commits landed on `main`. One defect is reproduced but **not fixed**; that is the
work this handover exists for.

---

## Landed

### `f00162c` — stop a one-line edit rendering as a whole-file deletion

Two cost guards in the old hand-rolled renderer compounded. `MAX_LCS_CELLS` (4M) is
exceeded by any file over ~2000 lines (5993² ≈ 36M), which swapped the minimal diff for a
whole-file replacement — every old line `-`, then every new line `+`. The
`MAX_DIFF_LINES` (1400) truncation then cut that body off before the first `+`. The
arithmetic is exact: 3 header lines + 1 `@@` + 1395 removals = the 1399 kept, hence
`-1395/+0`.

The cap was measuring the wrong thing: it exists to bound the O(n·m) DP allocation, but
the DP only ever needs to run over lines that actually **differ**. Fixed by peeling the
shared prefix/suffix first. **A file being long is not the same as an edit being large.**

### `beb75e3` — hand the unified-diff format to jsdiff

Replaced ~170 lines of hand-rolled LCS / hunk builder / cost cap with `diff@9`
(`structuredPatch` + `formatPatch`). Net 91 lines removed.

Only the git **file header** (`diff --git a/x b/x`, mode lines, `/dev/null` sides) is
still ours — that shape is pinned by the relay's appliability check and the
repo-relative header rule, so it is deliberately not delegated.

Two live bugs fixed as a side effect:

- No `\ No newline at end of file` marker. Any file whose last line lacks a newline
  produced a patch `git apply` **refuses** ("patch does not apply") — Undo and Reapply
  were silently dead for every such file.
- A trailing-newline-only change rendered as no change at all.

**Non-obvious constraints, each learned by breaking it:**

| Constraint | Why |
|---|---|
| The cost guard could not be deleted | Myers is O(N·D) → O(N²) on fully-different files. 20k lines took **58 seconds** unbounded; the worker is one NDJSON loop, so that is a minute-long freeze of the session. jsdiff's `maxEditLength` (= `MAX_DIFF_LINES`) bounds it → 122ms. |
| Truncation keeps head **and** tail | A whole-file replacement is one hunk of every removal then every addition. A head-only cut drops every `+` and reads as `-N/+0` — the exact bug `f00162c` fixed. |
| jsdiff loads via `createRequire`, lazily | `scripts/sealwire-package.test.mjs` boots the packed worker with **no node_modules**; a static third-party import breaks startup there. Mirrors how the Anthropic SDK is already deferred to session start. |
| The dep is declared in **both** manifests | Root `package.json` for `npm i sealwire` (the worker resolves upward); `claude-worker/package.json` for the Tauri bundle, which runs `npm ci --omit=dev` inside the copied worker dir. Both lockfiles updated or the desktop build fails. |

`diff@9` is BSD-3-Clause with zero transitive dependencies.

### `bd60a9b` — stop offering Undo for a patch git will refuse

The worker truncates at `MAX_DIFF_LINES`, leaving the header well-formed while the body
stops early. Both appliability checks looked only at headers, so both said yes, the UI lit
up Undo, and `git apply` answered `corrupt patch at line N`.

`patch_is_appliable` (`crates/relay-server/src/protocol.rs`) now also verifies every hunk
delivers the number of lines its `@@` promises — context and `\` counted the way git
counts them, and the hunk closes the moment both sides are satisfied so the blank line
between two joined file patches is not miscounted as context.

**It stays a pure synchronous parse, deliberately.** This started out as "just call
`git apply --check`"; reading the call site changed the answer. It runs from
`strip_file_change_diffs_for_transport`, once per file-change entry **every time a
snapshot is serialized**, and has no workspace to run git in. A subprocess per entry is
not affordable. The apply path already shells out to real git and remains the authority on
whether a patch lands; this flag only decides whether to **offer** the control.

The frontend's `canApplyPatch` has its own fallback for the authoritative read/detail
paths (no relay verdict travels there, because the diff is still present) and had the same
blind spot. There it matches the truncation marker rather than re-implementing git's hunk
arithmetic — duplicating the counting is how you end up with two implementations
disagreeing, which is the thing the jsdiff swap just removed.

---

## Open — duplicate file-change cards

**Symptom.** One edited file draws **two** stacked cards, both labelled with the same
basename; one shows no +/− counts, the other shows the real ones. The group chip above
them says "1 file change". The affected entry carries an Undo button.

**Reproduced.** `scripts/diag-file-diff-cards.mjs` (committed, diagnostic — not a test)
drives the real local UI with the fake provider and a seeded transcript. Ladder:

| seed shape | rendered |
|---|---|
| one `fileChange`, `tool.path` and `file_changes[].path` both absolute | **1 card** ✅ |
| the same, plus a `turnDiff` in the same turn | **1 card** ✅ (the turnDiff filter works) |
| a `turnDiff` whose `file_changes` holds **both** the relative and the absolute spelling | **2 cards** ← the bug |

The third row matches the screenshot item for item:

```
groupChip: "··· 1 file change"      <- counted per distinct path, so it says 1
sections:  ["package-lock.json",     <- empty diff, no counts
            "package-lock.json"]     <- real diff, counts
entry:     turn-diff:<turn>          <- a turnDiff, which is why Undo is present
```

**Root cause (rendering layer, confirmed).** `merge_file_change_view`
(`crates/relay-server/src/file_changes.rs`) dedupes by **exact path-string equality**. The
worker deliberately reports `path` as ABSOLUTE (it is how the relay tells which worktree a
thread has been writing in) while `patchHeaderPath` writes the patch header
REPO-RELATIVE (what `git apply` requires). When both sources feed one list, the same file
arrives as two entries and `FileChangeDiff` draws a card per entry. The count is
path-deduped, hence "1 file change" over 2 cards.

This surfaces when the group has no `fileChange` members and falls back to rendering the
`turnDiff` (`frontend/shared/transcript-react.js`, the `fileChangeMembers.length ? … : …`
line) — i.e. after the per-edit entries have been compacted away.

**What is NOT yet proven.** Which code path actually produces the mixed-spelling list on a
**Claude** thread. The only transcript-side site that mixes keys is
`build_turn_diff_entry_with_fallback` (`codex.rs`), whose `split_unified_diff_by_file`
branch needs a non-empty `diff` — and both `claude.rs` call sites pass `None` or an
`existing_diff` that reads back as `None`. So either there is a write to `turnDiff.diff`
I did not find, or the affected thread carries data from an older build. The user confirms
the thread was Claude, so something does produce it.

Ruled out along the way:

- **Live path** — `tool_call_requested` sends `item_id: tool:${id}` and the result path
  builds the same `tool:{id}`, so the upsert replaces rather than duplicating.
- **Hydration path** — `toolEntryById` in `sdk-mapping.mjs` dedupes by the same key.
- **`merge_tool_call_view`** — replaces `file_changes` wholesale, never concatenates.
- **`~/.agent-relay/session.json`** — no tool anywhere carries a repeated basename
  (transcripts are not stored there, so this only rules out half).

### Suggested next steps

1. **Defensive fix, independent of finding the producer.** Canonicalize the spelling
   before merging, using the session root (`RelayState::current_cwd` / `thread_cwd`, and
   `cwd_for_thread` on the two replay call sites — all already available). A first cut
   plus three tests was written and then reverted for lack of a proven trigger; the
   shape was:

   ```rust
   pub(crate) fn relativize_file_change_paths(
       changes: &mut [FileChangeDiffView],
       root: Option<&str>,
   )
   ```

   **Do not loosen the match to a suffix test instead.** With only the two strings,
   `x.js` and `/repo/sub/x.js` are indistinguishable from a genuine pair of same-named
   files in different directories. The root is what removes the guess — one of the
   reverted tests pinned exactly that case.

2. **Keep hunting the producer.** Instrument `upsert_transcript_item` / the snapshot
   round-trip for any write that leaves a Claude `turnDiff` with a non-empty `diff`.

3. **Promote the diagnostic to a regression e2e** once the fix lands — it already
   reproduces on demand; it needs assertions instead of `console.log`.

---

## Also worth knowing

- **`patch_is_appliable` is still a hand-rolled model of git's format.** It is now much
  closer (it counts hunk bodies), but it is still our second implementation of "would git
  accept this". If it drifts again, the honest fix is to move the verdict to where a
  workspace exists and call real git once, not to add a fourth heuristic.
- **The recurring-bug taxonomy** (see the project memory note): family A is the
  algorithm/format layer, now closed by delegating to jsdiff. Family B is the
  capture/lifecycle layer — the re-read-disk root cause, provisional cards, patches lost
  on reload. The duplicate-card bug above is family B. A diff library does not touch it.
- **Untouched, not mine:** `scripts/browser-remote-mobile-session-actions-e2e.mjs` is
  modified in the working tree. It is a deliberately-red test awaiting its production CSS
  (project actions are hover-gated at `opacity: 0` and 24×24, with no
  `@media (hover: none)` rule covering `.thread-group-actions`), belonging to the mobile
  sidebar parity work. It was never staged or merged here.
