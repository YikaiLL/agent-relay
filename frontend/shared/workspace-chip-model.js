// Presentational only: the SUBMITTED path is always the raw value, because
// `normalize_cwd` works on real paths and owes a `~` nothing.

// The frontend is never told the home directory, so this matches by shape — a
// display guess, which is why it may not touch the submitted value.
const HOME_PATTERN = /^\/(?:Users|home)\/[^/]+(?=\/|$)/;

export function abbreviateHomePath(path) {
  const raw = typeof path === "string" ? path : "";
  if (!raw) {
    return "";
  }
  // The lookahead stops `/Usersomething/x` becoming a plausible-looking wrong path.
  const match = raw.match(HOME_PATTERN);
  if (!match) {
    return raw;
  }
  const rest = raw.slice(match[0].length).replace(/\/+$/, "");
  return rest ? `~${rest}` : "~";
}

// The `main · clean` chip. Returns null when there is nothing worth saying, so
// the caller renders no chip at all rather than an empty one.
export function gitContextLabel(context) {
  if (!context?.is_repo) {
    return null;
  }
  // Distinct from a missing branch: git reports a detached checkout as "HEAD".
  const where = context.branch || (context.detached ? "detached" : null);
  const state = context.dirty ? "changes" : "clean";
  return where ? `${where} · ${state}` : state;
}

// Last path segment for notes that name a tree. Never returns "".
export function pathBasename(path) {
  const raw = typeof path === "string" ? path : "";
  return raw.split("/").filter(Boolean).pop() || raw;
}

// Branch first; the directory disambiguates two worktrees on the same branch.
export function workspaceRootLabel(root) {
  const name = pathBasename(root?.path || "");
  const branch = root?.branch || "detached";
  return root?.is_main ? `${branch} · ${name}` : `${branch} · ${name} (worktree)`;
}

/**
 * Why this tree is showing. `previewing` must say viewing is not a session move.
 * @returns {{tone: "warn"|"info", text: string, title: string}|null}
 */
export function workspaceOriginNote(workspace, fallbackFrom = null, options = null) {
  if (options?.previewing) {
    const cwd = workspace?.cwd || "";
    return {
      tone: "info",
      text: "Viewing this tree's changes — does not move the session.",
      title: cwd,
    };
  }
  const cwd = workspace?.cwd || "";
  const origin = workspace?.origin || null;
  const gone = (origin?.kind === "substituted" ? origin.gone : null) || fallbackFrom || null;
  if (gone) {
    return {
      tone: "warn",
      text: cwd
        ? `Worktree ${pathBasename(gone)} no longer exists — showing ${pathBasename(cwd)} instead.`
        : `Worktree ${pathBasename(gone)} no longer exists.`,
      title: cwd ? `${gone} → ${cwd}` : gone,
    };
  }
  // Birth can vanish while pin/writes still point somewhere real — not `substituted`.
  if (workspace && workspace.birth_cwd_exists === false) {
    const birth = workspace.birth_cwd || "";
    return {
      tone: "warn",
      text: `The directory this session started in (${abbreviateHomePath(birth)}) no longer exists.`,
      title: birth,
    };
  }
  switch (origin?.kind) {
    case "pinned":
      return {
        tone: "info",
        text: "Pinned by you — diffs and reviews use this tree until you unpin it.",
        title: cwd,
      };
    case "proven":
      return {
        tone: "info",
        text: "Detected from where this session has been writing.",
        title: cwd,
      };
    default:
      return null;
  }
}
