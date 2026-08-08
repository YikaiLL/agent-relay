// Remote Session-tabs host: binds the shared session-view state machine to remote's
// transport, storage and project selection — the remote analog of app.js's controller
// wiring, and the same "host" shape as projects-host.js / workspace-diff-host.js.
//
// What remote supplies differently from local:
//
//   historyAdapter          a storage-backed LOCATION MEMO, not a browser history.
//                           Remote has no URL routing, so the thing local reads back on
//                           reload — `history.state` for the workspace, `?thread=` for
//                           the session — has to come from a key of its own. See
//                           session-location-memo.js; the adapter seam is reused because
//                           the controller already fires it on exactly the commits that
//                           move the surface.
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
  sessionViewContextKey,
} from "../shared/session-view-state.js";
import { detectDeferredThreadPromotion } from "../shared/thread-promotion.js";
import { renderLog } from "./client-log.js";
import { getRemoteProjectsStore } from "./projects-host.js";
import { createSessionLocationMemo } from "./session-location-memo.js";

// Mirrors `remoteQueryScope()` in session-ops.js: an unpaired surface still needs a
// stable bucket, and must not share one with any real relay.
export const UNPAIRED_RELAY_SCOPE = "unpaired";

// Marks the one context switch that is a RESTORE rather than a navigation. Exported
// because the repair belongs to whoever performs the view (react-app.js) and the claim
// belongs here — a string literal on both sides of that seam is a rename away from
// silently disabling the repair.
export const BOOT_RESTORE_REASON = "boot-restore";

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
  storage,
  locationMemo: locationMemoOverride = null,
  log = renderLog,
} = {}) {
  // Remote's replacement for local's history entry — see session-location-memo.js. Same
  // relay scope as the database above, for the same reason: a context is a project id.
  const locationMemo =
    locationMemoOverride
    || createSessionLocationMemo({
      relayScope: relayId || UNPAIRED_RELAY_SCOPE,
      ...(storage ? { storage } : {}),
    });

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

  // The projects payload as it actually arrived, or `null` for "not authoritative yet".
  function payloadProjectIds() {
    const projects = projectsStore?.getState?.();
    return projects?.loaded ? (projects.projects || []).map((project) => project.id) : null;
  }

  // What may be RESTORED from the memo — the payload, plus the project this surface is
  // currently in even once the payload has stopped naming it.
  //
  // That addition is remote's "fail open" rule, and it has to live in the ALLOWLIST
  // rather than in a decision to skip the sweep. The first version of this skipped the
  // whole reconcile whenever the current project went missing, which preserved
  // reversibility and quietly disabled the garbage collector: a phantom context survives
  // reloads (`hydrate` re-enters it without validating, because at that point nothing can
  // be validated), so every OTHER dead workspace stopped being collected too — on exactly
  // the surface that had accumulated them. Widening the allowlist by one keeps the
  // unresolvable project and its tabs while still sweeping everything genuinely gone.
  //
  // Note the exact scope, because it is narrower than "remote never trusts absence": the
  // exemption covers the ONE project you are in. Any other project absent from a settled,
  // non-empty payload has its tab set deleted, same as on local. That is a deliberate
  // floor rather than an oversight — the alternative is never collecting anything — and
  // the cost of being wrong is bounded to a tab set, never a session. `reconcileProjects`
  // declines empty payloads separately, which removes the case where being wrong would
  // cost all of them at once.
  //
  // Only `RESTORE_HISTORY` reads this fact, so nothing else can be affected by it.
  function restorableProjectIds() {
    const ids = payloadProjectIds();
    if (!ids) {
      return null;
    }
    const context = store.getState().location.context;
    return context?.kind === "project" && !ids.includes(context.projectId)
      ? [...ids, context.projectId]
      : ids;
  }

  const controller = createSessionViewController({
    store,
    // Not a browser history — remote has no URL to route through. It is the one storage
    // key that remembers which workspace this surface was in, and the adapter seam is
    // what makes "record it" fire on exactly the commits that move the surface, with no
    // second list of call sites to keep in step.
    historyAdapter: locationMemo,
    // `null` means "not authoritative yet", NOT "no projects" — it is what stops boot
    // from treating an unloaded payload as evidence that every project was deleted and
    // sweeping the cold tab sets. Remote fetches Projects over the broker, so this
    // window is wider here than on local.
    getProjectIds: restorableProjectIds,
    // Local writes these tombstones; remote has no archive/delete transport of its own.
    // Sharing the set is deliberate: a session deleted from the local surface in this
    // browser must not come back as a remote tab.
    getUnavailableThreadIds() {
      return new Set(loadRemovedThreadIds());
    },
    // Runs BEFORE the subscribers, which is the whole reason the restore records itself
    // here rather than from the value its own `dispatch` resolves with. `commitNow`
    // invokes listeners and only then returns, so anything derived from the resolved
    // promise is still unset when the repair in react-app.js asks `isShowingBootRestore()`
    // from inside that listener. Deriving it here makes the ordering a property of the
    // seam instead of a race the transcript fetch happens to lose.
    onCommit(change) {
      if (change?.action?.reason === BOOT_RESTORE_REASON) {
        bootRestoredThreadId = change.next?.location?.threadId || null;
      }
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

  // The boot restore, as a memoized PROMISE rather than a boolean.
  //
  // A boolean set before an `await` is not a latch. The boot seam is concurrent — React
  // fires the mount effects in one flush and snapshots arrive on their own clock — so a
  // second caller would see the flag already taken, skip the restore, and file the live
  // thread FIRST; the restore then read the live thread's context instead of the
  // remembered one and restored the wrong tab set entirely. A promise lets every late
  // caller await the same one-shot instead of racing past it.
  //
  // `whenIdle()` does not serialize these on its own, which is the subtlety that made
  // this look safe: two callers observe the same drained queue and BOTH return before
  // either has enqueued anything, so the second still reads a location the first has
  // already decided to replace.
  let bootRestore = null;
  // Which thread the restore put on screen, or null if there was nothing to restore.
  let bootRestoredThreadId = null;
  // Whether the restore has finished. This is what separates the adoptions the restore
  // OUTRANKS from the ones it must yield to, and the distinction is causal rather than
  // ordinal: an adoption that was already in flight when the restore started is the boot
  // snapshot the restore exists to overrule, while one that begins afterwards is the
  // rendered thread genuinely moving — and the strip's whole job is to follow that.
  //
  // Sampled synchronously at call entry, before any await, so two adoptions landing in
  // one tick are classified identically no matter how their awaits interleave.
  let bootRestoreSettled = false;

  // The project set this host has already reconciled against — see `reconcileProjects`.
  let reconciledProjectSignature = null;

  function startBootRestore() {
    bootRestore ||= (async () => {
      await controller.whenIdle();
      // Tagged, and dispatched through the raw seam for that reason alone. The subscriber
      // has to be able to tell THIS switch from the one the project switcher makes: a
      // restore whose transcript fetch fails must fall back to the live thread, while a
      // project selection whose fetch fails must not — falling back there would yank the
      // user out of the project they just picked, which is the same trap the CLOSE_TAB
      // scoping in react-app.js documents.
      await controller.dispatch(
        {
          type: "SWITCH_CONTEXT",
          context: controller.getState().location.context,
          reason: BOOT_RESTORE_REASON,
        },
        { history: "replace" }
      );
      // `bootRestoredThreadId` is set by `onCommit` above, before any subscriber ran.
      bootRestoreSettled = true;
      return bootRestoredThreadId;
    })().catch((error) => {
      // A memoized promise caches a REJECTION forever, and every adoption awaits this
      // one — so without this a single transient failure would rethrow on every later
      // adoption and permanently stop the strip describing the rendered thread, with the
      // reconcile dead beside it and nothing but an unhandled rejection to show for it.
      // Losing the restore is the correct cost; losing the surface is not. Everything
      // else in this module degrades rather than throws, and so does this.
      log(`[session-tabs] boot restore failed: ${error?.message || error}`);
      bootRestoreSettled = true;
      bootRestoredThreadId = null;
      return null;
    });
    return bootRestore;
  }

  const commands = {
    store,
    controller,
    relayId,

    /**
     * Boot: read the stored workspaces, and re-enter the workspace we were last in.
     *
     * The store reads persistence ONLY inside a dispatch and refuses to be seeded any
     * other way, so without this a surface whose relay has no active thread would never
     * touch IndexedDB — the strip would claim "No open sessions" over a populated
     * database until the user happened to click one.
     *
     * `showOverview` and not `switchContext`, and the difference is the whole safety
     * argument for doing this at mount: it restores the CONTEXT while routing NO thread.
     * Routing one here would fire `onViewThread` -> `viewRemoteThread` before the broker
     * channel is necessarily up; that fetch would fail, and the surface would be left
     * with the location naming one session and the screen showing another — a strip that
     * lies, with nothing to repair it. Focus is restored later instead, by the first
     * adoption, which by definition happens only once a snapshot has arrived.
     *
     * A remembered context naming a project that has since been deleted is NOT validated
     * here — nothing can be, because the Projects payload is still in flight. That is
     * `reconcileProjects`'s job the moment it lands, which is also the order local runs
     * these in.
     */
    hydrate() {
      const remembered = locationMemo.read?.();
      const context = remembered?.context
        ? normalizeSessionViewContext(remembered.context)
        : controller.getState().location.context;
      return controller.showOverview(context);
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
     * Drop this relay's remembered workspace.
     *
     * Deliberately not called anywhere yet, and that is a statement about the surface
     * rather than an oversight: remote has no "forget this relay" action at all today —
     * `clearRelayNickname` has no production caller either, and the resets in state.js
     * are corrupt-payload recovery, not per-relay teardown. So the memo joins the
     * nicknames as one stale key per relay ever paired, and this is the one place a real
     * teardown would call when one exists. Everything else here is scoped BY
     * CONSTRUCTION (a different relay selects a different key), which is why the absence
     * costs nothing but disk.
     */
    forgetLocationMemo() {
      return locationMemo.forget?.();
    },

    /**
     * Is the surface still sitting on the session the boot restore put there?
     *
     * The one predicate two different decisions need, which is why it is state and not a
     * flag. An adoption yields to the restore only while the restore is still what is on
     * screen; and the repair for a FAILED restore may only fire while that is still true —
     * `viewRemoteThread` returns `false` both when a fetch failed and when a NEWER
     * navigation superseded it (`session-ops.js`'s generation guard), so without this the
     * user tapping another session mid-boot would be dragged to the live thread by the
     * stale answer to a fetch they had already walked away from.
     */
    isShowingBootRestore() {
      return (
        bootRestoredThreadId != null
        && controller.getState().location.threadId === bootRestoredThreadId
      );
    },

    /**
     * Should a `false` from viewing the restored thread be repaired by showing the live one?
     *
     * The whole decision, kept here rather than in the subscriber that acts on it, so the
     * rule is checkable without rendering anything — as every other decision in this file
     * is. Three conditions, each for its own reason:
     *
     *   - `shown === false` only. `undefined` means no handler ran at all, which is not a
     *     failure report.
     *   - the restore must still be on screen — see `isShowingBootRestore`, and the
     *     superseded-vs-failed conflation it exists to survive.
     *   - there must BE a live thread. Without one there is nothing better to show, so the
     *     location keeps naming a session that never loaded. Accepted: a relay with no
     *     active thread has no conversation to fall back to, and inventing one would be a
     *     worse lie than the one it replaces.
     */
    shouldRepairBootRestore({ shown, liveThreadId } = {}) {
      return shown === false && Boolean(liveThreadId) && commands.isShowingBootRestore();
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

      // The boot restore, and the only place the relay's live thread does not win.
      //
      // The first adoption after a page load IS the relay's first snapshot, and that is
      // the moment the restore has to happen. Earlier is unsafe (see `hydrate`: no
      // channel, so no transcript). Later is too late: this very call is what would
      // otherwise route the surface to the live thread and file a tab for it, on top of
      // the workspace the user actually left open.
      //
      // `switchContext` rather than a hand-rolled lookup, because restoring a workspace's
      // remembered focus is exactly what SWITCH_CONTEXT is defined to do — deriving the
      // same answer here would be a second implementation of the rule, free to drift.
      //
      // Every caller AWAITS the same one-shot, including the ones that arrive while it is
      // still settling. Whether THIS adoption yields is then decided causally — was it
      // already in flight when the restore started? — rather than by asking "am I the
      // first call", which two snapshots landing in one tick can both answer wrongly.
      //
      // The distinction is not cosmetic. At boot the screen still shows the relay's live
      // thread while the location already names the restored one, so the two disagree by
      // design for as long as the transcript fetch takes; those adoptions are exactly what
      // the restore overrules. Afterwards, an adoption naming a different thread means the
      // RENDERED thread moved, and following it is the entire purpose of this function —
      // declining there would leave the strip describing a session that is not on screen.
      const claimedByBootRestore = !bootRestoreSettled;
      const restoredThreadId = await startBootRestore();
      // A workspace with no remembered focus yields nothing, and then this falls through
      // to the live thread: a restored context with nothing in it is an empty strip over
      // someone else's conversation, not a restore. Same when the remembered tab IS the
      // live thread, where both paths agree anyway.
      if (
        claimedByBootRestore
        && restoredThreadId
        && restoredThreadId !== threadId
        && commands.isShowingBootRestore()
      ) {
        lastAdoptedThreadId = restoredThreadId;
        return null;
      }

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
     * The projects payload became authoritative — sweep tab sets whose project is gone.
     *
     * `RESTORE_HISTORY` is the ONLY action that deletes whole workspace buckets
     * (`validHistoryWorkspaces`), and remote never dispatched it: with no URL to route
     * through there was no boot restore, so a deleted project's tabs stayed in IndexedDB
     * forever. This re-runs the CURRENT location as a restore, which is exactly what
     * local does on the same signal (`app.js`'s projects subscriber) — the entry is
     * synthesized from the store rather than read from `window.history.state`, because
     * remote has no history to read.
     *
     * Three things this must not get wrong, each with a test:
     *
     *   - `whenIdle` first. A project click that has not finished persisting still
     *     reports the previous context, so restoring without draining the queue would
     *     replace a selection the user just made.
     *   - Pass `location.threadId`, never null. A null routes to NO thread, and remote
     *     has no overview screen to land on — it would blank the conversation. Passing
     *     the current thread is a re-open of what is already routed.
     *   - The sweep is an allowlist diffed against disk, so every key it omits is a
     *     DELETE. `getProjectIds()` returning null disables it entirely, which is what
     *     keeps a still-loading payload from reading as "every project was deleted".
     *     That window is wider here than on local; nothing below may narrow it.
     *
     * And two gates local does NOT have, because remote does not share local's reading of
     * "absent from a settled payload". Local reads a project list off its own disk and
     * treats absence as deletion. Remote reads one that crossed a broker and a relay, and
     * has already decided the opposite: the pin FAILS OPEN and stays REVERSIBLE, asserted
     * in browser-remote-mobile-bell-e2e.mjs — *"the selection was never destroyed, only
     * unresolvable, so the project coming back re-pins it without the user re-choosing."*
     * Copying local's fallback here converts every transiently-wrong payload into a
     * permanent deletion, which is how this was found.
     */
    async reconcileProjects() {
      // Every call site is a `void`, so anything that escapes here is an unhandled
      // rejection with nothing logged. Degrade instead — the cost of a failed sweep is
      // cold buckets surviving until the next attempt, and because the signature is only
      // recorded on success there IS a next attempt. Wrapping the whole body rather than
      // just the dispatch, because the reads before it (`payloadProjectIds`) and the ones
      // the dispatch makes internally (`getProjectIds`) can fail the same way.
      try {
        return await reconcileProjectsNow();
      } catch (error) {
        log(`[session-tabs] project reconcile failed: ${error?.message || error}`);
        return null;
      }
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

  /** The body of `reconcileProjects`, separated so the command can be a fail-soft wrapper. */
  async function reconcileProjectsNow() {
      // Wait for a boot restore that is already in flight, and ONLY for one that is.
      //
      // Both this and the restore drain the queue and then read the location — and
      // `whenIdle` does not order them, so without this the reconcile could resume one
      // microtask after the restore enqueued its switch and read the PRE-restore location.
      // At boot that location deliberately routes no thread, so the reconcile would
      // re-run it as `urlThreadId: null` and blank the conversation the restore had just
      // put on screen: precisely the trap its own doc comment forbids, reached by a stale
      // read rather than a literal null.
      //
      // Never *starts* one: a reconcile can also run long before the first snapshot, and
      // awaiting a restore that nothing has triggered would hang here forever. The other
      // order is safe on its own — a reconcile that lands first routes no thread either,
      // and the restore that follows still finds the workspace's remembered focus.
      if (bootRestore) {
        await bootRestore;
      }
      await controller.whenIdle();
      // An EMPTY list is the shape with the largest blast radius — it would sweep every
      // bucket at once — and simultaneously the shape with nothing legitimate to do: a
      // relay that really has no projects has no project buckets to sweep. Declining it
      // costs nothing and removes the only case that can be catastrophic. Read from the
      // PAYLOAD, not the allowlist, or the fail-open entry would make an empty answer
      // look like a list of one.
      const payload = payloadProjectIds();
      if (!payload?.length) {
        return null;
      }
      // Once per distinct (project set, current context), and the memory lives HERE rather
      // than in the component that calls this. It is per-host state: a host is per relay,
      // so a relay switch gets a fresh one for free, whereas a React ref outlives the
      // switch (RemoteApp never remounts) and would let relay B skip its first sweep
      // whenever its id set happened to serialize the same as relay A's last one.
      //
      // The CONTEXT belongs in the key because the sweep's answer depends on it: the
      // project you are in is exempt from collection, so the same payload yields a
      // different result once you leave. Keying on the set alone meant a phantom project's
      // bucket stayed exempt after you had navigated away from it, until a reload. It is
      // still not immediate — nothing re-runs this on a context change, only on a settled
      // payload — but the next payload now collects it instead of skipping.
      const location = controller.getState().location;
      const signature = JSON.stringify([payload, sessionViewContextKey(location.context)]);
      if (signature === reconciledProjectSignature) {
        return null;
      }
      const swept = await controller.restoreHistory(
        { version: 1, context: location.context },
        location.threadId
      );
      // Recorded only on SUCCESS, and that ordering is the whole point. Marking the set
      // reconciled before dispatching would burn it on a failed sweep: the cold buckets
      // survive and nothing retries them for the life of the host. Same latch-on-failure
      // the boot restore had, in the last seam that still had it.
      reconciledProjectSignature = signature;
      return swept;
  }

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
