// Revision-keyed cache for full workflow cards on the dedicated Workflows channel.
export function createWorkflowsCache() {
  let syncedRevision = null;
  let inflightRevision = null;
  let loaded = false;
  let data = { workflow_runs: [] };

  return {
    current() {
      return data;
    },
    hasData() {
      return loaded;
    },
    async sync(snapshotRevision, fetchWorkflows, onUpdate) {
      if (snapshotRevision == null) return;
      if (syncedRevision === snapshotRevision || inflightRevision === snapshotRevision) return;
      inflightRevision = snapshotRevision;
      try {
        const response = await fetchWorkflows();
        if (inflightRevision !== snapshotRevision || response == null) return;
        syncedRevision = snapshotRevision;
        loaded = true;
        data = { workflow_runs: response.workflow_runs || [] };
        onUpdate?.();
      } catch (_error) {
        // Keep stale cards and retry on the next render of this revision.
      } finally {
        if (inflightRevision === snapshotRevision) inflightRevision = null;
      }
    },
  };
}
