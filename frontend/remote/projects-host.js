// Remote Projects host: a single shared projects store (fed by the `fetch_projects`
// broker action), a React subscription hook, and the snapshot-revision / reset hooks —
// the remote analog of app.js's projectsStore wiring + workspace-diff-host.js.
import React from "react";
import { createProjectsStore } from "../shared/projects-store.js";
import { fetchRemoteProjects } from "./project-actions.js";

let sharedStore = null;

export function getRemoteProjectsStore() {
  if (!sharedStore) {
    sharedStore = createProjectsStore({
      fetchProjects: async () => {
        const data = await fetchRemoteProjects();
        if (!data) {
          throw new Error("projects missing in remote response");
        }
        return data;
      },
    });
  }
  return sharedStore;
}

// Observe the snapshot's projects_revision (mirrors app.js's syncToRevision hook).
// Fetches on first observation (any value) and whenever the revision changes.
export function notifyRemoteProjects(session) {
  if (!session) return;
  getRemoteProjectsStore().syncToRevision(session.projects_revision || 0);
}

// Force a refetch (e.g. right after a local mutation whose receipt the broker drops).
export function refreshRemoteProjects() {
  getRemoteProjectsStore().refresh();
}

// Forget fetched state when the relay/channel identity changes: an equal revision
// advertised by a DIFFERENT relay must not be mistaken for already-applied state.
export function resetRemoteProjectsStore() {
  sharedStore?.reset();
}

// React hook: subscribe so the sidebar re-renders as the payload loads/errors. The
// store returns a stable state reference between transitions, safe for
// useSyncExternalStore.
export function useRemoteProjects() {
  const store = getRemoteProjectsStore();
  return React.useSyncExternalStore(store.subscribe, store.getState);
}
