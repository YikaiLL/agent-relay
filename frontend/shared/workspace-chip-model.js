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
