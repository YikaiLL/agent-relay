function workspaceBasename(cwd) {
  if (!cwd) {
    return "workspace";
  }

  const trimmed = String(cwd).replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || trimmed || "workspace";
}

export function canonicalizeWorkspace(cwd) {
  return String(cwd || "").trim().replace(/[\\/]+$/, "");
}

export const UNKNOWN_WORKSPACE_CWD = "__unknown_workspace__";
export const UNKNOWN_WORKSPACE_LABEL = "Unknown workspace";

// `UNKNOWN_WORKSPACE_CWD` is a DISPLAY grouping key, not a directory. It must
// never flow into a cwd operation: the local group header is clickable and its
// handler writes the value straight into the workspace input, so an unguarded
// sentinel would be sent to the relay as a path when starting a session.
export function isUnknownWorkspace(cwd) {
  return cwd === UNKNOWN_WORKSPACE_CWD;
}

export const UNASSIGNED_PROJECT_KEY = "__unassigned__";
export const UNASSIGNED_PROJECT_LABEL = "Unassigned";

// Like UNKNOWN_WORKSPACE_CWD, the "Unassigned" bucket key is a DISPLAY grouping
// sentinel, not a real project id: it must never be sent to an assign/unassign
// action as a project_id. Null `project_id` membership collapses to this ONE
// bucket (never split by cwd).
export function isUnassignedProject(key) {
  return key === UNASSIGNED_PROJECT_KEY;
}

// Navigation policy, shared by every surface that renders the thread list.
//
// A thread whose cwd could not be recovered must still be REACHABLE. cwd
// recovery is best-effort at both layers (the relay's runtime/cache memory, and
// the worker's local-JSONL scan), so an empty cwd is always possible: the
// session file may be gone, the id may not match the scan pattern, or the relay
// may have restarted. Dropping those rows made a real forked session vanish
// from the sidebar with no error while it existed on disk and in the relay —
// and, because the local refresh writes the grouped result back to
// `state.threads`, it also became unforkable and unopenable.
//
// This exists as a function rather than an option each caller remembers to
// pass: local surfaces did not pass it while remote did, so the same thread was
// visible on the phone and gone on the desktop.
export function buildNavigationThreadGroups(threads, options = {}) {
  return buildThreadGroups(threads, { includeUnknownWorkspace: true, ...options });
}

// Every group carries a neutral `key` (canonical cwd in cwd mode, project id or the
// "__unassigned__" sentinel in project mode) so downstream collapse/row state can be
// keyed uniformly regardless of grouping mode.
export function buildThreadGroups(threads, options = {}) {
  if (options.groupBy === "project") {
    return buildProjectGroups(threads, options);
  }
  return buildCwdGroups(threads, options);
}

function buildCwdGroups(threads, options) {
  const includeUnknownWorkspace = options.includeUnknownWorkspace === true;
  const groups = new Map();

  for (const thread of threads || []) {
    const knownCwd = canonicalizeWorkspace(thread.cwd);
    const cwd = knownCwd || (includeUnknownWorkspace ? UNKNOWN_WORKSPACE_CWD : "");
    if (!cwd) {
      continue;
    }

    if (!groups.has(cwd)) {
      groups.set(cwd, {
        key: cwd,
        cwd,
        label: knownCwd ? workspaceBasename(cwd) : UNKNOWN_WORKSPACE_LABEL,
        latestUpdatedAt: 0,
        threads: [],
      });
    }

    const group = groups.get(cwd);
    group.threads.push(thread);
    group.latestUpdatedAt = Math.max(group.latestUpdatedAt, Number(thread.updated_at) || 0);
  }

  return sortThreadGroups([...groups.values()]);
}

// Group by Project (thread_project_id membership). Every known project seeds a
// group so an empty project stays visible/navigable; a thread with no project — or
// an ORPHANED membership whose project was deleted — collapses into ONE
// "__unassigned__" bucket (never split by cwd).
function buildProjectGroups(threads, options) {
  const threadProjectId = options.threadProjectId || {};
  const projectsById = new Map((options.projects || []).map((project) => [project.id, project]));
  const groups = new Map();

  const ensureGroup = (key, label, projectId) => {
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        cwd: "",
        projectId: projectId ?? null,
        label,
        latestUpdatedAt: 0,
        threads: [],
      });
    }
    return groups.get(key);
  };

  for (const project of options.projects || []) {
    ensureGroup(project.id, project.name || project.id, project.id);
  }

  for (const thread of threads || []) {
    const rawId = threadProjectId[thread.id] || null;
    const project = rawId ? projectsById.get(rawId) : null;
    const group = project
      ? ensureGroup(project.id, project.name || project.id, project.id)
      : ensureGroup(UNASSIGNED_PROJECT_KEY, UNASSIGNED_PROJECT_LABEL, null);
    group.threads.push(thread);
    group.latestUpdatedAt = Math.max(group.latestUpdatedAt, Number(thread.updated_at) || 0);
  }

  return sortThreadGroups([...groups.values()]);
}

function sortThreadGroups(groups) {
  return groups
    .map((group) => ({
      ...group,
      threads: [...group.threads].sort((left, right) => (right.updated_at || 0) - (left.updated_at || 0)),
    }))
    .sort((left, right) => {
      if (right.latestUpdatedAt !== left.latestUpdatedAt) {
        return right.latestUpdatedAt - left.latestUpdatedAt;
      }

      return left.label.localeCompare(right.label);
    });
}

export function findLatestThread(threads, preferredCwd) {
  if (!threads?.length) {
    return null;
  }

  const normalizedCwd = canonicalizeWorkspace(preferredCwd);
  if (!normalizedCwd) {
    return threads[0] || null;
  }

  return (
    threads.find((thread) => canonicalizeWorkspace(thread.cwd) === normalizedCwd) || null
  );
}

export function summarizeThreadGroups(groups, options = {}) {
  const safeGroups = groups || [];
  const totalThreads = safeGroups.reduce((count, group) => count + (group.threads?.length || 0), 0);

  if (totalThreads === 0 && safeGroups.length === 0) {
    return "No saved sessions yet.";
  }

  const sessions = `${totalThreads} ${totalThreads === 1 ? "session" : "sessions"}`;

  if (options.groupBy === "project") {
    // The "__unassigned__" bucket is NOT a project — count only real projects.
    const projectCount = safeGroups.filter((group) => group.projectId).length;
    return `${projectCount} ${projectCount === 1 ? "project" : "projects"} · ${sessions}`;
  }

  return `${safeGroups.length} ${safeGroups.length === 1 ? "folder" : "folders"} · ${sessions}`;
}
