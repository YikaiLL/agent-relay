// A FORM CONTROL, not navigation: choosing here sets a field on the session about
// to be created rather than re-pinning the sidebar. Menu shared with the switcher.

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

  // Escape must be CONSUMED here: this opens inside a modal dialog.
  useDismissableMenu({ onClose: close, open, rootRef });

  const activeProject = activeProjectId
    ? projects.find((project) => project.id === activeProjectId) || null
    : null;
  // Fail-open like the switcher: a deleted project reads as the default, and
  // nothing below sees the raw id.
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
          // No rename/delete: a destructive act should not sit one keystroke from
          // a routine one, and the switcher already carries that pair.
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
