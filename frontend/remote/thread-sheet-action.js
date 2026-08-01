// Executes one action picked from the per-session actions sheet.
//
// Split out of RemoteApp and taking its collaborators as arguments so the branching —
// especially "create a project and move the session into it" — is testable without a
// browser. That branch is the subtle one: local reads the new project's id straight off
// the create receipt, but the broker DISCARDS write receipts on this surface, so the id
// has to come from a refetch-and-diff instead.

import { pickNewProjectId } from "../shared/project-menu.js";

/**
 * @param {object} item      descriptor from buildThreadSheetSections
 * @param {string} threadId  the session the sheet was opened for
 * @param {Array}  projects  the projects known BEFORE the action (for the create diff)
 * @param {object} deps      { assign, unassign, create, fetchProjects, promptName,
 *                             openFork, refresh, log }
 */
export async function runThreadSheetAction({ item, threadId, projects = [], deps } = {}) {
  // A refused entry (running session, projects not loaded) is rendered disabled, but
  // never trust the view for that — the descriptor is the authority.
  if (!item || item.disabled || !threadId || !deps) return;
  const { assign, unassign, create, fetchProjects, promptName, openFork, refresh, log } = deps;
  try {
    if (item.kind === "fork") {
      openFork(threadId);
      return;
    }
    if (item.kind === "assign") {
      // Re-picking the project a session already lives in is a no-op, not a pointless
      // round trip that also churns the projects revision.
      if (item.isCurrent) return;
      await assign(threadId, item.projectId);
      log(`Moved session to "${item.label}".`);
    } else if (item.kind === "unassign") {
      await unassign(threadId);
      log("Removed session from its project.");
    } else if (item.kind === "create") {
      const name = promptName();
      if (!name) return;
      await create(name);
      // Diff ids rather than matching on name: two projects may share a name, and only
      // an id can be assigned. Must be the awaited fetch — the store's `refresh` is
      // fire-and-forget and resolves to undefined, which would leave every freshly
      // created project unassigned.
      const after = await fetchProjects();
      const createdId = pickNewProjectId(projects, after?.projects || []);
      if (!createdId) {
        // Created, but the id was ambiguous — leave the session where it is rather than
        // guess at membership. The refresh still surfaces the new (empty) project.
        log(`Created project "${name}" (move the session from its menu).`);
        refresh();
        return;
      }
      await assign(threadId, createdId);
      log(`Created project "${name}" and moved the session into it.`);
    } else {
      return;
    }
    refresh();
  } catch (error) {
    log(`Session action failed: ${error.message}`);
  }
}
