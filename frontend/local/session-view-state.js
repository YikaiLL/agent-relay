// Pure state machine for the local surface's visible session + scoped tab sets.
//
// `location` is the single canonical answer to "what is on screen":
//   - Sessions home:        { context: { kind: "sessions" }, threadId: null }
//   - Project overview:     { context: { kind: "project", projectId }, threadId: null }
//   - A visible session:    { context, threadId }
//
// A workspace's `focusedTabId` is only its REMEMBERED focus. It becomes visible when
// SWITCH_CONTEXT restores it; SHOW_OVERVIEW can deliberately show no thread while
// preserving that memory. This distinction removes the old competition between
// `state.viewThreadId` and `workspace.focusedTabId`.
//
// This module deliberately knows nothing about DOM, React, History, transcript loading,
// or persistence. The future controller will turn browser/backend events into commands,
// commit one transition, then perform those effects.

import {
  closeTab,
  createTabWorkspace,
  findTab,
  findTabByThread,
  focusedTab,
  layoutHasThread,
  layoutThreadIds,
  moveTab,
  openThreadTab,
  retargetThread,
  setTabPinned,
} from "../shared/tab-layout.js";
import { NO_PROJECT_KEY, SESSIONS_KEY } from "../shared/tab-workspace-store.js";

const HISTORY_VERSION = 1;

function stringId(value) {
  return typeof value === "string" && value ? value : null;
}

function stringSet(values) {
  return new Set(
    (values instanceof Set ? [...values] : Array.isArray(values) ? values : [])
      .map(stringId)
      .filter(Boolean)
  );
}

export function normalizeSessionViewContext(context) {
  if (context?.kind === "project") {
    const projectId = stringId(context.projectId);
    return projectId ? { kind: "project", projectId } : { kind: "projects-home" };
  }
  if (context?.kind === "projects-home") {
    return { kind: "projects-home" };
  }
  return { kind: "sessions" };
}

export function sessionViewContextKey(context) {
  const normalized = normalizeSessionViewContext(context);
  if (normalized.kind === "sessions") {
    return SESSIONS_KEY;
  }
  if (normalized.kind === "projects-home") {
    return NO_PROJECT_KEY;
  }
  return normalized.projectId;
}

function sameContext(left, right) {
  return sessionViewContextKey(left) === sessionViewContextKey(right);
}

function normalizeWorkspaces(workspaces) {
  return Object.fromEntries(
    Object.entries(workspaces || {}).map(([key, workspace]) => [
      key,
      createTabWorkspace(workspace),
    ])
  );
}

function workspaceFor(state, context) {
  return createTabWorkspace(state.workspaces[sessionViewContextKey(context)] || {});
}

function withWorkspace(state, context, workspace) {
  const key = sessionViewContextKey(context);
  return {
    ...state,
    workspaces: {
      ...state.workspaces,
      [key]: createTabWorkspace(workspace),
    },
  };
}

function focusedThreadId(workspace) {
  const tab = focusedTab(workspace);
  return tab ? layoutThreadIds(tab.layout)[0] || null : null;
}

/**
 * Normalize/repair an arbitrary snapshot.
 *
 * A routed thread is always opened and focused in its exact context. This is the core
 * invariant consumers previously had to re-establish independently after boot,
 * popstate, mode switches, deletion, and promotion.
 */
export function createSessionViewState(initial = {}) {
  const context = normalizeSessionViewContext(initial.location?.context);
  const threadId = stringId(initial.location?.threadId);
  let state = {
    location: { context, threadId },
    workspaces: normalizeWorkspaces(initial.workspaces),
  };

  const current = workspaceFor(state, context);
  state = withWorkspace(
    state,
    context,
    threadId ? openThreadTab(current, threadId) : current
  );
  return state;
}

