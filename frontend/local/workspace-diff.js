import React from "react";
import { createRoot } from "react-dom/client";
import { FileChangeDiff } from "../shared/transcript-react.js";
import { RightPanelTabs } from "../shared/right-panel-tabs.js";

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
  surface = "local",
  getThreadId = null,
  // Identity of the viewed workspace (thread id + cwd) used to decide when to drop
  // stale data during loading. Falls back to getThreadId when not provided.
  getWorkspaceKey = null,
}) {
  const tabStorageKey = `agent-relay:right-panel-tab:${surface}`;
  // Which worktree root each thread is pinned to. Keyed PER THREAD on purpose: a root
  // picked while viewing A must not follow you to B, whose repo may not even contain
  // that path — the panel would then show a completely unrelated tree. `null`/absent
  // means "that thread's own workspace cwd", which is what the server defaults to.
  const rootByThread = new Map();
  // Roots the RELAY suggested, kept apart from the user's own picks above. The
  // distinction matters on re-entry: a user's choice is theirs and must survive
  // leaving and returning, while an auto pin is just a cached answer to "where is this
  // thread working?" and has to be re-asked — otherwise an agent that moved from one
  // worktree to another while you were away stays invisible behind the stale pin.
  const autoRootByThread = new Map();
  // Threads whose one-shot auto-resolve has already run. Deliberately once per thread
  // SWITCH, not per refresh: the relay can tell us where a thread has been writing on
  // every fetch, but acting on that every time would let the panel re-target itself
  // while someone is reading it. So we ask once on entering a thread, and from then on
  // it is an ordinary pin — while leaving and returning re-arms it, so a worktree the
  // agent moved into while you were away is still picked up.
  const autoResolved = new Set();
  // Which thread the previous refresh was for, so entering a thread can re-arm it.
  let lastAutoThread = null;

  function threadKey() {
    const id = typeof getThreadId === "function" ? getThreadId() : null;
    return id ?? "";
  }

  // The user's pick wins over anything derived.
  function currentRoot() {
    const key = threadKey();
    return rootByThread.get(key) ?? autoRootByThread.get(key) ?? null;
  }

  function manualRoot() {
    return rootByThread.get(threadKey()) ?? null;
  }

  let state = {
    status: "idle",
    data: null,
    error: null,
    expanded: false,
    selectedRoot: null,
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
  async function refresh() {
    const seq = (requestSeq += 1);
    const keyFn =
      typeof getWorkspaceKey === "function"
        ? getWorkspaceKey
        : typeof getThreadId === "function"
          ? getThreadId
          : null;
    // The selected root is part of the viewed-workspace identity: switching root is
    // just as much a view change as switching thread, and must drop the previous
    // root's diff rather than paint it into the new root's panel while it loads.
    // Entering a thread re-arms its one-shot AND drops the previously derived root, so
    // the question is genuinely re-asked rather than answered from a stale cache.
    if (threadKey() !== lastAutoThread) {
      autoResolved.delete(threadKey());
      autoRootByThread.delete(threadKey());
      lastAutoThread = threadKey();
    }
    // Only a thread with no pick OF THE USER'S asks the relay where it has been
    // writing; a previous auto answer must not suppress the new question. Auto-resolve
    // is a per-thread notion, so the no-thread (legacy/global) fetch never opts in.
    const wantsAuto = !manualRoot() && !!threadKey() && !autoResolved.has(threadKey());
    // Read the effective root only after the re-arm above, so a dropped auto pin is not
    // resent.
    const root = currentRoot();
    const key = JSON.stringify([keyFn ? keyFn() : null, root]);
    const viewChanged = key !== lastKey;
    lastKey = key;
    // Different workspace → clear stale data so we never render another session's
    // changes during the load window. Same workspace (turnDiff / manual refresh) →
    // keep prior data so the panel doesn't flicker on every refresh.
    setState(
      viewChanged
        ? { status: "loading", error: null, data: null, selectedRoot: root }
        : { status: "loading", error: null, selectedRoot: root }
    );
    try {
      const data = fetchDiff
        ? await fetchDiff(root, wantsAuto)
        : await fetchViaApi(apiFetch, getThreadId, root, wantsAuto);
      if (seq !== requestSeq) return; // superseded by a newer refresh
      if (wantsAuto) {
        // Spend the one shot only on a DETERMINED answer. `suggested_root_known: false`
        // means the thread's transcript had not loaded yet, so "no suggestion" is not an
        // answer — spending the shot there would strand the thread on its own cwd.
        if (data?.suggested_root_known !== false) {
          autoResolved.add(threadKey());
        }
        if (data?.suggested_root) {
          // Derived, not chosen: stored separately so re-entry can re-ask.
          autoRootByThread.set(threadKey(), data.suggested_root);
          setState({ selectedRoot: currentRoot() });
        }
      }
      // A pinned root the relay refuses (worktree removed/pruned, or this thread moved
      // to another repo) comes back `unavailable` and — by the fail-closed contract —
      // carries no roots. The picker hides itself without them, so the pin would be
      // unreachable AND resent on every later refresh. Drop it and retry unpinned; the
      // session's own workspace always resolves. Only ever retries when a pin WAS set,
      // so the unpinned response below is terminal.
      if (data?.unavailable && root) {
        rootByThread.delete(threadKey());
        autoRootByThread.delete(threadKey());
        // Burn the auto-resolve too: recovery should land plainly on the session
        // workspace, not bounce straight into re-pinning somewhere else.
        autoResolved.add(threadKey());
        setState({ selectedRoot: null });
        return refresh();
      }
      setState({ status: "loaded", data, error: null });
    } catch (error) {
      if (seq !== requestSeq) return; // superseded by a newer refresh
      // Same self-heal for a hard failure on a pinned root: an error response also
      // leaves no picker to recover through.
      if (root) {
        rootByThread.delete(threadKey());
        autoRootByThread.delete(threadKey());
        autoResolved.add(threadKey());
        setState({ selectedRoot: null });
        return refresh();
      }
      // Auto-resolve is best effort. If the opted-in request itself failed, retry once
      // without it rather than surfacing an error the user cannot act on — and burn the
      // shot so a persistently rejected auto cannot fail on every future refresh.
      if (wantsAuto) {
        autoResolved.add(threadKey());
        return refresh();
      }
      setState({
        status: "error",
        error: error?.message || String(error),
      });
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
    getSelectedRoot: () => currentRoot(),
    /// Pin the viewed thread to a worktree root. Falsy clears the pin, returning the
    /// panel to that thread's own workspace cwd.
    setRoot(path) {
      const key = threadKey();
      // An explicit pick supersedes the derived one, and clearing it means "go back to
      // the session workspace" — not "fall back to whatever was auto-detected".
      autoRootByThread.delete(key);
      if (path) rootByThread.set(key, path);
      else rootByThread.delete(key);
      setState({ selectedRoot: currentRoot() });
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

async function fetchViaApi(apiFetch, getThreadId = null, root = null, autoRoot = false) {
  // Diff the session the user is *viewing*, not the process-global/active one.
  const threadId = typeof getThreadId === "function" ? getThreadId() : null;
  const params = new URLSearchParams();
  if (threadId) params.set("thread_id", threadId);
  // Absent → the session's own cwd. The server validates any root against the
  // worktrees it enumerated for that session, so a stale pin fails closed.
  if (root) params.set("root", root);
  // One-shot opt-in: land on where this thread has actually been writing. Must be
  // "true", not "1": the relay deserializes this as a Rust bool via serde_urlencoded,
  // which accepts only true/false and 400s on anything else.
  if (autoRoot) params.set("auto_root", "true");
  const query = params.toString();
  const path = query ? `/api/workspace/diff?${query}` : "/api/workspace/diff";
  const response = await apiFetch(path, { method: "GET" });
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
    h(WorkspaceRootPicker, { store, state }),
    h(
      "div",
      { className: "workspace-changes-list" },
      h(WorkspaceChangesEntry, { store, state, stats, expanded })
    )
  );
}

// The server substitutes a workspace when the one a session ran in has stopped existing
// (an agent worktree removed once its work landed). That beats the raw
// `git rev-parse ... (os error 2)` it used to surface, but it must never be silent: an
// unlabelled fallback reads as "this session's changes" while showing another tree's.
function FallbackWorkspaceNote({ state }) {
  const from = state.data?.fallback_from;
  if (!from) return null;
  const gone = basename(from);
  const shown = basename(state.data?.cwd || "");
  return h(
    "p",
    { className: "workspace-changes-fallback-note", title: `${from} → ${state.data?.cwd || ""}` },
    shown
      ? `Worktree ${gone} no longer exists — showing ${shown} instead.`
      : `Worktree ${gone} no longer exists.`
  );
}

function basename(path) {
  return path.split("/").filter(Boolean).pop() || path;
}

function rootLabel(root) {
  const name = basename(root.path);
  const branch = root.branch || "detached";
  return root.is_main ? `${branch} · ${name}` : `${branch} · ${name} (worktree)`;
}

// Lets the user point the diff at any working tree of the viewed session's repo —
// the case this exists for is an agent that went off and worked in a `git worktree`,
// whose changes are invisible from the session's own cwd. Hidden for the common
// single-worktree repo, where a one-entry picker would be pure noise.
function WorkspaceRootPicker({ store, state }) {
  const roots = state.data?.roots || [];
  if (roots.length < 2) return null;
  return h(
    "div",
    { className: "workspace-root-picker" },
    h(
      "select",
      {
        className: "workspace-root-select",
        // `selectedRoot` is the explicit pin; empty means "follow the session's cwd".
        value: state.selectedRoot || "",
        "aria-label": "Which working tree to show changes for",
        onChange: (event) => {
          store.setRoot(event.target.value || null);
          void store.refresh();
        },
      },
      h("option", { value: "" }, "Session workspace (auto)"),
      roots.map((root) =>
        h("option", { key: root.path, value: root.path }, rootLabel(root))
      )
    )
  );
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
    // Shown whether or not the row is expanded: which tree these stats belong to is
    // exactly the thing a collapsed row hides.
    h(FallbackWorkspaceNote, { state }),
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
    state.data?.cwd
      ? h(
          "div",
          { className: "workspace-diff-status" },
          h(
            "span",
            { className: "workspace-diff-cwd", title: state.data.cwd },
            state.data.cwd
          ),
          state.data?.truncated
            ? h(
                "span",
                { className: "workspace-diff-warning" },
                "Output truncated (large diff)."
              )
            : null
        )
      : null,
    h(FallbackWorkspaceNote, { state }),
    // Same compact row as the rail, so the panel reads identically on desktop
    // and phone. `.workspace-diff-sheet-body` is what scales it up to touch
    // targets — this surface is only ever reached from the mobile chip.
    renderDiffContent(state, "rail")
  );
}
