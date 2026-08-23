export function shortId(value) {
  return value ? value.slice(0, 8) : "unknown";
}

export function workspaceBasename(cwd) {
  if (!cwd) {
    return "workspace";
  }

  const trimmed = String(cwd).replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || trimmed || "workspace";
}

export function formatTimestamp(seconds) {
  if (!seconds) {
    return "unknown";
  }

  return new Date(seconds * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// `nowSeconds` is an optional clock injection, defaulting to the real one so
// every existing caller is unaffected. It exists so callers that are themselves
// pure — the project picker's row model — can be tested against a fixed instant
// instead of against whenever the suite happens to run.
export function formatRelativeTime(seconds, nowSeconds = null) {
  if (!seconds) {
    return "now";
  }

  // `nowSeconds == null` must be tested BEFORE coercing: Number(null) is 0, which
  // is finite, so a finiteness check alone pinned "now" to the epoch and made
  // every timestamp read as "now" (the diff went negative and clamped to zero).
  const injected = nowSeconds == null ? NaN : Number(nowSeconds);
  const now = Number.isFinite(injected) ? injected : Math.floor(Date.now() / 1000);
  const diffSeconds = Math.max(0, now - Number(seconds));
  if (diffSeconds < 60) {
    return "now";
  }
  if (diffSeconds < 3600) {
    return `${Math.floor(diffSeconds / 60)}m`;
  }
  if (diffSeconds < 86400) {
    return `${Math.floor(diffSeconds / 3600)}h`;
  }
  if (diffSeconds < 604800) {
    return `${Math.floor(diffSeconds / 86400)}d`;
  }
  if (diffSeconds < 2592000) {
    return `${Math.floor(diffSeconds / 604800)}w`;
  }
  if (diffSeconds < 31536000) {
    return `${Math.floor(diffSeconds / 2592000)}mo`;
  }
  return `${Math.floor(diffSeconds / 31536000)}y`;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