function removeThread(state, threadId) {
  const target = stringId(threadId);
  if (!target) {
    return state;
  }

  const workspaces = Object.fromEntries(
    Object.entries(state.workspaces).map(([key, workspace]) => {
      const normalized = createTabWorkspace(workspace);
      const owning = findTabByThread(normalized, target);
      return [key, owning ? closeTab(normalized, owning.id) : normalized];
    })
  );

  let location = state.location;
  if (location.threadId === target) {
    location = {
      context: location.context,
      threadId: focusedThreadId(
        createTabWorkspace(workspaces[sessionViewContextKey(location.context)] || {})
      ),
    };
  }
  return createSessionViewState({ location, workspaces });
}

function sweepUnavailableThreads(state, unavailableThreadIds) {
  let next = state;
  for (const threadId of stringSet(unavailableThreadIds)) {
    next = removeThread(next, threadId);
  }
  return next;
}

function contextFromHistory(entry, currentContext, projectIds) {
  const knownProjects = stringSet(projectIds);

  // Versioned entries store context only. The URL remains the canonical/shareable
  // carrier for the thread id, so it cannot disagree with a duplicate history field.
  if (entry?.version === HISTORY_VERSION && entry.context) {
    const context = normalizeSessionViewContext(entry.context);
    if (context.kind === "project" && !knownProjects.has(context.projectId)) {
      return { kind: "projects-home" };
    }
    return context;
  }

  // Compatibility with entries written before the state machine lands.
  if (entry?.viewMode === "sessions") {
    return { kind: "sessions" };
  }
  if (entry?.viewMode === "projects") {
    const projectId = stringId(entry.projectId);
    return projectId && knownProjects.has(projectId)
      ? { kind: "project", projectId }
      : { kind: "projects-home" };
  }

  // Legacy `{}` / null / external links carry no context. Keep the context already
  // selected by the surface; initial boot supplies Sessions as that safe default.
  return normalizeSessionViewContext(currentContext);
}

/**
 * Apply one navigation-domain command.
 *
 * Facts are authoritative external knowledge captured by the controller for this
 * transition:
 *   - `projectIds`: projects that may be restored from untrusted history
 *   - `unavailableThreadIds`: archived/deleted threads that may not be opened
 */
