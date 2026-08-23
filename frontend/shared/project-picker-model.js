// Pure model for the project picker's menu rows.
//
// The picker is the same control in three places — the top-bar switcher, the New
// session dialog, and the Fork dialog — so what a row SAYS is decided once, here,
// with no DOM and no store. The React component below it only draws.
//
// Everything on a row is derived from data the surfaces already hold: project
// membership (`thread_project_id`) joined against the thread list, plus the same
// three live-signal maps the sidebar dots read. Nothing here needs a server field,
// which is why the picker can ship without touching the byte-budgeted
// `ThreadsResponse`.

import { DEFAULT_WORKSPACE_LABEL } from "./project-labels.js";
import { selectProjectAgents, summarizeProjectActivity } from "./project-overview-model.js";
import { formatRelativeTime } from "../remote/utils.js";

// The default row is not a project and has no membership to count — a session
// with no `thread_project_id` entry is simply unfiled. Saying so is more honest
// than counting every unassigned thread, which would make the row look like the
// biggest project in the list when it is really the absence of one.
export const DEFAULT_WORKSPACE_SUBTITLE = "unfiled sessions";

function pluralizeSessions(count) {
  return count === 1 ? "1 session" : `${count} sessions`;
}

// One project's second line.
//
// Priority is "is anything happening" over "how big is it": a count alone cannot
// distinguish a project you should open right now from one you last touched in
// March. Only when nothing is live does the line fall back to age.
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
    // needs-input folds into "running" deliberately. A session blocked on an
    // approval is the most urgent thing a project can contain, and splitting it
    // into its own clause makes the line long enough to truncate on a phone —
    // where the distinction is least visible anyway. The dot in the session list
    // still tells them apart.
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

// The full row list, default workspace first.
//
// `activeProjectId` is resolved against the project list rather than trusted:
// an id whose project was deleted on another device marks the DEFAULT row, the
// same fail-open rule `ProjectSwitcher` applies to its trigger label. Letting the
// raw id through gave one control two answers — no row ticked, while the list
// below had already fallen back to plain cwd grouping.
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
