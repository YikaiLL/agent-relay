export function selectRemoteHeaderProjectSwitcherModel({
  activeProjectId = null,
  headerModel = null,
  projects = [],
  projectsError = null,
  projectsLoaded = false,
} = {}) {
  const activeProject = activeProjectId
    ? projects.find((project) => project.id === activeProjectId) || null
    : null;
  const activeProjectName = activeProject ? activeProject.name || activeProject.id : "";
  const projectLookupPending = Boolean(
    activeProjectId && !activeProject && !projectsLoaded && !projectsError
  );

  return {
    label: activeProjectName || (projectLookupPending ? headerModel?.title || "" : ""),
    labelTooltip: activeProjectName || headerModel?.titleTitle || headerModel?.title || "",
  };
}
