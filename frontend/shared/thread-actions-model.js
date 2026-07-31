// Pure descriptors for the per-session actions sheet.
//
// Local drives its right-click menu imperatively (a fixed singleton in react-shell.js
// whose labels and disabled flags are set by DOM id from app.js), so there is no menu
// component to share. What IS shareable is the decision of WHICH actions a session
// offers — that is this module, side-effect free so the gating rules unit-test without
// a DOM. The surface renders the descriptors and owns the actual calls.
//
// Only actions whose transport exists today are listed. Archive and delete are
// deliberately absent: local reaches them over HTTP routes the broker has no
// RemoteActionKind for, so offering them here would render buttons that cannot fire.

import { buildProjectMenuItems, projectsMenuReady } from "./project-menu.js";

/**
 * Ordered sections for the sheet.
 *
 * Fork is gated on `canFork` because a session with nothing to fork from cannot be
 * forked; the project section is gated on the projects payload being fresh, mirroring
 * the sidebar's fail-closed rule (`projectsMenuReady`) so a stale membership can never
 * present a wrong "current" marker or an assign that overwrites newer state.
 *
 * @returns {Array<{kind: string, label: string, items?: Array}>} sections, possibly empty
 */
export function buildThreadSheetSections({
  canFork = false,
  projects = [],
  currentProjectId = null,
  projectsLoaded = false,
  projectsError = null,
  projectsLoading = false,
} = {}) {
  const sections = [];
  if (canFork) {
    sections.push({
      kind: "session",
      label: "Session",
      items: [{ kind: "fork", label: "Fork session" }],
    });
  }
  if (projectsMenuReady({ projectsLoaded, projectsError, projectsLoading })) {
    sections.push({
      kind: "projects",
      label: "Projects",
      items: buildProjectMenuItems({ projects, currentProjectId }),
    });
  }
  return sections;
}

/**
 * Whether the sheet has anything to show. An empty sheet must not open at all — a
 * bottom sheet that slides up blank reads as a bug, and on a phone it also steals a
 * tap to dismiss.
 */
export function threadSheetHasActions(sections) {
  return (Array.isArray(sections) ? sections : []).some((section) => section?.items?.length);
}
