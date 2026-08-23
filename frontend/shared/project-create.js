import { pickNewProjectId } from "./project-menu.js";

/**
 * Create a project and select it in the dialog that asked for it.
 *
 * Everything is injected so this stays free of any transport: the local surface
 * has a receipt to diff against, the remote one has to refetch because the broker
 * acks `project_action` without its receipt.
 */
export async function createProjectAndSelect({ apply, create, isCurrent = null, name, store }) {
  const before = store.getState().projects || [];
  await create(name);
  // Awaited, so the picker can resolve the id the moment it is applied; setting it
  // against a stale list makes the chip read "Default Workspace" for a beat.
  await store.refresh();
  // Null unless EXACTLY one id appeared: a concurrent create on another device
  // otherwise resolves to whichever sorts first by name.
  const projectId = pickNewProjectId(before, store.getState().projects || []);
  if (!projectId) {
    return null;
  }
  // The dialog can be closed, or reopened on another thread, while this is in
  // flight; a late answer must not file a draft it was never about.
  if (isCurrent && !isCurrent()) {
    return null;
  }
  apply(projectId);
  return projectId;
}
