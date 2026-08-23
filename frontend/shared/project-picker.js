// The project picker as it appears in the launch and fork dialogs: a chip in the
// dialog's context bar that opens the shared project menu.
//
// Why this is not just `ProjectSwitcher` with a class name:
//
//  1. It is a FORM CONTROL, not navigation. Choosing here sets a field on the
//     session about to be created; it does not move the user anywhere. The
//     switcher's selection changes what the surface is looking at, and conflating
//     the two would mean opening the New session dialog could silently re-pin the
//     sidebar.
//  2. It lives inside `<dialog showModal()>`, which owns the Escape key. The
//     switcher may let Escape bubble after closing itself; here that would close
//     the whole dialog and discard a typed prompt, so the key has to be consumed
//     while the menu is open — and only while it is open, or the dialog becomes
//     undismissable from the keyboard.
//
// The MENU itself is shared (`ProjectMenu`), so the two placements cannot drift in
// what they list or how a row reads.

import React, { useCallback, useId, useRef, useState } from "react";

import { DEFAULT_WORKSPACE_LABEL } from "./project-labels.js";
import { ProjectMenu } from "./project-menu-react.js";
import { buildProjectPickerRows } from "./project-picker-model.js";
import { useDismissableMenu } from "./use-dismissable-menu.js";

const h = React.createElement;

export function ProjectPicker({
  activeProjectId = null,
  className = "",
  createLabel = "New project…",
  disabled = false,
  id = null,
  label = "Project",
  onCreateProject = null,
  onSelectProject = null,
  projects = [],
  threadActivity = null,
  threadAttention = null,
  threadProjectId = {},
  threadReviewing = null,
  threads = [],
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuId = useId();

  const close = useCallback(() => setOpen(false), []);

  // Escape here must be CONSUMED, not merely handled: this menu opens inside a
  // modal dialog, and an uncancelled Escape would close the dialog behind it
  // along with the menu.
  useDismissableMenu({ onClose: close, open, rootRef });

  const activeProject = activeProjectId
    ? projects.find((project) => project.id === activeProjectId) || null
    : null;
  // Same fail-open rule as the switcher: an id whose project is gone reads as the
  // default rather than as a dangling name, and nothing below is allowed to see
  // the raw id.
  const resolvedProjectId = activeProject?.id || null;
  const currentLabel = activeProject
    ? activeProject.name || activeProject.id
    : DEFAULT_WORKSPACE_LABEL;

  const choose = (projectId) => {
    close();
    onSelectProject?.(projectId);
  };

  return h(
    "div",
    {
      className: `project-picker${className ? ` ${className}` : ""}`,
      ref: rootRef,
    },
    h(
      "button",
      {
        "aria-controls": open ? menuId : undefined,
        "aria-expanded": open ? "true" : "false",
        "aria-haspopup": "menu",
        "aria-label": `${label}: ${currentLabel}`,
        className: "project-picker-trigger",
        "data-active-project-id": resolvedProjectId || "",
        disabled: disabled || undefined,
        id: id || undefined,
        onClick: () => setOpen((wasOpen) => !wasOpen),
        type: "button",
      },
      // The dot is the same "which project" signal the session rows carry, so the
      // chip reads as a project rather than as one more settings dropdown.
      h("span", {
        "aria-hidden": "true",
        className:
          "project-picker-dot" + (resolvedProjectId ? " is-assigned" : ""),
      }),
      h("span", { className: "project-picker-label" }, currentLabel),
      h("span", { "aria-hidden": "true", className: "project-switcher-caret" })
    ),
    open
      ? h(ProjectMenu, {
          createLabel,
          id: menuId,
          onCreateProject: onCreateProject
            ? () => {
                close();
                onCreateProject();
              }
            : null,
          onSelect: choose,
          // Rename/delete are deliberately absent. This control configures a
          // session that does not exist yet; offering to delete a project from
          // inside it puts a destructive act one keystroke from a routine one,
          // and the switcher already carries that pair.
          rows: buildProjectPickerRows({
            activeProjectId: resolvedProjectId,
            projects,
            threadActivity,
            threadAttention,
            threadProjectId,
            threadReviewing,
            threads,
          }),
        })
      : null
  );
}
