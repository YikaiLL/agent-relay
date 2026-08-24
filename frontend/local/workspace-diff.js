import React from "react";
import { createRoot } from "react-dom/client";
import { FileChangeDiff } from "../shared/transcript-react.js";
import { RightPanelTabs } from "../shared/right-panel-tabs.js";
import { ThreadWorkspaceField } from "../shared/workspace-picker.js";

const h = React.createElement;

function useStoreState(store) {
  return React.useSyncExternalStore(
    React.useCallback((listener) => store.subscribe(() => listener()), [store]),
    () => store.getState(),
    () => store.getState()
  );
}

// The mobile sheet / remote modal share one panel for both the diff and the
// reviewer, so the header title must follow the active tab — otherwise opening
// the Reviewer chip lands you on a panel still titled "Workspace diff", which
// reads as "it didn't switch". Used by both surfaces' modal wrappers.
export function WorkspaceDiffModalTitle({ store }) {
  const state = useStoreState(store);
  const onReviewer = state.activeTab === "reviewer";
  return h("h2", null, onReviewer ? "Reviewer" : "Workspace diff");
}

export function createWorkspaceDiffStore({
  apiFetch,
  fetchDiff = null,
  // Pin = Review dialog. Changes uses local `viewRoot` so looking does not relocate.
  fetchWorkspace = null,
  setWorkspace = null,
  surface = "local",
  getThreadId = null,
  // Identity of the viewed workspace (thread id + cwd) used to decide when to drop
  // stale data during loading. Falls back to getThreadId when not provided.
  getWorkspaceKey = null,
}) {
  const tabStorageKey = `agent-relay:right-panel-tab:${surface}`;
  const fetchWorkspaceFn =
    fetchWorkspace || (apiFetch ? (threadId) => fetchWorkspaceViaApi(apiFetch, threadId) : null);
  const setWorkspaceFn =
    setWorkspace
    || (apiFetch ? (threadId, cwd) => pinWorkspaceViaApi(apiFetch, threadId, cwd) : null);
  // Ephemeral Diff preview per thread. Never written to the relay.
  const viewRootByThread = new Map();

  function threadKey() {
    const id = typeof getThreadId === "function" ? getThreadId() : null;
    return id ?? "";
  }

  function currentViewRoot() {
    const id = threadKey();
    return id ? viewRootByThread.get(id) || null : null;
  }

  let state = {
    status: "idle",
    data: null,
    error: null,
    expanded: false,
    // ResolvedWorkspace for the viewed thread, or null before first fetch.
    workspace: null,
    workspaceStatus: "idle",
    // Workspace read/pin failure; kept apart from the diff's `error`.
    workspaceError: null,
    workspacePinning: false,
    // Diff preview override (local only). Null means "follow the session workspace".
    viewRoot: null,
    activeTab: readStoredTab(tabStorageKey),
    review: {
      reviewJobs: [],
      workflowRuns: [],
      reviewModel: {},
      workflowModel: {},
      canRequest: false,
      canStartWorkflow: false,
      blocked: false,
    },
  };
  const listeners = new Set();

  function emit() {
    listeners.forEach((listener) => {
      try {
        listener(state);
      } catch (error) {
        console.warn("workspace-diff listener failed", error);
      }
    });
  }

  function setState(patch) {
    state = { ...state, ...patch };
    emit();
  }

  // Monotonic guard: only the most recent refresh may write results. An earlier
  // in-flight request (e.g. issued before a view switch A → B) that resolves late
  // must not overwrite newer data, or the panel would show A's diff while B is viewed.
  let requestSeq = 0;
  // Identity of the viewed workspace (thread id + cwd) at the last refresh. When it
  // changes we drop the previous workspace's data immediately so the load window
  // can't flash it. Keying on thread id alone would miss a same-thread cwd change.
  let lastKey = null;
  // Drop the previous session's tree on a thread switch.
  let lastWorkspaceThread = null;

  // Never throws: a workspace-label failure must not take the diff down.
  async function refreshWorkspace(seq) {
    const threadId = threadKey();
    if (!threadId || !fetchWorkspaceFn) {
      lastWorkspaceThread = threadId;
      setState({
        workspace: null,
        workspaceStatus: "idle",
        workspaceError: null,
        viewRoot: null,
      });
      return;
    }
    const switched = threadId !== lastWorkspaceThread;
    lastWorkspaceThread = threadId;
    setState(
      switched
        ? {
            workspace: null,
            workspaceStatus: "loading",
            workspaceError: null,
            viewRoot: currentViewRoot(),
          }
        : { workspaceStatus: "loading", viewRoot: currentViewRoot() }
    );
    try {
      const resolved = await fetchWorkspaceFn(threadId);
      if (seq !== requestSeq) return; // superseded by a newer refresh
      setState({
        workspace: resolved || null,
        workspaceStatus: "loaded",
        workspaceError: null,
        viewRoot: currentViewRoot(),
      });
    } catch (error) {
      if (seq !== requestSeq) return;
      setState({
        workspaceStatus: "error",
        workspaceError: error?.message || String(error),
        viewRoot: currentViewRoot(),
      });
    }
  }

  async function refresh() {
    const seq = (requestSeq += 1);
    const keyFn =
      typeof getWorkspaceKey === "function"
        ? getWorkspaceKey
        : typeof getThreadId === "function"
          ? getThreadId
          : null;
    const key = JSON.stringify([keyFn ? keyFn() : null, currentViewRoot()]);
    const viewChanged = key !== lastKey;
    lastKey = key;
    // Re-resolve on every refresh: origin can move (new writes, vanished worktree).
    const workspaceDone = refreshWorkspace(seq);
    // Different workspace → clear stale data so we never render another session's
    // changes during the load window. Same workspace (turnDiff / manual refresh) →
    // keep prior data so the panel doesn't flicker on every refresh.
    setState(
      viewChanged
        ? { status: "loading", error: null, data: null, viewRoot: currentViewRoot() }
        : { status: "loading", error: null, viewRoot: currentViewRoot() }
    );
    try {
      const viewRoot = currentViewRoot();
      const data = fetchDiff
        ? await fetchDiff({ viewRoot })
        : await fetchViaApi(apiFetch, getThreadId, viewRoot);
      if (seq !== requestSeq) return; // superseded by a newer refresh
      setState({ status: "loaded", data, error: null });
    } catch (error) {
      if (seq !== requestSeq) return; // superseded by a newer refresh
      setState({
        status: "error",
        error: error?.message || String(error),
      });
    } finally {
      await workspaceDone;
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setExpanded(value) {
      setState({ expanded: Boolean(value) });
    },
    toggleExpanded() {
      setState({ expanded: !state.expanded });
    },
    /// Local Diff preview; never a session pin.
    async setViewRoot(path) {
      const threadId = threadKey();
      if (!threadId) return;
      const next = path || null;
      if (next) {
        viewRootByThread.set(threadId, next);
      } else {
        viewRootByThread.delete(threadId);
      }
      setState({ viewRoot: next, workspaceError: null });
      await refresh();
    },
    /// Durable session pin (Review dialog), not the Changes preview.
    async pinWorkspace(path) {
      const threadId = threadKey();
      if (!threadId || !setWorkspaceFn) return;
      setState({ workspacePinning: true, workspaceError: null });
      try {
        const resolved = await setWorkspaceFn(threadId, path || null);
        if (threadKey() !== threadId) return;
        // Pin is session truth; drop a peeking Diff preview.
        viewRootByThread.delete(threadId);
        setState({
          workspace: resolved || null,
          workspaceStatus: "loaded",
          workspaceError: null,
          viewRoot: null,
        });
        await refresh();
      } catch (error) {
        // Show the refusal next to the picker, not as a silent no-op.
        if (threadKey() !== threadId) return;
        setState({ workspaceError: error?.message || String(error) });
      } finally {
        setState({ workspacePinning: false });
      }
    },
    setActiveTab(tab) {
      const next = tab === "reviewer" ? "reviewer" : "changes";
      if (next === state.activeTab) return;
      writeStoredTab(tabStorageKey, next);
      setState({ activeTab: next });
    },
    setReview(patch) {
      const next = { ...state.review, ...patch };
      // Avoid churn: only emit when the review slice actually changed.
      if (JSON.stringify(next) === JSON.stringify(state.review)) return;
      setState({ review: next });
    },
    refresh,
  };
}

function readStoredTab(key) {
  try {
    if (typeof localStorage === "undefined") return "changes";
    return localStorage.getItem(key) === "reviewer" ? "reviewer" : "changes";
  } catch {
    return "changes";
  }
}

function writeStoredTab(key, value) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    // ignore persistence failures (private mode, etc.)
  }
}

