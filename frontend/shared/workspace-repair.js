// "This thread's workspace is gone" — the button's own state, and how to read the
// relay's verdict.
//
// The VERDICT itself is not kept here: it rides `snapshot.workspace_missing`, which the
// relay decides on the async paths that were going to touch the workspace anyway (open,
// resume, send, repair) and caches on the thread's runtime. Two things follow from that,
// and both used to be wrong here: no surface has to go fetch the verdict, and no surface
// has to remember it — every render already has it.
//
// What IS kept per thread is the button's state (in flight, last failure), keyed by
// thread id rather than "the thread on screen": a repair can settle after the user has
// moved on, and branding the wrong thread's composer as broken would be a worse bug than
// the one this fixes.
//
// Pure by design — no surface imports, no module-load side effects. Callers pass their
// state object in and own the re-render. What is NOT here is transport (local POSTs the
// repair, remote dispatches a broker action) and copy (a phone banner is one line), which
// is the only thing the two surfaces genuinely disagree about.

const EMPTY = Object.freeze({ error: "", pending: false });

function entry(state, threadId) {
  if (!state.workspaceRepairByThread) {
    state.workspaceRepairByThread = new Map();
  }
  let record = state.workspaceRepairByThread.get(threadId);
  if (!record) {
    record = { error: "", pending: false };
    state.workspaceRepairByThread.set(threadId, record);
  }
  return record;
}

/** The repair BUTTON's state for one thread. Always a record; never null, never a write. */
export function readWorkspaceRepair(state, threadId) {
  if (!state || !threadId) {
    return EMPTY;
  }
  return state.workspaceRepairByThread?.get(threadId) || EMPTY;
}

export function setWorkspaceRepairPending(state, threadId, pending) {
  if (!state || !threadId) {
    return;
  }
  const record = entry(state, threadId);
  record.pending = Boolean(pending);
  if (record.pending) {
    // A new attempt supersedes the previous failure — leaving it up would read as if this
    // attempt had already failed.
    record.error = "";
  }
}

export function setWorkspaceRepairError(state, threadId, message) {
  if (!state || !threadId) {
    return;
  }
  const record = entry(state, threadId);
  record.pending = false;
  record.error = message ? String(message) : "";
}

/**
 * The repair settled. Only the button's state is cleared — the banner itself goes away
 * because the snapshot the relay hands back carries `workspace_missing: null`, which is
 * the relay's own confirmation rather than this surface's guess.
 */
export function workspaceRepairResolved(state, threadId) {
  if (!state || !threadId) {
    return;
  }
  const record = entry(state, threadId);
  record.error = "";
  record.pending = false;
}

/**
 * Normalize `thread_state.workspace_missing` (`WorkspaceRepairView` in
 * crates/relay-server/src/protocol.rs). Non-null means the thread's recorded cwd is not a
 * directory right now; `null` means nothing is wrong.
 *
 * A payload with no path is treated as no problem at all: without a directory to name,
 * the banner would be exactly the generic "something went wrong" this change exists to
 * delete.
 */
export function normalizeWorkspaceRepairPlan(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const recordedCwd = typeof raw.recorded_cwd === "string" ? raw.recorded_cwd.trim() : "";
  if (!recordedCwd) {
    return null;
  }
  const branch = typeof raw.branch === "string" ? raw.branch.trim() : "";
  // Only the relay can re-create a worktree, and it says so by sending both
  // `kind: "worktree"` and the branch. Anything else — an unknown kind, a worktree slot
  // whose repository is gone — falls back to the folder offer, which is the one repair
  // that is always available.
  const isWorktree = raw.kind === "worktree" && Boolean(branch);
  return {
    branch: isWorktree ? branch : "",
    kind: isWorktree ? "worktree" : "folder",
    recordedCwd,
    repoRoot: typeof raw.repo_root === "string" ? raw.repo_root : "",
  };
}
