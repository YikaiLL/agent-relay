// Which actions a session's sheet offers, and which session that sheet is for.
//
// Local drives its right-click menu imperatively (a fixed singleton in react-shell.js
// whose labels and disabled flags are set by DOM id from app.js), so there is no menu
// component to share. What IS shareable is the decision of which actions a session
// offers — that is this module, side-effect free so the gating rules unit-test without
// a DOM. The surface renders the descriptors and owns the actual calls.
//
// Two rules decide what appears, and they are deliberately different:
//
//   * An action remote has no TRANSPORT for is never listed. Archive and delete reach
//     the relay over HTTP routes the broker has no RemoteActionKind for, so a button
//     for them could not fire — it would be a lie, not a disabled control.
//   * An action that exists but is momentarily unavailable is listed and DISABLED,
//     saying why. Fork on a running session is local's exact behaviour; hiding it
//     would make the sheet change shape as a turn starts and ends.
//
// That second rule also removes a whole class of dead state: because fork is always
// present, a resolved session always has something to show, so the sheet can never be
// tapped into silence and can never open belatedly when a slow payload lands.

import { buildProjectMenuItems, projectsMenuReady } from "./project-menu.js";
import { resolveForkSourceThread, threadIsBusyForFork } from "./fork-fields.js";

/**
 * Ordered sections for the sheet.
 *
 * @returns {Array<{kind: string, label: string, items: Array}>}
 */
export function buildThreadSheetSections({
  forkBlocked = false,
  projects = [],
  currentProjectId = null,
  projectsLoaded = false,
  projectsError = null,
  projectsLoading = false,
} = {}) {
  const sections = [
    {
      kind: "session",
      label: "Session",
      items: [
        {
          kind: "fork",
          // Same wording local's menu swaps in, so the two surfaces explain the same
          // refusal the same way.
          label: forkBlocked ? "Running session cannot be forked" : "Fork session",
          disabled: forkBlocked,
        },
      ],
    },
  ];

  if (projectsMenuReady({ projectsLoaded, projectsError, projectsLoading })) {
    sections.push({
      kind: "projects",
      label: "Projects",
      items: buildProjectMenuItems({ projects, currentProjectId }),
    });
  } else {
    // Projects ARE supported here — the payload just is not trustworthy yet. Fail
    // closed on the controls (a stale membership could mark the wrong project current,
    // or an assign could overwrite newer state) but say so, rather than leaving a gap
    // where a section will silently appear later.
    sections.push({
      kind: "projects",
      label: "Projects",
      items: [
        {
          kind: "projects-unavailable",
          // An error wins over "loading". The store leaves `loaded:false` when the
          // FIRST fetch throws, so testing `!projectsLoaded` first reported a failed
          // first load — the most likely failure there is — as still loading, i.e. a
          // spinner-ish message for something that will never arrive on its own.
          label: projectsError ? "Projects unavailable" : "Projects are loading…",
          disabled: true,
        },
      ],
    });
  }
  return sections;
}

/**
 * Resolve the session a sheet was opened for, and build its sections.
 *
 * Resolution goes through `resolveForkSourceThread`, NOT a plain lookup in the fetched
 * list: the render model injects the active session as a row when history has not
 * loaded or pagination left it out, and that row is real and tappable. Looking only in
 * the list left such a row's "⋯" dead while its right-click (which already used this
 * fallback) still worked.
 */
export function selectThreadSheet({
  threadId,
  threads = [],
  session = null,
  projects = [],
  threadProjectId = null,
  projectsLoaded = false,
  projectsError = null,
  projectsLoading = false,
} = {}) {
  const thread = resolveForkSourceThread({ threadId, threads, session });
  if (!thread) {
    return { thread: null, sections: [], hasActions: false };
  }
  const sections = buildThreadSheetSections({
    // The rule the relay enforces and local's menu mirrors — a BACKGROUND thread can be
    // mid-turn too, so this is not just "is the active session running".
    forkBlocked: threadIsBusyForFork(thread, session),
    projects,
    currentProjectId: threadProjectId?.[threadId] || null,
    projectsLoaded,
    projectsError,
    projectsLoading,
  });
  return { thread, sections, hasActions: threadSheetHasActions(sections) };
}

/** Whether the sheet has anything to show. */
export function threadSheetHasActions(sections) {
  return (Array.isArray(sections) ? sections : []).some((section) => section?.items?.length);
}