async function fetchViaApi(apiFetch, getThreadId = null, viewRoot = null) {
  // Default = session workspace; `viewRoot` is preview only.
  const threadId = typeof getThreadId === "function" ? getThreadId() : null;
  const params = new URLSearchParams();
  if (threadId) params.set("thread_id", threadId);
  if (viewRoot) params.set("view_root", viewRoot);
  const qs = params.toString();
  const path = qs ? `/api/workspace/diff?${qs}` : "/api/workspace/diff";
  const response = await apiFetch(path, { method: "GET" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  }
  return payload.data;
}

// Local operator has no device_id; relay scopes to relay-wide allowed_roots.
async function fetchWorkspaceViaApi(apiFetch, threadId) {
  return unwrap(
    await apiFetch(`/api/thread/workspace?thread_id=${encodeURIComponent(threadId)}`, {
      method: "GET",
    })
  );
}

// Always send `cwd` (`null` unpins); omitting it would look like a no-op.
async function pinWorkspaceViaApi(apiFetch, threadId, cwd) {
  return unwrap(
    await apiFetch("/api/thread/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: threadId, cwd: cwd || null }),
    })
  );
}

async function unwrap(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  }
  return payload.data;
}

export function computeChangeStats(data) {
  const fileChanges = data?.file_changes || [];
  let added = 0;
  let removed = 0;
  for (const change of fileChanges) {
    const counts = countDiffLines(change?.diff || "");
    added += counts.added;
    removed += counts.removed;
  }
  return { fileCount: fileChanges.length, added, removed };
}

