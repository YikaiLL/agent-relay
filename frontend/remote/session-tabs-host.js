// Remote Session-tabs host: binds the shared session-view state machine to remote's
// transport, storage and project selection — the remote analog of app.js's controller
// wiring, and the same "host" shape as projects-host.js / workspace-diff-host.js.
//
// What remote supplies differently from local:
//
//   historyAdapter          null. Remote has no URL routing, so a tab set is restored
//                           from storage rather than from a history entry.
//   persistence             one IndexedDB database PER RELAY. A tab set is keyed by
//                           thread and project ids, and those are unique only within
//                           one relay; a shared database would let relay A's tabs
//                           attach to relay B's sessions. relay-scoped-state.js states
//                           that test, and records why this module is NOT on its list:
//                           the per-relay cache key makes a switch select a different
//                           host, so there is nothing to forget.
//   getProjectIds           remote's Projects payload, `null` while it is still
//                           loading — see the comment on that seam below.
//
// The controller sits ABOVE `session-ops.js`'s `viewOnlyThreadId`, never inside it: it
// decides which thread is visible, and the existing remote projection machinery
// (`viewRemoteThread` and the live/viewed session split) remains the only thing that
// acts on that decision.

import React from "react";

import { loadRemovedThreadIds } from "../shared/removed-threads.js";
import {
  createSessionViewController,
  createSessionViewStore,
} from "../shared/session-view-controller.js";
import { createIndexedDbSessionViewPersistence } from "../shared/session-view-persistence.js";
import {
  normalizeSessionViewContext,
  selectContextAfterProjectDelete,
  selectOwningContext,
} from "../shared/session-view-state.js";
import { detectDeferredThreadPromotion } from "../shared/thread-promotion.js";
import { renderLog } from "./client-log.js";
import { getRemoteProjectsStore } from "./projects-host.js";

// Mirrors `remoteQueryScope()` in session-ops.js: an unpaired surface still needs a
// stable bucket, and must not share one with any real relay.
export const UNPAIRED_RELAY_SCOPE = "unpaired";

export function sessionViewDbNameForRelay(relayId) {
  const scope = typeof relayId === "string" && relayId ? relayId : UNPAIRED_RELAY_SCOPE;
  return `sealwire-session-view-remote-${scope}`;
}

/**
 * The context a project SELECTION names.
 *
 * `null` — the resting state of the Project switcher — is the same "sessions" context
 * local uses when no project is selected, so the two surfaces key workspaces identically.
 *
 * Note which direction this runs. The canonical answer to "which tab set is on screen" is
 * `location.context`, exactly as on local (`app.js` renders the strip from
 * `viewState.location.context`, and the switcher's highlight is DERIVED from it). This
 * function converts a selection INTO a context to switch to; it is not a way to compute
 * the context from the sidebar's pin. Getting that backwards files sessions into whatever
 * project happens to be pinned — see `selectOwningContext`, which documents that bug.
 */
export function remoteSessionViewContext(activeProjectId) {
  return normalizeSessionViewContext(
    activeProjectId ? { kind: "project", projectId: activeProjectId } : { kind: "sessions" }
  );
}

