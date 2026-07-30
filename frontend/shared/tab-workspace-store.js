import { createStore } from "zustand/vanilla";

import {
  closeTab,
  createTabWorkspace,
  findTabByThread,
  focusTab,
  moveTab,
  openThreadTab,
  sameWorkspace,
  setTabPinned,
} from "./tab-layout.js";

// Tab workspaces are scoped per project: switching project switches the whole set
// of open tabs. Sessions mode has no project, so it gets its own bucket rather
// than being left without tabs.
export const NO_PROJECT_KEY = "__no_project__";

export function tabWorkspaceKey(projectId) {
  return projectId || NO_PROJECT_KEY;
}

/**
 * Per-project tab workspaces, with persistence behind an injectable adapter:
 *
 *   persistence = { load(key) -> workspace|null, save(key, workspace) -> void }
 *
 * The adapter seam is deliberate. Today it's browser-local (see
 * tab-workspace-prefs.js); the intended follow-up is server-persisted, and that
 * swap must not touch the store's callers or the UI. `load` is called at most once
 * per key, so a slow or failing adapter can't stall repeated reads.
 */
export function createTabWorkspaceStore({ persistence = null } = {}) {
  const loaded = new Set();

  const read = (state, key) => state.workspaces[key] || null;

  return createStore((set, get) => ({
    workspaces: {},

    /**
     * The workspace for a key, hydrating it from persistence the first time. Always
     * returns a valid workspace, so callers never branch on "not loaded yet" —
     * createTabWorkspace repairs anything the adapter hands back (dangling focus,
     * lost pinned-first order, idless tabs).
     */
    ensureWorkspace(projectId) {
      const key = tabWorkspaceKey(projectId);
      const existing = read(get(), key);
      if (existing) {
        return existing;
      }

      let restored = null;
      if (!loaded.has(key)) {
        loaded.add(key);
        try {
          restored = persistence?.load?.(key) || null;
        } catch {
          // Persistence is best-effort: a corrupt or unavailable store degrades to
          // an empty workspace rather than breaking the surface.
          restored = null;
        }
      }

      const workspace = createTabWorkspace(restored || {});
      set((state) => ({ workspaces: { ...state.workspaces, [key]: workspace } }));
      return workspace;
    },

    /** Apply a pure tab-layout operation to one project's workspace. */
    update(projectId, operation) {
      const key = tabWorkspaceKey(projectId);
      const current = get().ensureWorkspace(projectId);
      const next = operation(current);
      // Structural, not reference: every tab-layout operation normalizes through
      // createTabWorkspace, so a no-op still returns a fresh object. Comparing by
      // reference here would re-render and re-write storage on every dead click.
      if (sameWorkspace(next, current)) {
        return current;
      }

      set((state) => ({ workspaces: { ...state.workspaces, [key]: next } }));
      try {
        persistence?.save?.(key, next);
      } catch {
        // A failed write must not lose the in-memory change.
      }
      return next;
    },

    openThread(projectId, threadId) {
      return get().update(projectId, (workspace) => openThreadTab(workspace, threadId));
    },
    closeTabId(projectId, tabId) {
      return get().update(projectId, (workspace) => closeTab(workspace, tabId));
    },
    focusTabId(projectId, tabId) {
      return get().update(projectId, (workspace) => focusTab(workspace, tabId));
    },
    setPinned(projectId, tabId, pinned) {
      return get().update(projectId, (workspace) => setTabPinned(workspace, tabId, pinned));
    },
    moveTabId(projectId, tabId, toIndex) {
      return get().update(projectId, (workspace) => moveTab(workspace, tabId, toIndex));
    },

    /**
     * Drop a session from every workspace that has it open. Call this when a session
     * is deleted: a tab pointing at a thread that no longer exists is dead — it can't
     * be focused into anything, and it keeps a stale title in the strip.
     *
     * Sweeps all loaded workspaces rather than one project, because a thread's
     * project assignment can change while its tab is open.
     */
    closeThreadEverywhere(threadId) {
      if (!threadId) {
        return;
      }
      for (const key of Object.keys(get().workspaces)) {
        const workspace = get().workspaces[key];
        const owning = findTabByThread(workspace, threadId);
        if (owning) {
          get().update(key, (current) => closeTab(current, owning.id));
        }
      }
    },
  }));
}