function countDiffLines(diff) {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

export function mountChangesPanel({ store, mount, reviewer = {}, panelId = "review-panel-rail" }) {
  if (!mount) return null;
  const root = createRoot(mount);
  root.render(
    h(RightPanelTabs, {
      store,
      panelId,
      reviewer,
      changes: h(WorkspaceChangesPanel, { store }),
    })
  );
  return {
    destroy() {
      root.unmount();
    },
  };
}

export function mountChip({ store, mount, onTap }) {
  if (!mount) return null;
  const root = createRoot(mount);
  root.render(h(WorkspaceDiffChip, { store, onTap }));
  return {
    destroy() {
      root.unmount();
    },
  };
}

export function createWorkspaceDiffSheet({
  store,
  mount,
  modal,
  closeButton,
  titleMount,
  reviewer = {},
  panelId = "review-panel-sheet",
}) {
  if (!mount || !modal) return null;
  const root = createRoot(mount);
  root.render(
    h(RightPanelTabs, {
      store,
      panelId,
      reviewer,
      changes: h(WorkspaceDiffSheetBody, { store }),
    })
  );
  // Title follows the active tab (Workspace diff / Reviewer); mounted as its own
  // root so the static modal shell never fights it on re-render.
  const titleRoot = titleMount ? createRoot(titleMount) : null;
  titleRoot?.render(h(WorkspaceDiffModalTitle, { store }));

  function open() {
    if (typeof modal.showModal === "function") {
      modal.showModal();
    } else {
      modal.setAttribute("open", "");
    }
    void store.refresh();
  }

  function close() {
    if (typeof modal.close === "function") {
      modal.close();
    } else {
      modal.removeAttribute("open");
    }
  }

  closeButton?.addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      close();
    }
  });

  return {
    open,
    close,
    destroy() {
      root.unmount();
      titleRoot?.unmount();
    },
  };
}

