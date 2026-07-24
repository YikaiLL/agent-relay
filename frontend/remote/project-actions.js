// Remote-surface Projects transport. The read path is the dedicated `fetch_projects`
// broker action (mirrors `fetch_workspace_diff`/`fetch_reviews`); the write path is a
// single `project_action` broker action carrying a `{ input: { action, ... } }` body.
// The broker discards the write receipt, so callers refresh via the projects_revision
// snapshot bump (or an explicit fetchRemoteProjects) — same policy as reviews.
import { dispatchOrRecover } from "./actions.js";

/** GET the dedicated Projects payload ({ projects_revision, projects, thread_project_id }). */
export async function fetchRemoteProjects() {
  const result = await dispatchOrRecover("fetch_projects", {});
  return result?.projects;
}

/** POST one Projects mutation over the broker. */
export const dispatchRemoteProjectAction = (action) =>
  dispatchOrRecover("project_action", { input: action });

export const createRemoteProject = (name) =>
  dispatchRemoteProjectAction({ action: "create", name });

export const renameRemoteProject = (projectId, name) =>
  dispatchRemoteProjectAction({ action: "rename", project_id: projectId, name });

export const deleteRemoteProject = (projectId) =>
  dispatchRemoteProjectAction({ action: "delete", project_id: projectId });

export const assignRemoteThreadToProject = (threadId, projectId) =>
  dispatchRemoteProjectAction({ action: "assign", thread_id: threadId, project_id: projectId });

export const unassignRemoteThread = (threadId) =>
  dispatchRemoteProjectAction({ action: "unassign", thread_id: threadId });
