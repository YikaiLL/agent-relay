// Local-surface Projects transport: the write path (POST /api/projects with a
// `{ action, ... }` body) and the dedicated read path (GET /api/projects). Both go
// through `apiFetch`. The remote surface uses `dispatchOrRecover("project_action")` /
// `FetchProjects` instead (added with the remote Projects UI).

async function unwrap(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  }
  return payload.data;
}

/** POST a single Projects mutation; resolves to the ProjectActionReceipt. */
export async function postProjectAction(apiFetch, action) {
  const response = await apiFetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  return unwrap(response);
}

export const createProject = (apiFetch, name) =>
  postProjectAction(apiFetch, { action: "create", name });

export const renameProject = (apiFetch, projectId, name) =>
  postProjectAction(apiFetch, { action: "rename", project_id: projectId, name });

export const deleteProject = (apiFetch, projectId) =>
  postProjectAction(apiFetch, { action: "delete", project_id: projectId });

export const assignThreadToProject = (apiFetch, threadId, projectId) =>
  postProjectAction(apiFetch, {
    action: "assign",
    thread_id: threadId,
    project_id: projectId,
  });

export const unassignThread = (apiFetch, threadId) =>
  postProjectAction(apiFetch, { action: "unassign", thread_id: threadId });

/** GET the dedicated Projects payload ({ projects_revision, projects, thread_project_id }). */
export async function fetchProjectsPayload(apiFetch) {
  const response = await apiFetch("/api/projects", { method: "GET" });
  return unwrap(response);
}