export function WorkspaceChangesPanel({ store }) {
  const state = useStoreState(store);
  const stats = computeChangeStats(state.data);
  const expanded = state.expanded;
  // No "Environment" eyebrow band: the tab strip directly above already says
  // "Changes", so a second full-width header only stacked chrome on top of the
  // list without naming anything new.
  return h(
    "section",
    { className: "workspace-changes-panel" },
    h(WorkspaceTreeBar, { store, state }),
    h(
      "div",
      { className: "workspace-changes-list" },
      h(WorkspaceChangesEntry, { store, state, stats, expanded })
    )
  );
}

// Changes picker is a Diff preview; it does not pin the session.
export function WorkspaceTreeBar({ store, state }) {
  const workspace = state.workspace || null;
  const viewRoot = state.viewRoot || null;
  const previewing =
    Boolean(viewRoot) &&
    workspace?.cwd &&
    viewRoot !== workspace.cwd;
  const displayWorkspace = workspace
    ? {
        ...workspace,
        // Preview cwd for the picker; origin still describes the session.
        cwd: viewRoot || workspace.cwd,
        git: previewing ? null : workspace.git,
      }
    : null;
  return h(ThreadWorkspaceField, {
    busy: false,
    error: state.workspaceError || null,
    fallbackFrom: state.data?.fallback_from || null,
    followLabel: "Follow session",
    followTitle: "Show the session's working tree again (does not change a pin)",
    label: previewing ? "Viewing" : null,
    onPin: null,
    onView: (path) => store.setViewRoot?.(path),
    previewing,
    workspace: displayWorkspace,
  });
}

function RefreshIcon() {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      fill: "none",
      height: "14",
      viewBox: "0 0 16 16",
      width: "14",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    h("path", { d: "M13.5 3.5v3.5h-3.5" }),
    h("path", { d: "M13.1 7A5.5 5.5 0 1 0 12.5 11.5" })
  );
}

function WorkspaceChangesEntry({ store, state, stats, expanded }) {
  const isLoading = state.status === "loading";
  const isError = state.status === "error";
  const expandLabel = expanded ? "Collapse workspace diff" : "Expand workspace diff";
  function handleRowKey(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      store.toggleExpanded();
    }
  }
  return h(
    "div",
    { className: `workspace-changes-entry${expanded ? " is-expanded" : ""}` },
    h(
      "div",
      {
        className: "workspace-changes-row",
        onClick: (event) => {
          if (event.target.closest("[data-workspace-changes-skip]")) return;
          store.toggleExpanded();
        },
        onKeyDown: handleRowKey,
        role: "button",
        tabIndex: 0,
        "aria-expanded": expanded ? "true" : "false",
        "aria-label": expandLabel,
      },
      // Disclosure caret leads now, so the row reads as the small section header
      // it has become rather than a list item with a control parked on the end.
      h(
        "span",
        { className: "workspace-changes-row-chevron", "aria-hidden": "true" },
        expanded ? "▾" : "▸"
      ),
      h(
        "span",
        { className: "workspace-changes-row-main" },
        // Always the workspace git working tree (path-scoped, never session-scoped) — name
        // that subject so it doesn't read as "the current agent's output" when idle. Matches
        // the modal's "Workspace diff" title.
        h("span", { className: "workspace-changes-row-label" }, "Workspace changes"),
        renderStatsBadge(state, stats)
      ),
      h(
        "button",
        {
          type: "button",
          className: `workspace-changes-refresh${isLoading ? " is-loading" : ""}`,
          onClick: (event) => {
            event.stopPropagation();
            void store.refresh();
          },
          disabled: isLoading,
          title: isLoading ? "Refreshing…" : "Refresh",
          "aria-label": isLoading ? "Refreshing workspace diff" : "Refresh workspace diff",
          "data-workspace-changes-skip": "true",
        },
        h(RefreshIcon)
      )
    ),
    expanded
      ? h(
          "div",
          { className: "workspace-changes-body" },
          // Only here: the desktop right rail is the narrow surface the compact
          // row (status glyph, directory-first truncation, right-aligned stats)
          // was designed for.
          renderDiffContent(state, "rail")
        )
      : null,
    !expanded && isError
      ? h(
          "p",
          { className: "workspace-changes-error-inline" },
          `Failed to load: ${state.error}`
        )
      : null
  );
}

