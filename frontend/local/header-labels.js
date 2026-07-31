// The session header's title + subtitle text as ONE pure decision — mirroring
// status-badge.js, so the "what does the header say" rules live in a single tested
// place instead of drifting across inline branches in renderHeader.
//
// Product decisions encoded here (deliberate, not incidental):
//
//  - The title names the CONTAINER you are in, not the thread you are reading.
//    It used to be the thread — which put the same string twice on screen, once
//    in the header and again in the session tab strip directly beneath it. The
//    two lines now answer different questions: header = "where am I", tab =
//    "which session". (This supersedes the earlier rule that the title is the
//    thread and never the workspace; that rule existed to stop the workspace
//    name dominating every screen, which the tab strip has since made moot.)
//
//  - Which container depends on how you are browsing. In Projects mode the
//    container is the selected project, and it carries the New agent action,
//    because starting an agent *into a project* is the thing you do from there.
//    In Sessions mode sessions are grouped by working directory, so the folder
//    is the container. A project never leaks into Sessions mode: it would name
//    a grouping the user isn't looking at.
//
//  - The title is a basename, not a path. Full paths do not survive a title bar
//    at any useful width; the path goes on `titleTooltip` so nothing is lost.
//
//  - "live" is gone: for a live conversation it carried no signal (if you can
//    type, it's live) and it collided with the run-state badge ("Idle") beside it.
//
//  - "read-only" stays: it's a real warning (the composer is disabled).
export function selectHeaderLabels({
  hasWorkspace = false,
  activeThreadId = null,
  viewingConversation = false,
  viewOnly = false,
  reviewInProgress = false,
  threadLabel = "",
  sidebarMode = "sessions",
  projectId = null,
  projectName = "",
  workspaceName = "",
  workspacePath = "",
} = {}) {
  const label = threadLabel || "";
  const inConversation = Boolean(viewingConversation && activeThreadId);

  // Projects mode wins only when a project is actually selected; otherwise fall
  // through to the folder rather than showing a bare product name over a real
  // conversation.
  const inProjectsMode = sidebarMode === "projects" && Boolean(projectName);

  let title;
  let titleTooltip;
  if (inProjectsMode) {
    title = projectName;
    titleTooltip = projectName;
  } else if (inConversation && workspaceName) {
    title = workspaceName;
    titleTooltip = workspacePath || workspaceName;
  } else {
    title = "Relay console";
    titleTooltip = "";
  }

  // The New agent button belongs to a project, so it appears exactly where a
  // project is being named — never in Sessions mode, never without a project.
  const newAgentProjectId = inProjectsMode ? projectId || null : null;

  let subtitle;
  if (viewOnly && activeThreadId) {
    // A read-only saved session says so through the transcript itself (and the composer
    // being disabled), so the header does not repeat it. A review IS worth calling out:
    // it explains WHY the session is frozen, which nothing else in the header does.
    subtitle = reviewInProgress ? "read-only · review in progress" : "";
  } else if (inConversation) {
    subtitle = "";
  } else if (activeThreadId) {
    // Console home while a session runs elsewhere — name it without the "live" noise.
    subtitle = label ? `session · ${label}` : "session";
  } else if (hasWorkspace) {
    subtitle = "standby";
  } else {
    subtitle = "no workspace selected";
  }

  return { title, titleTooltip, subtitle, newAgentProjectId };
}