export function createRemoteSessionTabsHost({
  relayId = null,
  indexedDb,
  persistence: persistenceOverride = null,
  projectsStore = getRemoteProjectsStore(),
  log = renderLog,
} = {}) {
  const persistence =
    persistenceOverride
    || createIndexedDbSessionViewPersistence({
      ...(indexedDb ? { indexedDb } : {}),
      // Nothing to migrate: the pre-controller localStorage tab sets are a local-surface
      // artifact, and seeding them here would import another surface's thread ids.
      legacyPersistence: null,
      dbName: sessionViewDbNameForRelay(relayId),
    });

  const store = createSessionViewStore({
    initialLocation: { context: { kind: "sessions" }, threadId: null },
    persistence,
    onError(error) {
      log(`[session-tabs] persistence failed: ${error?.message || error}`);
    },
  });

  const controller = createSessionViewController({
    store,
    // No URL to route through, and no history entries to reconcile against.
    historyAdapter: null,
    // `null` means "not authoritative yet", NOT "no projects" — it is what stops boot
    // from treating an unloaded payload as evidence that every project was deleted and
    // sweeping the cold tab sets. Remote fetches Projects over the broker, so this
    // window is wider here than on local.
    getProjectIds() {
      const projects = projectsStore?.getState?.();
      return projects?.loaded ? (projects.projects || []).map((project) => project.id) : null;
    },
    // Local writes these tombstones; remote has no archive/delete transport of its own.
    // Sharing the set is deliberate: a session deleted from the local surface in this
    // browser must not come back as a remote tab.
    getUnavailableThreadIds() {
      return new Set(loadRemovedThreadIds());
    },
    onError(error, details) {
      log(`[session-tabs] ${details?.phase || "transaction"} failed: ${error?.message || error}`);
    },
  });

  // The last thread this surface was known to be viewing, kept so a promotion can be
  // told apart from a plain thread switch. Held here rather than in the React layer
  // because it is the host's own bookkeeping, and because it makes every command below
  // testable without rendering anything.
  let lastAdoptedThreadId = null;

  const commands = {
    store,
    controller,
    relayId,

    /**
     * Boot: read the stored workspaces without deciding what is on screen.
     *
     * The store reads persistence ONLY inside a dispatch and refuses to be seeded any
     * other way, so without this a surface whose relay has no active thread would never
     * touch IndexedDB — the strip would claim "No open sessions" over a populated
     * database until the user happened to click one. `showOverview` is the dispatch that
     * hydrates while explicitly preserving each workspace's remembered focus, so it does
     * not fight remote's rule that the relay's live thread is the default view.
     */
    hydrate() {
      return controller.showOverview(controller.getState().location.context);
    },

    /**
     * Open a thread into the tab set that OWNS it.
     *
     * Never the selected project: a pinned list keeps every session on screen — other
     * projects' rows and unassigned ones — so the owner and the selection routinely
     * differ. Filing by selection is the bug `selectOwningContext` exists to prevent.
     */
    openThread({ threadId, threadProjectId = null, preview = undefined } = {}) {
      if (!threadId) return Promise.resolve(null);
      lastAdoptedThreadId = threadId;
      return controller.openThread(threadId, {
        context: selectOwningContext({ threadId, threadProjectId }),
        preview,
      });
    },

    /**
     * Mirror the thread the surface is actually showing into the tab set.
     *
     * Remote's viewed thread moves for reasons the controller does not cause — boot,
     * another client, a Claude promotion — and the strip has to keep describing what is
     * rendered. `promotedFrom` is the snapshot's own `active_thread_promoted_from`
     * lineage field; when it names the thread we were on, this is a REKEY of one logical
     * session, not the arrival of a second one. Without that the pending tab would
     * survive forever beside its own promoted self, persisted, one per Claude session.
     */
    async adoptViewedThread({ threadId, promotedFrom = null, threadProjectId = null } = {}) {
      if (!threadId) return null;
      const promotion = detectDeferredThreadPromotion({
        previousThreadId: lastAdoptedThreadId,
        nextThreadId: threadId,
        nextThreadPromotedFrom: promotedFrom,
      });
      if (promotion) {
        lastAdoptedThreadId = threadId;
        return controller.retargetThread(promotion.from, promotion.to);
      }
      lastAdoptedThreadId = threadId;
      // `preview` is deliberately omitted: routing without re-flagging leaves a session
      // the user chose to KEEP alone, rather than demoting it back to a peek.
      return controller.openThread(threadId, {
        context: selectOwningContext({ threadId, threadProjectId }),
      });
    },

    /**
     * A project is gone — deleted here or by a peer.
     *
     * The LOCATION has to move, not just the sidebar's pin: leaving the context pointing
     * at a dead project keeps the strip rendering its workspace and aims every close /
     * pin / move / promote at it, which is precisely the two-sources-of-truth state the
     * location-owns-the-context design removes. The pin follows on its own, because it is
     * a projection of the context.
     *
     * `whenIdle` first: a project click that has not finished persisting still reports
     * the previous context, so deciding without draining the queue would sweep away a
     * selection the user just made. Returns null when the deletion does not concern us,
     * and then nothing is dispatched — deleting some other project must not navigate.
     */
    async forgetProject(projectId) {
      if (!projectId) return null;
      await controller.whenIdle();
      const nextContext = selectContextAfterProjectDelete({
        context: controller.getState().location.context,
        deletedProjectId: projectId,
      });
      if (!nextContext) return null;
      return controller.showOverview(nextContext, { replace: true });
    },

    /**
     * Follow a project selection, restoring where you were in that project.
     *
     * This is what makes the switcher swap TAB SETS and not just the sidebar's pinned
     * group, and it is why the location — not the sidebar's pin — is the source of truth
     * for which workspace is on screen.
     */
    selectProject(projectId) {
      return controller.switchContext(remoteSessionViewContext(projectId));
    },
  };

  return commands;
}

// One host per relay, cached so a re-render never rebuilds the controller underneath an
// in-flight transaction. Switching relays builds a new one against a different database
// rather than clearing this one — so switching back finds those tabs intact.
let cachedHost = null;

export function getRemoteSessionTabsHost(relayId = null) {
  const scope = relayId || UNPAIRED_RELAY_SCOPE;
  if (!cachedHost || cachedHost.scope !== scope) {
    cachedHost = { scope, host: createRemoteSessionTabsHost({ relayId }) };
  }
  return cachedHost.host;
}

export function resetRemoteSessionTabsHost() {
  cachedHost = null;
}

/**
 * React subscription to the visible location + tab sets.
 *
 * Subscription lives on the CONTROLLER, not the store: the store exposes only
 * `getState`/`dispatch`, and the controller is what announces a committed change — after
 * persistence has settled, which is the only point at which the snapshot is worth
 * rendering. `getState` holds one reference between commits, so it is a valid
 * useSyncExternalStore snapshot.
 */
export function useRemoteSessionTabs(relayId = null) {
  const host = getRemoteSessionTabsHost(relayId);
  const viewState = React.useSyncExternalStore(
    host.controller.subscribe,
    host.controller.getState
  );
  return { host, viewState };
}