function renderStatsBadge(state, stats) {
  if (state.status === "idle" && !state.data) {
    return h("span", { className: "workspace-changes-row-pending" }, "—");
  }
  if (state.status === "loading" && !state.data) {
    return h("span", { className: "workspace-changes-row-pending" }, "…");
  }
  if (state.data?.unavailable) {
    return h("span", { className: "workspace-changes-row-empty" }, "—");
  }
  if (state.data?.not_a_git_repo) {
    return h("span", { className: "workspace-changes-row-empty" }, "no git");
  }
  if (stats.fileCount === 0) {
    return h("span", { className: "workspace-changes-row-empty" }, "clean");
  }
  return h(
    "span",
    { className: "workspace-changes-row-stats" },
    stats.added > 0
      ? h("span", { className: "workspace-changes-add" }, `+${stats.added}`)
      : null,
    stats.removed > 0
      ? h("span", { className: "workspace-changes-del" }, `-${stats.removed}`)
      : null
  );
}

// `variant` stays the CALLER's choice even though both current callers pass
// "rail": the transcript renders file changes through the same component, and
// defaulting to the wide card is what keeps a future caller from silently
// inheriting a layout nobody checked on that surface.
function renderDiffContent(state, variant = "transcript") {
  if (state.status === "loading" && !state.data) {
    return h("p", { className: "diff-file-empty" }, "Loading…");
  }
  if (state.status === "error" && !state.data) {
    return h(
      "p",
      { className: "diff-file-empty" },
      `Failed to load diff: ${state.error}`
    );
  }
  const data = state.data;
  if (!data) {
    return h("p", { className: "diff-file-empty" }, "No data yet.");
  }
  if (data.unavailable) {
    return h(
      "p",
      { className: "diff-file-empty" },
      "Workspace unavailable — this session isn’t loaded yet or has no workspace."
    );
  }
  if (data.not_a_git_repo) {
    return h(
      "p",
      { className: "diff-file-empty" },
      "This workspace is not a git repository."
    );
  }
  const fileChanges = data.file_changes || [];
  if (fileChanges.length === 0) {
    return h(
      "p",
      { className: "diff-file-empty" },
      "Working tree is clean — no uncommitted changes."
    );
  }
  return h(FileChangeDiff, {
    variant,
    tool: {
      item_type: "workspaceDiff",
      file_changes: fileChanges,
      diff: data.diff,
      display_options: { currentCwd: data.cwd },
    },
  });
}

const TERMINAL_REVIEW = new Set(["complete", "failed", "cancelled"]);

// The "Changes" entry point on mobile — pure file-diff stats. Review state lives
// on the separate ReviewerChip so each pill is a single, self-describing target.
export function WorkspaceDiffChip({ store, onTap }) {
  const state = useStoreState(store);
  const stats = computeChangeStats(state.data);
  const isClean = state.status === "loaded" && stats.fileCount === 0;
  const notRepo = state.data?.not_a_git_repo;
  const unavailable = state.data?.unavailable;
  if (notRepo || unavailable) return null;
  if (state.status === "idle" && !state.data) return null;
  if (isClean) return null;
  return h(
    "button",
    {
      type: "button",
      className: "workspace-diff-chip",
      onClick: () => onTap?.(),
      title: "Tap to view file diffs",
    },
    h(
      "span",
      { className: "workspace-diff-chip-label" },
      stats.fileCount === 1 ? "1 file" : `${stats.fileCount} files`
    ),
    h("span", { className: "workspace-diff-chip-sep" }, "·"),
    stats.added > 0
      ? h("span", { className: "workspace-diff-chip-add" }, `+${stats.added}`)
      : null,
    stats.removed > 0
      ? h("span", { className: "workspace-diff-chip-del" }, `−${stats.removed}`)
      : null
  );
}