export function reduceSessionView(snapshot, action = {}, facts = {}) {
  let state = sweepUnavailableThreads(
    createSessionViewState(snapshot),
    facts.unavailableThreadIds
  );

  switch (action.type) {
    case "OPEN_THREAD": {
      const threadId = stringId(action.threadId);
      if (!threadId) {
        return state;
      }
      if (stringSet(facts.unavailableThreadIds).has(threadId)) {
        return removeThread(state, threadId);
      }
      const context = action.context
        ? normalizeSessionViewContext(action.context)
        : state.location.context;
      const opened = openThreadTab(workspaceFor(state, context), threadId);
      return createSessionViewState({
        location: { context, threadId },
        workspaces: withWorkspace(state, context, opened).workspaces,
      });
    }

    case "SWITCH_CONTEXT": {
      const context = normalizeSessionViewContext(action.context);
      return createSessionViewState({
        location: {
          context,
          threadId: focusedThreadId(workspaceFor(state, context)),
        },
        workspaces: state.workspaces,
      });
    }

    case "SHOW_OVERVIEW": {
      const context = action.context
        ? normalizeSessionViewContext(action.context)
        : state.location.context;
      return createSessionViewState({
        location: { context, threadId: null },
        workspaces: state.workspaces,
      });
    }

    case "CLOSE_TAB": {
      const tabId = stringId(action.tabId);
      if (!tabId) {
        return state;
      }
      const context = action.context
        ? normalizeSessionViewContext(action.context)
        : state.location.context;
      const current = workspaceFor(state, context);
      const closing = findTab(current, tabId);
      const closesVisibleThread = Boolean(
        closing
        && sameContext(context, state.location.context)
        && state.location.threadId
        && layoutHasThread(closing.layout, state.location.threadId)
      );
      const closed = closeTab(current, tabId);
      const next = withWorkspace(state, context, closed);
      return createSessionViewState({
        location: closesVisibleThread
          ? { context: state.location.context, threadId: focusedThreadId(closed) }
          : state.location,
        workspaces: next.workspaces,
      });
    }

    case "PIN_TAB": {
      const tabId = stringId(action.tabId);
      if (!tabId) {
        return state;
      }
      const context = action.context
        ? normalizeSessionViewContext(action.context)
        : state.location.context;
      const next = withWorkspace(
        state,
        context,
        setTabPinned(workspaceFor(state, context), tabId, action.pinned)
      );
      return createSessionViewState({
        location: state.location,
        workspaces: next.workspaces,
      });
    }

    case "MOVE_TAB": {
      const tabId = stringId(action.tabId);
      if (!tabId) {
        return state;
      }
      const context = action.context
        ? normalizeSessionViewContext(action.context)
        : state.location.context;
      const next = withWorkspace(
        state,
        context,
        moveTab(workspaceFor(state, context), tabId, action.toIndex)
      );
      return createSessionViewState({
        location: state.location,
        workspaces: next.workspaces,
      });
    }

    case "REMOVE_THREAD":
      return removeThread(state, action.threadId);

    case "RETARGET_THREAD": {
      const fromThreadId = stringId(action.fromThreadId);
      const toThreadId = stringId(action.toThreadId);
      if (!fromThreadId || !toThreadId || fromThreadId === toThreadId) {
        return state;
      }
      if (stringSet(facts.unavailableThreadIds).has(toThreadId)) {
        return removeThread(removeThread(state, fromThreadId), toThreadId);
      }

      const workspaces = Object.fromEntries(
        Object.entries(state.workspaces).map(([key, workspace]) => [
          key,
          retargetThread(workspace, fromThreadId, toThreadId),
        ])
      );
      return createSessionViewState({
        location: {
          context: state.location.context,
          threadId:
            state.location.threadId === fromThreadId
              ? toThreadId
              : state.location.threadId,
        },
        workspaces,
      });
    }

    case "RESTORE_HISTORY": {
      const context = contextFromHistory(
        action.entry,
        state.location.context,
        facts.projectIds
      );
      const urlThreadId = stringId(action.urlThreadId);
      const unavailable = stringSet(facts.unavailableThreadIds);
      if (!urlThreadId || unavailable.has(urlThreadId)) {
        return createSessionViewState({
          location: {
            context,
            threadId: urlThreadId
              ? focusedThreadId(workspaceFor(state, context))
              : null,
          },
          workspaces: state.workspaces,
        });
      }

      const opened = openThreadTab(workspaceFor(state, context), urlThreadId);
      return createSessionViewState({
        location: { context, threadId: urlThreadId },
        workspaces: withWorkspace(state, context, opened).workspaces,
      });
    }

    default:
      return state;
  }
}

/** Browser history stores context only; `?thread=` remains the thread route. */
export function sessionViewHistoryEntry(state) {
  return {
    version: HISTORY_VERSION,
    context: normalizeSessionViewContext(state?.location?.context),
  };
}

/**
 * Runtime/test diagnostic. A valid visible thread belongs to exactly the tab that the
 * current context remembers as focused. An overview/home may retain remembered focus
 * while routing no thread.
 */
export function sessionViewInvariantErrors(snapshot) {
  const errors = [];
  const context = normalizeSessionViewContext(snapshot?.location?.context);
  const threadId = stringId(snapshot?.location?.threadId);
  const workspaces = normalizeWorkspaces(snapshot?.workspaces);
  const current = createTabWorkspace(
    workspaces[sessionViewContextKey(context)] || {}
  );

  if (threadId) {
    const owning = findTabByThread(current, threadId);
    if (!owning) {
      errors.push(`visible thread ${threadId} is not open in ${sessionViewContextKey(context)}`);
    } else if (current.focusedTabId !== owning.id) {
      errors.push(
        `visible thread ${threadId} is not the remembered focus in ${sessionViewContextKey(context)}`
      );
    }
  }

  for (const [key, workspace] of Object.entries(workspaces)) {
    const normalized = createTabWorkspace(workspace);
    if (normalized.focusedTabId && !findTab(normalized, normalized.focusedTabId)) {
      errors.push(`workspace ${key} focuses a missing tab`);
    }
  }
  return errors;
}
