// Pure helpers for the local Projects CRUD affordances (the "+ New project" button
// and the per-session "assign to project" context-menu section). Side-effect free so
// they unit-test without a DOM; app.js renders buttons from these descriptors and
// wires the actual API calls.

/**
 * Ordered context-menu descriptors for one thread: an "unassign" action (only when
 * the thread is currently in a Project), one "assign" per Project (alphabetical,
 * marking the current one), and a trailing "create" (new Project + assign).
 */
export function buildProjectMenuItems({ projects, currentProjectId } = {}) {
  const current = currentProjectId || null;
  const items = [];
  if (current) {
    items.push({ kind: "unassign", label: "Remove from project" });
  }
  const sorted = (Array.isArray(projects) ? projects : [])
    .filter((project) => project && project.id)
    .slice()
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  for (const project of sorted) {
    items.push({
      kind: "assign",
      projectId: project.id,
      label: project.name || project.id,
      isCurrent: project.id === current,
    });
  }
  items.push({ kind: "create", label: "New project…" });
  return items;
}

/**
 * The id of the Project that appeared after a create action, by set-diffing the
 * before/after id sets. A diff (not find-by-name) so it stays correct even if two
 * Projects share a name. Returns null unless exactly one new id appeared.
 */
export function pickNewProjectId(beforeProjects, afterProjects) {
  const before = new Set(
    (Array.isArray(beforeProjects) ? beforeProjects : [])
      .map((project) => project && project.id)
      .filter(Boolean)
  );
  const fresh = (Array.isArray(afterProjects) ? afterProjects : [])
    .map((project) => project && project.id)
    .filter((id) => id && !before.has(id));
  return fresh.length === 1 ? fresh[0] : null;
}

/** Normalize a raw prompt value into a trimmed Project name, or null to abort. */
export function normalizeProjectName(raw) {
  if (raw == null) return null;
  const name = String(raw).trim();
  return name || null;
}

/**
 * Whether the Projects payload is fresh enough to present membership + mutation
 * controls. The context menu mirrors the sidebar's fail-closed rule: false while a
 * fetch is pending, after an error, or before the first successful load — so we never
 * expose stale/unknown assign/unassign controls or a wrong "current" marker.
 */
export function projectsMenuReady({ projectsLoaded, projectsError, projectsLoading } = {}) {
  return Boolean(projectsLoaded) && !projectsError && !projectsLoading;
}

/**
 * Whether a context-menu Project action may execute. The clicked button captured the
 * Projects-state sequence token when it was built; the action runs only if that token
 * still matches the current one (no transition since) AND the state is fresh. This is
 * the execution-time guard that stops a button built from now-stale Project state from
 * overwriting newer membership, even in the tiny window between click and handler.
 */
export function projectMenuActionAllowed({
  builtSeq,
  currentSeq,
  projectsLoaded,
  projectsError,
  projectsLoading,
} = {}) {
  return builtSeq === currentSeq && projectsMenuReady({ projectsLoaded, projectsError, projectsLoading });
}