// A dedicated, self-describing "Reviewer" pill for mobile (the desktop rail has
// the tab instead). It surfaces whenever there's a review to see OR one can be
// started, and tapping it opens the right panel straight on the Reviewer tab.
// Shares `.workspace-diff-chip` base styles so it's mobile-only and pill-shaped.
export function ReviewerChip({ store, onTap }) {
  const state = useStoreState(store);
  const review = state.review || {};
  const reviewJobs = review.reviewJobs || [];
  const workflowRuns = review.workflowRuns || [];
  const blocked = Boolean(review.blocked);
  const active = reviewJobs.some((job) => !TERMINAL_REVIEW.has(job.status));
  const activeWorkflow = workflowRuns.some(
    (run) => !["done", "escalated", "failed", "interrupted", "cancelled"].includes(run.status)
  );
  const hasReviews = reviewJobs.length > 0 || workflowRuns.length > 0;
  // Only surface once there's an actual review to track (in progress / blocked /
  // done) — that's when the status badge carries signal. In the pure-idle "you
  // could start one" state the chip says nothing and just competes for composer
  // space with the diff chip and the "Want a second opinion?" idle nudge already
  // shown there, so stay hidden and let those handle discovery + launch.
  if (!hasReviews) return null;
  const badge = blocked ? "⚠" : active || activeWorkflow ? "•" : hasReviews ? "✓" : null;
  const modifier = blocked
    ? "is-blocked"
    : active || activeWorkflow
    ? "is-active"
    : hasReviews
    ? "is-done"
    : "is-idle";
  const title = blocked
    ? "Review blocked — tap to resolve"
    : active || activeWorkflow
    ? "Review workflow in progress — tap to view"
    : hasReviews
    ? "Review complete — tap to view findings"
    : "Ask another agent to review — tap to start";
  return h(
    "button",
    {
      type: "button",
      className: `workspace-diff-chip reviewer-chip ${modifier}`,
      onClick: () => onTap?.(),
      title,
    },
    h("span", { className: "reviewer-chip-icon", "aria-hidden": "true" }, "🔍"),
    h("span", { className: "workspace-diff-chip-label" }, "Reviewer"),
    badge
      ? h(
          "span",
          { className: `workspace-diff-chip-review ${modifier}`, "aria-hidden": "true" },
          badge
        )
      : null
  );
}

export function mountReviewerChip({ store, mount, onTap }) {
  if (!mount) return null;
  const root = createRoot(mount);
  root.render(h(ReviewerChip, { store, onTap }));
  return {
    destroy() {
      root.unmount();
    },
  };
}

export function WorkspaceDiffSheetBody({ store }) {
  const state = useStoreState(store);
  const isLoading = state.status === "loading";
  return h(
    "div",
    { className: "workspace-diff-sheet-body" },
    // Refresh lives WITH the diff (not in the modal header) so it's obviously
    // scoped to the diff — the header "Refresh" used to read as a global/session
    // refresh and showed even on the Reviewer tab where it does nothing. This body
    // only renders on the Changes tab, so the button is inherently diff-scoped.
    h(
      "div",
      { className: "workspace-diff-sheet-toolbar" },
      h(
        "button",
        {
          type: "button",
          className: `workspace-diff-sheet-refresh${isLoading ? " is-loading" : ""}`,
          onClick: () => void store.refresh(),
          disabled: isLoading,
          title: isLoading ? "Refreshing…" : "Refresh diff",
          "aria-label": isLoading ? "Refreshing workspace diff" : "Refresh workspace diff",
        },
        h(RefreshIcon),
        h(
          "span",
          { className: "workspace-diff-sheet-refresh-label" },
          isLoading ? "Refreshing…" : "Refresh diff"
        )
      )
    ),
    h(WorkspaceTreeBar, { store, state }),
    state.data?.truncated
      ? h(
          "div",
          { className: "workspace-diff-status" },
          h("span", { className: "workspace-diff-warning" }, "Output truncated (large diff).")
        )
      : null,
    // Same compact row as the rail, so the panel reads identically on desktop
    // and phone. `.workspace-diff-sheet-body` is what scales it up to touch
    // targets — this surface is only ever reached from the mobile chip.
    renderDiffContent(state, "rail")
  );
}
