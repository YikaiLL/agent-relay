// Revision-keyed cache for the dedicated Teams channel.
//
// The snapshot carries `teams_revision` and nothing else about tasks — a run view
// has an unbounded sub-task list, so it would need the whole compaction budget to
// ride along. This cache turns that scalar into the full payload from
// `GET /api/session/teams`.
//
// Fourth of its shape (see `reviews-cache.js`, `workflows-cache.js`,
// `devices-cache.js`); kept separate rather than factored because each channel's
// payload normalisation differs and three shipped surfaces depend on the others.

// `sync` runs on every render, so a revision that can never succeed would fire a
// request per frame forever. Three tries is enough to ride out a restart without
// turning a dead endpoint into a spin.
const MAX_ATTEMPTS_PER_REVISION = 3;

export function createTeamsCache() {
  let syncedRevision = null;
  let inflightRevision = null;
  let loaded = false;
  let data = { teams: [] };
  let failedRevision = null;
  let failures = 0;

  return {
    current() {
      return data;
    },
    hasData() {
      return loaded;
    },
    /**
     * Whether a fetch is in flight right now.
     *
     * Exists for one specific lie: starting a task navigates to its detail
     * immediately, while the cache still holds the pre-create list. It HAS data
     * and is not loading, so a screen that only knows those two states concludes
     * the brand-new task does not exist.
     */
    isSyncing() {
      return inflightRevision !== null;
    },
    /**
     * Force the next `sync` to refetch even though the revision has not moved.
     *
     * For the window after a mutation this client made: the relay's revision will
     * catch up, but not before the next render. Deliberately keeps `data` and
     * `loaded` — a list the user is reading must not blank because something else
     * was created.
     */
    invalidate() {
      syncedRevision = null;
      failedRevision = null;
      failures = 0;
    },
    async sync(snapshotRevision, fetchTeams, onUpdate, onError) {
      if (snapshotRevision == null) return;
      if (syncedRevision === snapshotRevision || inflightRevision === snapshotRevision) return;
      // A revision that has already failed its budget is not retried until a NEW
      // revision arrives — that is a new fact about the world, so it gets a fresh
      // budget.
      if (failedRevision === snapshotRevision && failures >= MAX_ATTEMPTS_PER_REVISION) return;
      if (failedRevision !== snapshotRevision) {
        failedRevision = null;
        failures = 0;
      }
      inflightRevision = snapshotRevision;
      try {
        const response = await fetchTeams();
        // Superseded by a newer revision: not a failure, and not this sync's
        // business any more. Return without touching the budget.
        if (inflightRevision !== snapshotRevision) return;
        // `response == null` is not an empty answer. The broker's plaintext
        // envelope can drop the payload field, and latching `loaded` on that would
        // leave a truthy-but-empty cache permanently shadowing the caller's
        // fallback. It IS a failure though — counted and reported like a throw, or
        // it refetches once per render forever and says nothing while doing it.
        if (response == null) {
          failedRevision = snapshotRevision;
          failures += 1;
          onError?.(new Error("the relay returned no task list"));
          return;
        }
        syncedRevision = snapshotRevision;
        loaded = true;
        failedRevision = null;
        failures = 0;
        data = { teams: response.teams || [] };
        onError?.(null);
        onUpdate?.();
      } catch (error) {
        // Keep the tasks already on screen — a task can sit paused for hours, and
        // blanking it on one failed poll is worse than showing state a few seconds
        // old. But REPORT it: a silently swallowed failure is indistinguishable
        // from a slow relay, and the screen sits on "Loading…" forever.
        failedRevision = snapshotRevision;
        failures += 1;
        onError?.(error);
      } finally {
        if (inflightRevision === snapshotRevision) inflightRevision = null;
      }
    },
  };
}
