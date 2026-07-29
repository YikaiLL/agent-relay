// Whether a stored file-change patch can actually be rolled back / reapplied.
//
// Undo/Reapply pipes the stored diff straight to `git apply` with no header repair
// (see apply_unified_diff), and git requires the path inside the header to be
// repo-relative. An absolute one — `diff --git a//Users/...` — is refused outright as
// `invalid path`, so the control can only ever fail.
//
// Claude's worker used to render the tool's `file_path` (always absolute) into the
// header; it now writes a repo-relative one. So the question is no longer "which
// provider" but "what shape is THIS patch": current threads apply fine, and only diffs
// stored before that fix carry an absolute header, which lets old sessions degrade on
// their own without a migration.
//
// A file the agent edited OUTSIDE the session cwd (working in a linked worktree) also
// keeps an absolute header, because no relative form is valid there — undoing those
// has to run git in the worktree that owns the file, which is separate work.
const ABSOLUTE_HEADER = /^(?:diff --git a|---\s+a|\+\+\+\s+b)\/{2}/m;

function headerLooksAbsolute(diff) {
  return typeof diff === "string" && diff !== "" && ABSOLUTE_HEADER.test(diff);
}

export function canApplyPatch(tool) {
  if (!tool) return true;
  // The relay's verdict, computed while the diff was still present. Authoritative:
  // every snapshot drops diff bodies, so in the normal collapsed view there is nothing
  // here to inspect and guessing from an empty string would always say "fine".
  if (typeof tool.can_apply === "boolean") return tool.can_apply;
  if (headerLooksAbsolute(tool.diff)) return false;
  const changes = Array.isArray(tool.file_changes) ? tool.file_changes : [];
  if (changes.some((change) => headerLooksAbsolute(change?.diff))) return false;
  // Nothing to inspect — a stripped diff body on a large transcript, or a summary that
  // never carried one. Do not hide a control that probably works: the relay still
  // rejects a bad patch with a visible error, which beats silently removing it.
  return true;
}
