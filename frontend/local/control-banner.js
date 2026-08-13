// The single control banner that sits between the transcript and the composer.
//
// One slot, several claimants, so the decision lives here rather than inline in the
// renderer: whoever claims it also decides what the user's one button does, and a
// priority that is spread across `if`s in a DOM function cannot be tested. The
// renderer only paints what this returns.

import { normalizeWorkspaceRepairPlan } from "../shared/workspace-repair.js";

// Re-exported so this module stays the one import a banner test (or a future surface)
// needs: the decision and the shape it decides on belong together.
export { normalizeWorkspaceRepairPlan };

const HIDDEN = Object.freeze({
  hidden: true,
  hint: "",
  repair: null,
  showTakeOver: false,
  summary: "",
  summaryTitle: "",
});

/**
 * The repair action's copy. The button names the ACT, not the problem — and for a
 * worktree it names the branch, because "re-create" would otherwise sound like the
 * user is about to get an empty directory back instead of their work.
 */
export function workspaceRepairAction(plan, { pending = false, error = "" } = {}) {
  if (!plan) {
    return null;
  }
  const idleLabel = plan.kind === "worktree"
    ? `Re-create worktree on ${plan.branch}`
    : "Create folder";
  return {
    error: error || "",
    kind: plan.kind,
    label: pending
      ? plan.kind === "worktree"
        ? "Re-creating worktree…"
        : "Creating folder…"
      : idleLabel,
    pending: Boolean(pending),
    recordedCwd: plan.recordedCwd,
  };
}

/**
 * Decide the banner from already-derived facts (never from a raw snapshot): the
 * caller owns "is this device the controller", "is the thread working", etc., and
 * passing them in keeps this pure and testable.
 *
 * Returns `{ hidden, summary, summaryTitle, hint, showTakeOver, repair }` where
 * `repair` is `null` or `{ label, pending, error, kind, recordedCwd }`.
 */
export function selectControlBannerModel({
  controllerName = "",
  hasActiveThread = false,
  hasController = false,
  isController = false,
  lockedByAgent = false,
  lockedByWorkflow = false,
  repairError = "",
  repairPending = false,
  sessionWorking = false,
  viewingConversation = false,
  viewOnly = false,
  workspaceMissing = null,
} = {}) {
  const plan = normalizeWorkspaceRepairPlan(workspaceMissing);

  // FIRST, ahead of every control-related claimant. Take-over — and the background
  // session's "stop it or take over" — both offer to move this device into the
  // session, and there is nothing to move into: the directory the thread records is
  // gone, so a send dies before it reaches the provider. Offering "Take over" here
  // hands the user a button that cannot help and hides the one that can.
  if (plan && hasActiveThread && viewingConversation) {
    const noun = plan.kind === "worktree" ? "worktree" : "folder";
    return {
      hidden: false,
      hint: plan.kind === "worktree"
        ? `Re-creating it checks ${plan.branch} back out at that path.`
        : "Re-creating it lets this session run there again.",
      repair: workspaceRepairAction(plan, { error: repairError, pending: repairPending }),
      showTakeOver: false,
      // Names the directory, because that is the whole point: the user has just
      // watched sends vanish, and the only fact that explains it is which path is
      // missing.
      summary: `This session's ${noun} is gone: ${plan.recordedCwd}`,
      summaryTitle: plan.recordedCwd,
    };
  }

  if (viewOnly && sessionWorking && !lockedByAgent) {
    return {
      hidden: false,
      hint: "This background session is still running. Stop it or take over to continue here.",
      repair: null,
      showTakeOver: true,
      summary: "Background session is running",
      summaryTitle: "",
    };
  }

  if (
    !hasActiveThread
    || !viewingConversation
    || !hasController
    || isController
    || (!sessionWorking && !lockedByAgent)
  ) {
    return HIDDEN;
  }

  // Only the thread actually owned by review/workflow is off-limits for take-over.
  return {
    hidden: false,
    hint: lockedByAgent
      ? lockedByWorkflow
        ? "This session is locked by Code Flow; it unlocks when the workflow finishes."
        : "This session is being reviewed; it unlocks when the review finishes."
      : "You can still approve from this device. Take over when you want to type or continue the session.",
    repair: null,
    showTakeOver: !lockedByAgent,
    summary: `Another device has control (${controllerName})`,
    summaryTitle: "",
  };
}
