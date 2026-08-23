// Display-only helpers for the workspace chip in the launch dialogs.
//
// Strictly presentational: the path the dialog SUBMITS is always the raw value
// the user chose. Abbreviating what gets sent would hand the relay a `~` it has
// no obligation to expand, and `normalize_cwd` works on real paths.

// `/Users/luchi/git/x` → `~/git/x`.
//
// The frontend is never told the home directory — no snapshot field carries it —
// so this matches the two conventional layouts by shape instead. That is a
// display guess, which is exactly why it may not touch the submitted value: a
// wrong guess costs a slightly odd label and nothing else.
const HOME_PATTERN = /^\/(?:Users|home)\/[^/]+(?=\/|$)/;

export function abbreviateHomePath(path) {
  const raw = typeof path === "string" ? path : "";
  if (!raw) {
    return "";
  }
  // The lookahead in the pattern is what stops `/Usersomething/x` matching:
  // without it, a `startsWith("/Users/")`-shaped test turns a real directory
  // into a plausible-looking wrong one.
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
  // `detached` is deliberately distinct from a missing branch: `rev-parse
  // --abbrev-ref HEAD` reports a detached checkout as the literal string "HEAD",
  // and showing that as a branch name is worse than saying nothing.
  const where = context.branch || (context.detached ? "detached" : null);
  const state = context.dirty ? "changes" : "clean";
  return where ? `${where} · ${state}` : state;
}
