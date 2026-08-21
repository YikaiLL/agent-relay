// The Task screen: a full-area, non-chat view of the three-role team runs.
//
// Presentational only. Every piece of data is a prop and every mutation is a
// callback; fetching, caching and navigation live in the caller. Mirrors the
// shape of `project-overview-react.js`, which is the other full-area view.

import React from "react";

import {
  availableTeamActions,
  canTalkToTeamLead,
  currentSubTask,
  isTerminalSubTaskStatus,
  isTerminalTeamStatus,
  teamAttention,
  teamPhaseLabel,
  teamRunProgress,
  teamSeats,
  teamStatusLabel,
  teamStatusTone,
  TEAM_ACTION_HINTS,
  TEAM_ACTION_LABELS,
} from "./task-team-model.js";

const h = React.createElement;

function BranchGlyph() {
  return h(
    "svg",
    { viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" },
    h("path", {
      d: "M5 3.5v9M5 3.5a1.5 1.5 0 1 0 0-.001zM5 12.5a1.5 1.5 0 1 0 0 .001zM11 6.5a1.5 1.5 0 1 0 0-.001zM11 8v.5A3.5 3.5 0 0 1 7.5 12H5",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.4",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    })
  );
}

function BackGlyph() {
  return h(
    "svg",
    { viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" },
    h("path", {
      d: "M10 3.5 5.5 8l4.5 4.5",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.6",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    })
  );
}

function StatusPill({ status }) {
  const tone = teamStatusTone(status);
  return h(
    "span",
    {
      className: `task-status-pill${tone ? ` is-${tone}` : ""}`,
      title: teamStatusLabel(status),
    },
    teamStatusLabel(status)
  );
}

// ---- the beta lock ---------------------------------------------------------

/**
 * What the Task screen looks like on a relay without `--beta`.
 *
 * The skeleton is invented — no datum here comes from the relay, and the caller
 * never fetches while locked. Blur is one devtools click from gone, so the gate
 * is that the data was never sent. `aria-hidden` keeps a screen reader from
 * reading the fake titles out as the user's own.
 */
function TaskLockedPreview() {
  // Enough rows to run past the card's edges; a skeleton hidden entirely behind
  // it reads as an empty screen.
  const rows = [
    { title: "Rework the export pipeline", meta: "4/7 sub-tasks", tone: "running" },
    { title: "Tighten the retry budget", meta: "Needs you", tone: "blocked" },
    { title: "Split the settings drawer", meta: "Reviewing", tone: "running" },
    { title: "Backfill the migration tests", meta: "6/6 sub-tasks", tone: "done" },
    { title: "Trim the cold-start path", meta: "Planning", tone: "running" },
    { title: "Retire the legacy uploader", meta: "2/9 sub-tasks", tone: "running" },
  ];
  return h(
    "div",
    { className: "task-screen task-screen-centered task-locked" },
    h(
      "div",
      { className: "task-locked-scenery", "aria-hidden": "true" },
      h(
        "div",
        { className: "task-locked-rows" },
        ...rows.map((row, index) =>
          h(
            "div",
            { key: index, className: "task-locked-row" },
            h("span", { className: `task-sidebar-dot is-${row.tone}` }),
            h(
              "span",
              { className: "task-locked-row-body" },
              h("span", { className: "task-locked-row-title" }, row.title),
              h("span", { className: "task-locked-row-meta" }, row.meta)
            )
          )
        )
      )
    ),
    h(
      "div",
      { className: "task-locked-notice", role: "status" },
      h("h2", { className: "task-locked-title" }, "Tasks is in development"),
      h(
        "p",
        { className: "task-locked-lede" },
        "A task will be a written brief worked by a small team of agents, on its own branch, while you do something else. It is not finished yet, so it is switched off here."
      ),
      h(
        "p",
        { className: "task-locked-hint" },
        "Building on sealwire? Relaunch with ",
        h("code", null, "sealwire --beta"),
        " to try it early."
      )
    )
  );
}

// ---- list ------------------------------------------------------------------

/**
 * The main area while no task is selected.
 *
 * There is no card list here any more — the sidebar owns the list, and two lists
 * on one screen means the user has to work out which one is authoritative. What
 * belongs in this space instead is the one thing a list cannot say: what a task
 * IS, for someone who has never started one.
 */
export function TaskWelcome({ runs, loading, error, onStartTask }) {
  if (error && !runs) {
    return h(
      "div",
      { className: "task-screen task-screen-centered" },
      h(
        "div",
        { className: "task-screen-empty" },
        h("h3", null, "Tasks unavailable"),
        h("p", null, String(error))
      )
    );
  }
  if (loading && !runs) {
    return h(
      "div",
      { className: "task-screen task-screen-centered" },
      h("div", { className: "task-screen-empty" }, h("p", null, "Loading tasks…"))
    );
  }

  const hasTasks = Boolean(runs?.length);
  return h(
    "div",
    { className: "task-screen task-screen-centered" },
    h(
      "div",
      { className: "task-welcome" },
      h("h2", { className: "task-welcome-title" }, hasTasks ? "Pick a task" : "Start a task"),
      h(
        "p",
        { className: "task-welcome-lede" },
        hasTasks
          ? "Choose one on the left to see what its team is doing."
          : "A task is a written brief worked by a three-role team, in its own git worktree on its own branch. Nothing touches your working tree until you merge it."
      ),
      hasTasks
        ? null
        : h(
            "ol",
            { className: "task-welcome-steps" },
            h(
              "li",
              null,
              h("b", null, "Team lead"),
              " reads the brief, judges the size, and splits it into sub-tasks."
            ),
            h("li", null, h("b", null, "Developer"), " builds one sub-task, with a fresh session each time."),
            h("li", null, h("b", null, "Reviewer"), " checks the work against your scope and rules."),
            h("li", null, "You get a branch, commits and a report — and a question if the team needs one.")
          ),
      h(
        "button",
        { type: "button", className: "task-screen-start", onClick: () => onStartTask?.() },
        "New task"
      )
    )
  );
}

// ---- the sidebar list ------------------------------------------------------

/**
 * The task list, in the sidebar, where the session list lives on the other tab.
 *
 * Deliberately NOT the same component as the main-area cards: this is a
 * navigation column, so a row is one line of identity plus one signal, and the
 * detail belongs on the right. Sharing a component would have forced the cards
 * to shrink until they said nothing.
 */
export function TaskSidebarList({
  runs,
  loading,
  error = null,
  selectedRunId,
  onOpenTask,
  onStartTask,
  locked = false,
}) {
  // No "+ New task" while locked — the server would refuse it.
  if (locked) {
    return h(
      "div",
      { className: "task-sidebar task-locked" },
      h(
        "div",
        { className: "task-locked-scenery", "aria-hidden": "true" },
        h("div", { className: "task-locked-bar" }),
        h("div", { className: "task-locked-bar" }),
        h("div", { className: "task-locked-bar" })
      ),
      h("p", { className: "task-sidebar-empty" }, "In development")
    );
  }
  const list = runs || [];
  return h(
    "div",
    { className: "task-sidebar" },
    h(
      "button",
      { type: "button", className: "task-sidebar-new", onClick: () => onStartTask?.() },
      h("span", { className: "task-sidebar-new-plus" }, "+"),
      "New task"
    ),
    // The error outranks the loading state. Without it a persistent failure reads
    // as "Loading…" here forever while the main area says the relay is
    // unreachable — the two halves of one screen disagreeing about one fetch.
    !runs && error
      ? h("p", { className: "task-sidebar-empty is-error" }, "Tasks unavailable.")
      : !runs && loading
        ? h("p", { className: "task-sidebar-empty" }, "Loading…")
      : list.length
        ? h(
            "div",
            { className: "task-sidebar-rows" },
            ...list.map((run) => {
              const attention = teamAttention(run);
              const progress = teamRunProgress(run);
              const tone = teamStatusTone(run.status);
              return h(
                "button",
                {
                  key: run.team_run_id,
                  type: "button",
                  className: [
                    "task-sidebar-row",
                    run.team_run_id === selectedRunId ? "is-selected" : "",
                    attention?.kind === "needs_input" ? "is-attention" : "",
                    isTerminalTeamStatus(run.status) ? "is-terminal" : "",
                  ]
                    .filter(Boolean)
                    .join(" "),
                  title: run.title || "Untitled task",
                  onClick: () => onOpenTask?.(run.team_run_id),
                },
                h("span", { className: `task-sidebar-dot${tone ? ` is-${tone}` : ""}` }),
                h(
                  "span",
                  { className: "task-sidebar-body" },
                  h("span", { className: "task-sidebar-title" }, run.title || "Untitled task"),
                  h(
                    "span",
                    { className: "task-sidebar-meta" },
                    attention?.kind === "needs_input"
                      ? "Needs you"
                      : progress.total
                        ? `${progress.done}/${progress.total} sub-tasks`
                        : teamPhaseLabel(run.phase) || teamStatusLabel(run.status)
                  )
                )
              );
            })
          )
        : h(
            "p",
            { className: "task-sidebar-empty" },
            "No tasks yet. A task runs on its own branch while you do something else."
          )
  );
}

// ---- the team diagram ------------------------------------------------------

function SeatNode({ seat, onOpenThread }) {
  const openable = Boolean(seat.threadId);
  const stateClass = seat.state ? ` is-${seat.state}` : "";
  return h(
    "button",
    {
      type: "button",
      className: `team-seat${stateClass}${openable ? "" : " is-empty"}`,
      disabled: !openable,
      title: openable
        ? `Open ${seat.label}'s transcript`
        : `${seat.label} has not been seated yet`,
      onClick: () => (openable ? onOpenThread?.(seat.threadId) : undefined),
    },
    h(
      "span",
      { className: "team-seat-head" },
      h("span", { className: "team-seat-dot" }),
      h("span", { className: "team-seat-role" }, seat.label)
    ),
    h(
      "span",
      { className: "team-seat-note" },
      seat.state === "needs_input"
        ? "Waiting on you"
        : seat.state === "working"
          ? "Working"
          : seat.state === "reviewing"
            ? "Reviewing"
            : openable
              ? "Idle"
              : "Not started"
    ),
    seat.subTaskTitle
      ? h("span", { className: "team-seat-subtask" }, seat.subTaskTitle)
      : null
  );
}

export function TeamDiagram({ run, onOpenThread }) {
  const seats = teamSeats(run);
  return h(
    "section",
    { className: "team-diagram", "aria-label": "The team" },
    ...seats.map((seat) => h(SeatNode, { key: seat.role, seat, onOpenThread }))
  );
}

// ---- detail ----------------------------------------------------------------

function SubTaskRow({ task, isCurrent }) {
  return h(
    "li",
    {
      className: `task-subtask${isCurrent ? " is-current" : ""}${
        isTerminalSubTaskStatus(task.status) ? " is-settled" : ""
      }`,
    },
    h("span", { className: `task-subtask-dot is-${task.status}` }),
    h(
      "span",
      { className: "task-subtask-body" },
      h("span", { className: "task-subtask-title" }, task.title || task.id),
      task.result_summary
        ? h("span", { className: "task-subtask-summary" }, task.result_summary)
        : null
    ),
    // Finished is not the same as folded in. The run leaves this phase only
    // once every sub-task is `digested` (state/app/team.rs:2451-2492), so a
    // settled-but-undigested sub-task is what holds an apparently-complete run
    // in place — and nothing else on screen says so.
    //
    // The wording is deliberately about the RUN, not about who is holding it.
    // `digested` flips only after BOTH the lead read-out and the worktree
    // checkpoint commit, and skipped sub-tasks bypass the lead entirely
    // ("Skipped sub-tasks have nothing to report", team.rs:2459). Naming the
    // lead here would be wrong for skipped tasks, and wrong for any task whose
    // lead turn is already done but whose commit is still running.
    //
    // Keyed off terminal status AND !digested: `digested` is false for a
    // sub-task's whole working life, so the flag alone would mark every row
    // from the moment the run starts.
    isTerminalSubTaskStatus(task.status) && !task.digested
      ? h(
          "span",
          {
            className: "task-subtask-digest",
            title: "Finished — the run has not folded this sub-task in yet",
          },
          "finalizing"
        )
      : null,
    task.rounds_used
      ? h(
          "span",
          { className: "task-subtask-rounds", title: "Review rounds used" },
          `${task.rounds_used} round${task.rounds_used === 1 ? "" : "s"}`
        )
      : null
  );
}

function TaskActions({ run, onAction, pending, error }) {
  const actions = availableTeamActions(run.status);
  if (!actions.length) {
    return error ? h("p", { className: "task-action-error" }, String(error)) : null;
  }
  return h(
    "div",
    { className: "task-actions" },
    ...actions.map((action) =>
      h(
        "button",
        {
          key: action,
          type: "button",
          className: `task-action is-${action}`,
          disabled: Boolean(pending),
          title: TEAM_ACTION_HINTS[action],
          onClick: () => onAction?.(action),
        },
        pending === action ? "…" : TEAM_ACTION_LABELS[action]
      )
    ),
    error ? h("p", { className: "task-action-error" }, String(error)) : null
  );
}

export function TaskDetail({
  run,
  onBack,
  onOpenThread,
  onAction,
  actionPending,
  actionError,
  changesPanel = null,
}) {
  if (!run) {
    return h(
      "div",
      { className: "task-screen" },
      h(
        "header",
        { className: "task-screen-header" },
        h(
          "button",
          { type: "button", className: "task-screen-back", onClick: () => onBack?.() },
          h(BackGlyph),
          "All tasks"
        )
      ),
      h(
        "div",
        { className: "task-screen-empty" },
        h("h3", null, "That task is gone"),
        h(
          "p",
          null,
          "The relay no longer has a record of it. Any branch it created is still on disk."
        )
      )
    );
  }

  const attention = teamAttention(run);
  const progress = teamRunProgress(run);
  const current = currentSubTask(run);

  return h(
    "div",
    { className: "task-screen" },
    h(
      "header",
      { className: "task-screen-header" },
      h(
        "div",
        { className: "task-detail-heading" },
        h(
          "button",
          { type: "button", className: "task-screen-back", onClick: () => onBack?.() },
          h(BackGlyph),
          "All tasks"
        ),
        h(
          "div",
          { className: "task-detail-titles" },
          h("h2", { className: "task-screen-title" }, run.title || "Untitled task"),
          h(
            "p",
            { className: "task-screen-subtitle" },
            h("span", { className: "task-card-branch" }, h(BranchGlyph), run.branch || "—"),
            run.target_ref
              ? h("span", null, ` vs ${run.target_ref.replace(/^refs\/heads\//, "")}`)
              : null
          )
        )
      ),
      h(
        "div",
        { className: "task-detail-status" },
        h(StatusPill, { status: run.status }),
        h("span", { className: "task-detail-phase" }, teamPhaseLabel(run.phase))
      )
    ),

    attention
      ? h(
          "div",
          // Keyed on the REASON, not the bucket. Collapsing every
          // wanting-a-person state into one `kind` is right for the badge, the
          // sort and the pill — but the banner is where the difference has to
          // come back, because only a parked question has something to answer.
          { className: `task-banner is-${attention.reason || attention.kind}` },
          h("p", null, attention.text),
          attention.reason === "question" && run.awaiting?.thread_id
            ? h(
                "button",
                {
                  type: "button",
                  className: "task-banner-action",
                  onClick: () => onOpenThread?.(run.awaiting.thread_id),
                },
                "Answer it"
              )
            : null
        )
      : null,

    h(TaskActions, {
      run,
      onAction,
      pending: actionPending,
      error: actionError,
    }),

    canTalkToTeamLead(run)
      ? h(
          "p",
          { className: "task-screen-hint" },
          "The task is paused, so you can talk to the team lead — open its session to redirect the work."
        )
      : null,

    h(TeamDiagram, { run, onOpenThread }),

    progress.total
      ? h(
          "section",
          { className: "task-subtasks" },
          h(
            "h3",
            { className: "task-section-title" },
            `Sub-tasks (${progress.done}/${progress.total})`
          ),
          h(
            "ul",
            { className: "task-subtask-list" },
            ...run.sub_tasks.map((task) =>
              h(SubTaskRow, {
                key: task.id,
                task,
                isCurrent: current?.id === task.id,
              })
            )
          )
        )
      : null,

    run.unresolved?.length
      ? h(
          "section",
          { className: "task-unresolved" },
          h("h3", { className: "task-section-title" }, "Unresolved"),
          h(
            "ul",
            null,
            ...run.unresolved.map((note, index) => h("li", { key: index }, note))
          )
        )
      : null,

    changesPanel
      ? h(
          "section",
          { className: "task-changes" },
          h("h3", { className: "task-section-title" }, "Changes on this branch"),
          changesPanel
        )
      : null
  );
}

// ---- the screen ------------------------------------------------------------

export function TaskTeamScreen({
  runs,
  selectedRunId,
  loading = false,
  error = null,
  onOpenTask,
  onBack,
  onOpenThread,
  onAction,
  actionPending = null,
  actionError = null,
  onStartTask,
  syncing = false,
  changesPanel = null,
  locked = false,
}) {
  // Before the loading and not-found branches: nothing was ever fetched.
  if (locked) {
    return h(TaskLockedPreview);
  }
  if (!selectedRunId) {
    return h(TaskWelcome, { runs, loading, error, onStartTask });
  }
  const run = (runs || []).find((entry) => entry?.team_run_id === selectedRunId) || null;
  // A run we have not fetched yet is not a run that is gone.
  //
  // `loading` alone is not enough, and the gap is reachable in one click: starting
  // a task navigates straight to its detail, but the cache still holds the
  // pre-create list — so it HAS data, is not loading, and the new run is simply
  // absent. Without `syncing` the user's brand-new task greets them with "that
  // task is gone".
  if (!run && (syncing || (loading && !runs))) {
    return h(
      "div",
      { className: "task-screen task-screen-centered" },
      h("div", { className: "task-screen-empty" }, h("p", null, "Loading task…"))
    );
  }
  return h(TaskDetail, {
    run,
    onBack,
    onOpenThread,
    onAction,
    actionPending,
    actionError,
    changesPanel,
  });
}
