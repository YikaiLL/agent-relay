// Browser-local persistence for per-project tab workspaces (which sessions are
// open, their order, which are pinned, which is focused).
//
// This is the interim adapter for createTabWorkspaceStore. A server-persisted,
// cross-device version is the intended follow-up — the store takes persistence as
// an injected adapter precisely so that swap needs no UI change. Note the two
// halves may well want different homes: `pinned` is a preference worth syncing
// across devices, while the open set and focus are per-device working state (a tab
// you opened on your phone appearing on your desktop would be surprising).
//
// Fails soft, like project-overview-prefs.js: storage being unavailable, full, or
// corrupt degrades to "no saved workspace" and never throws.

const KEY_PREFIX = "sealwire:tab-workspace:";

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function sanitizeLayout(layout) {
  if (!layout || typeof layout !== "object") {
    return null;
  }
  if (layout.type === "leaf") {
    return typeof layout.threadId === "string" && layout.threadId
      ? { type: "leaf", threadId: layout.threadId }
      : null;
  }
  if (layout.type === "split") {
    const children = (Array.isArray(layout.children) ? layout.children : [])
      .map(sanitizeLayout)
      .filter(Boolean);
    if (!children.length) {
      return null;
    }
    return {
      type: "split",
      dir: layout.dir === "v" ? "v" : "h",
      children,
      sizes: Array.isArray(layout.sizes) ? layout.sizes.map(Number).filter(Number.isFinite) : null,
    };
  }
  return null;
}

// Only the shape createTabWorkspace understands survives a read; anything else is
// dropped rather than trusted, so a hand-edited or stale entry can't inject
// unexpected nodes into the layout tree.
function sanitizeWorkspace(parsed) {
  const tabs = (Array.isArray(parsed?.tabs) ? parsed.tabs : [])
    .map((tab) => {
      const layout = sanitizeLayout(tab?.layout);
      return layout && typeof tab?.id === "string" && tab.id
        ? { id: tab.id, pinned: Boolean(tab.pinned), layout }
        : null;
    })
    .filter(Boolean);

  return {
    tabs,
    focusedTabId: typeof parsed?.focusedTabId === "string" ? parsed.focusedTabId : null,
  };
}

export function loadTabWorkspace(key) {
  const store = storage();
  if (!store || !key) {
    return null;
  }
  try {
    const raw = store.getItem(`${KEY_PREFIX}${key}`);
    if (!raw) {
      return null;
    }
    return sanitizeWorkspace(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveTabWorkspace(key, workspace) {
  const store = storage();
  if (!store || !key) {
    return;
  }
  try {
    store.setItem(`${KEY_PREFIX}${key}`, JSON.stringify(sanitizeWorkspace(workspace)));
  } catch {
    // Quota or private-mode failures are non-fatal — the in-memory workspace stands.
  }
}

/** The adapter shape createTabWorkspaceStore expects. */
export const browserTabWorkspacePersistence = {
  load: loadTabWorkspace,
  save: saveTabWorkspace,
};
