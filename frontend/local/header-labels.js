// The session header's title + subtitle text as ONE pure decision — mirroring
// status-badge.js, so the "what does the header say" rules live in a single tested
// place instead of drifting across inline branches in renderHeader.
//
// Product decisions encoded here (deliberate, not incidental):
//  - The title is the THREAD you're viewing, never the workspace basename. The
//    workspace name dominated every screen and duplicates the repo/branch context
//    that belongs on the changes surface, not the title bar.
//  - "live" is gone: for a live conversation it carried no signal (if you can type,
//    it's live) and it collided with the run-state badge ("Idle") right beside it.
//  - "read-only" stays: it's a real warning (the composer is disabled). The label is
//    in the title now, so the subtitle no longer repeats it.
export function selectHeaderLabels({
  hasWorkspace = false,
  activeThreadId = null,
  viewingConversation = false,
  viewOnly = false,
  reviewInProgress = false,
  threadLabel = "",
} = {}) {
  const label = threadLabel || "";
  const inConversation = Boolean(viewingConversation && activeThreadId);

  const title = inConversation && label ? label : "Relay console";

  let subtitle;
  if (viewOnly && activeThreadId) {
    subtitle = reviewInProgress ? "read-only · review in progress" : "read-only · saved session";
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

  return { title, subtitle };
}
