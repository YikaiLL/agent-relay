// Whether a session's file changes can be rolled back / reapplied.
//
// Undo/Reapply pipes the stored diff straight to `git apply` with no header repair
// (see apply_unified_diff). Claude's worker builds the patch header from the tool's
// `file_path`, which Claude Code always supplies as an ABSOLUTE path — producing
// `diff --git a//Users/...`, which git refuses outright as `invalid path`. So the
// control can never succeed on a Claude thread, and a button guaranteed to fail is
// worse than no button.
//
// Codex sends relative paths with full `---`/`+++` headers and applies correctly;
// that path is pinned by `a_codex_shaped_diff_actually_rolls_back_and_reapplies`.
//
// Deliberately an allow-by-default check: only the provider known to be broken is
// excluded, so an unknown or not-yet-loaded provider does not silently lose a
// working control.
const PROVIDERS_WITH_UNAPPLIABLE_DIFFS = new Set(["claude_code"]);

export function canApplyFileChanges(session) {
  return !PROVIDERS_WITH_UNAPPLIABLE_DIFFS.has(session?.provider || "");
}
