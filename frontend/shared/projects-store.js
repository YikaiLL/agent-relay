// Shared Projects store. The full Projects payload (list + membership) is fetched
// off the byte-budgeted snapshot via a dedicated channel; the snapshot only carries
// `projects_revision`. This store observes that revision and refetches only when it
// changes — with an unconditional FIRST fetch (so a fresh client / reconnect always
// loads current state, and a persisted nonzero revision on a restarted relay is
// honored). Surface-agnostic: pass a `fetchProjects()` that resolves to
// `{ projects_revision, projects, thread_project_id }`.
export function createProjectsStore({ fetchProjects }) {
  let state = {
    projects: [],
    threadProjectId: {},
    loading: false,
    error: null,
    // Whether a fetch has EVER succeeded. Lets consumers distinguish "not fetched
    // yet" (must not render empty projects as authoritative) from "fetched, empty".
    loaded: false,
  };
  const listeners = new Set();
  let appliedRevision = null; // sentinel: nothing fetched yet (forces the first fetch)
  let inFlightRevision = null;
  let requestSeq = 0;

  function emit() {
    listeners.forEach((listener) => {
      try {
        listener(state);
      } catch (error) {
        console.warn("projects-store listener failed", error);
      }
    });
  }

  function setState(patch) {
    state = { ...state, ...patch };
    emit();
  }

  async function fetchNow(targetRevision) {
    // Monotonic guard: only the latest fetch may write, so an earlier in-flight
    // request that resolves late can't overwrite newer data.
    const seq = (requestSeq += 1);
    inFlightRevision = targetRevision;
    // Do NOT clear `error` here. A retry after a failed fetch must keep the error
    // latched until a fetch actually SUCCEEDS — otherwise the brief `error === null`
    // window would let a consumer flash the prior (stale) grouping back in through its
    // error guard before the retry resolves. Success clears it; failure re-sets it.
    setState({ loading: true });
    try {
      const data = await fetchProjects();
      if (seq !== requestSeq) return; // superseded by a newer fetch
      if (!data || !Array.isArray(data.projects)) {
        // A null/malformed payload must NOT latch empty Projects as "applied": that
        // would hide real projects and, because the revision would be marked applied,
        // never retry. Treat it as a failure so `appliedRevision` is left unchanged.
        throw new Error("malformed projects payload");
      }
      setState({
        projects: data.projects,
        threadProjectId: data.thread_project_id || {},
        loading: false,
        error: null,
        loaded: true,
      });
      // Latch the RESPONSE's revision (authoritative), not the triggering one — the
      // relay may have advanced between the snapshot and the fetch resolving.
      appliedRevision = Number.isFinite(data.projects_revision)
        ? data.projects_revision
        : targetRevision;
    } catch (error) {
      if (seq !== requestSeq) return;
      setState({ loading: false, error: error?.message || String(error) });
    } finally {
      // Only the LATEST fetch may clear the in-flight marker. Guarding on the revision
      // alone is buggy when two relays share a revision: a superseded fetch (same
      // targetRevision) would clear the replacement's marker, letting the next
      // same-revision snapshot launch a THIRD fetch and supersede the replacement —
      // amplifying requests / keeping Projects fail-closed. The generation check makes
      // a stale fetch a no-op here.
      if (seq === requestSeq) {
        inFlightRevision = null;
      }
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Observe the snapshot's `projects_revision`. Fetches on first observation (any
    // value, incl. 0 → unconditional initial fetch) and whenever it changes;
    // a no-op when already applied or already fetching that revision.
    syncToRevision(revision) {
      const rev = Number(revision) || 0;
      if (rev === appliedRevision || rev === inFlightRevision) return;
      void fetchNow(rev);
    },
    // Force a refetch (e.g. right after a local mutation, before the next snapshot
    // arrives) so the caller's own change is reflected immediately.
    refresh() {
      void fetchNow(appliedRevision ?? 0);
    },
    // Forget what's been fetched so the next syncToRevision refetches unconditionally.
    // Call this when the relay/channel identity changes: an equal revision advertised
    // by a DIFFERENT relay must not be mistaken for already-applied state. This is a
    // full teardown, not just a revision reset: it CLEARS the payload and marks it
    // unloaded (so consumers fail closed — no stale project names / rename-delete
    // controls from the previous relay), INVALIDATES any in-flight fetch (a late
    // response from the old relay must not write into the new one's view), and EMITS
    // so subscribers re-render immediately.
    reset() {
      appliedRevision = null;
      inFlightRevision = null;
      requestSeq += 1; // supersede any in-flight fetch (its captured seq is now stale)
      setState({
        projects: [],
        threadProjectId: {},
        loading: false,
        error: null,
        loaded: false,
      });
    },
  };
}
