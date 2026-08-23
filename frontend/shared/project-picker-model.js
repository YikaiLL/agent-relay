// Pure row model for the project picker, shared by the top-bar switcher and both
// launch dialogs. Everything is derived client-side; no server field is needed.

import { DEFAULT_WORKSPACE_LABEL } from "./project-labels.js";
import { selectProjectAgents, summarizeProjectActivity } from "./project-overview-model.js";
import { formatRelativeTime } from "../remote/utils.js";

// Not a count: unassigned sessions would make this look like the biggest project
// in the list when it is really the absence of one.
export const DEFAULT_WORKSPACE_SUBTITLE = "unfiled sessions";

function pluralizeSessions(count) {
  return count === 1 ? "1 session" : `${count} sessions`;
}

// Liveness outranks size: a count alone cannot separate a project worth opening
// now from one last touched in March. Falls back to age only when nothing is live.
export function projectSubtitle({
  agents = [],
  threadActivity = null,
  threadAttention = null,
  threadReviewing = null,
  lastActiveAt = null,
  now = null,
} = {}) {
  const summary = summarizeProjectActivity({
    agents,
    threadActivity,
    threadAttention,
    threadReviewing,
  });

  if (summary.total > 0) {
    // needs-input folds into "running": splitting it makes the line long enough to
    // truncate on a phone, and the session list's dot already tells them apart.
    const live = summary.working + summary.needsInput + summary.reviewing;
    return live > 0
      ? `${pluralizeSessions(summary.total)} · ${live} running`
      : pluralizeSessions(summary.total);
  }

  if (!lastActiveAt) {
    return null;
  }
  return `idle · ${formatRelativeTime(lastActiveAt, now)}`;
}

// `activeProjectId` is resolved against the list, not trusted: an id deleted on
// another device marks the DEFAULT row instead of leaving nothing ticked.
export function buildProjectPickerRows({
  projects = [],
  threads = [],
  threadProjectId = {},
  threadActivity = null,
  threadAttention = null,
  threadReviewing = null,
  activeProjectId = null,
  now = null,
} = {}) {
  const resolvedId =
    (activeProjectId && (projects || []).some((project) => project?.id === activeProjectId))
      ? activeProjectId
      : null;

  const rows = [
    {
      id: null,
      label: DEFAULT_WORKSPACE_LABEL,
      subtitle: DEFAULT_WORKSPACE_SUBTITLE,
      active: resolvedId === null,
    },
  ];

  for (const project of projects || []) {
    if (!project?.id) {
      continue;
    }
    const agents = selectProjectAgents({
      projectId: project.id,
      threads,
      threadProjectId,
    });
    rows.push({
      id: project.id,
      // A project can legitimately hold an empty name (renamed to blank on
      // another client); showing its id beats showing nothing at all.
      label: project.name || project.id,
      subtitle: projectSubtitle({
        agents,
        threadActivity,
        threadAttention,
        threadReviewing,
        // selectProjectAgents sorts by recency, so the head is the newest — but
        // do not depend on that here; take the max explicitly.
        lastActiveAt: agents.reduce(
          (newest, agent) => Math.max(newest, Number(agent?.updated_at) || 0),
          0
        ) || null,
        now,
      }),
      active: project.id === resolvedId,
    });
  }

  return rows;
}
