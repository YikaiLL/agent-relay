/**
 * Resize control for the Tasks workspace Orchestrator column.
 *
 * Lives beside the markup (not in app.js) so the handle can mount/unmount with
 * the workspace without a second wiring pass after every React render. Reuses
 * `createPanelControl` — same drag math and localStorage shape as the sidebar
 * and session right rail.
 *
 * Half-workspace max is enforced here (not via CSS `min(..., 50%)`) so the
 * controller width always matches what is painted — otherwise drag starts from
 * an uncapped stored value and the first pixels of motion are a dead zone.
 *
 * Container shrinks only reclamp the *displayed* width. Persisted preference
 * stays put so a phone-sized Tasks visit cannot permanently wipe a desktop
 * width, and widening restores it.
 */
import { createPanelControl } from "../local/panel-controls.js";

export const TASK_ORCH_PANEL_CSS_VAR = "--task-orch-panel-width";
export const TASK_ORCH_MAX_OPEN_WIDTH = 720;
export const TASK_ORCH_MIN_OPEN_WIDTH = 320;

let control = null;
let binding = null;
let workspaceObserver = null;

function tasksWorkspaceEl() {
  return document.querySelector(".task-workspace:not(.teams-workspace)");
}

/**
 * Half the live Tasks workspace. Floored at min only while two columns can
 * actually show (≥640px); below that the mount container-query stacks, so the
 * painted track width is irrelevant.
 */
export function resolveTaskOrchMaxWidth() {
  const workspace = tasksWorkspaceEl();
  if (!workspace) return TASK_ORCH_MAX_OPEN_WIDTH;
  const half = Math.floor(workspace.clientWidth * 0.5);
  if (!Number.isFinite(half) || half <= 0) return TASK_ORCH_MAX_OPEN_WIDTH;
  return Math.min(TASK_ORCH_MAX_OPEN_WIDTH, Math.max(TASK_ORCH_MIN_OPEN_WIDTH, half));
}

function syncWidthToContainer() {
  if (!control) return;
  control.reclampToContainer();
}

function observeWorkspace(workspace) {
  if (typeof ResizeObserver === "undefined") return null;
  const observer = new ResizeObserver(() => {
    syncWidthToContainer();
  });
  observer.observe(workspace);
  return observer;
}

export function getTaskOrchPanelControl() {
  if (!control) {
    control = createPanelControl({
      cssVarName: TASK_ORCH_PANEL_CSS_VAR,
      widthStorageKey: "agent-relay:task-orch-panel-width",
      openWidthStorageKey: "agent-relay:task-orch-panel-open-width",
      minOpenWidth: TASK_ORCH_MIN_OPEN_WIDTH,
      maxOpenWidth: TASK_ORCH_MAX_OPEN_WIDTH,
      defaultOpenWidth: 440,
      side: "right",
      collapsible: false,
      resolveMaxOpenWidth: resolveTaskOrchMaxWidth,
    });
  }
  return control;
}

/** Attach (or re-attach) the drag handle. Safe to call when the node is missing. */
export function bindTaskWorkspaceResizeHandle() {
  const el = document.getElementById("task-workspace-resize");
  if (!el) {
    binding?.destroy?.();
    binding = null;
    workspaceObserver?.disconnect?.();
    workspaceObserver = null;
    return null;
  }
  if (binding?.el === el) return binding;
  binding?.destroy?.();
  workspaceObserver?.disconnect?.();
  workspaceObserver = null;

  const panel = getTaskOrchPanelControl();
  const attached = panel.attachResizeHandle(el);
  const workspace = el.closest(".task-workspace") || tasksWorkspaceEl();
  if (workspace) {
    workspaceObserver = observeWorkspace(workspace);
    syncWidthToContainer();
  }

  binding = {
    el,
    destroy() {
      attached?.destroy?.();
      workspaceObserver?.disconnect?.();
      workspaceObserver = null;
      if (binding?.el === el) binding = null;
    },
  };
  return binding;
}

// Apply the stored width as soon as this module loads so the first Tasks paint
// does not flash the CSS fallback before the handle mounts.
if (typeof document !== "undefined") {
  getTaskOrchPanelControl();
}
