// The Project switcher: one control that decides which project is PINNED to the
// top of the session list.
//
// It is not a filter and it is not a mode. The list below it is always the full
// list; selecting a project only lifts that project's sessions into a group at the
// top (see `buildThreadGroups`' `pinnedProjectId`). "All sessions" is therefore a
// real, safe default rather than an escape hatch — nothing is hidden in any state.
//
// Shared by local and remote deliberately. The control is identical on both — a
// menu of names — and the surfaces differ only in what selecting one does, which
// is the caller's business. Writing it twice is how the two sidebars drifted
// before.
//
// Rename/delete are NOT here. They live on the pinned group's own header, which
// `ThreadGroupList` renders for any group carrying a `projectId`. Putting them in
// this menu too would mean two places to keep in step, and a destructive action
// sitting one keystroke away from a navigation action.

import React, { useCallback, useEffect, useId, useRef, useState } from "react";

const h = React.createElement;

export const ALL_SESSIONS_LABEL = "Default Workspace";

export function ProjectSwitcher({
  activeProjectId = null,
  className = "",
  createLabel = "New project",
  // The trigger's text and tooltip. Supplied by the surface rather than derived
  // here, because on local this control IS the header title and that decision
  // lives in `header-labels.js` — one tested place for "what does the header
  // say", instead of two that agree until they don't.
  label = "",
  labelTooltip = "",
  onCreateProject = null,
  onSelectProject = null,
  projects = [],
  titleId = null,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuId = useId();

  const close = useCallback(() => setOpen(false), []);

  // Dismiss on outside pointer or Escape. Bound only while open, so a closed
  // switcher costs nothing — there is one of these per surface and it outlives
  // every render.
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        close();
      }
    };
    // Escape must not bubble: the sidebar search treats a bare Escape as "close
    // and clear", so letting it through would wipe a query the user never
    // touched.
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close]);

  const activeProject = activeProjectId
    ? projects.find((project) => project.id === activeProjectId) || null
    : null;
  // A selection whose project is gone (deleted from another device) shows the
  // default rather than a dangling name. The grouper independently falls back to
  // plain cwd grouping for the same id, so the control and the list agree without
  // either having to tell the other.
  const derivedLabel = activeProject
    ? activeProject.name || activeProject.id
    : ALL_SESSIONS_LABEL;
  const currentLabel = label || derivedLabel;

  const choose = (projectId) => {
    close();
    onSelectProject?.(projectId);
  };

  return h(
    "div",
    {
      className: `project-switcher${className ? ` ${className}` : ""}`,
      ref: rootRef,
    },
    // An <h1> wrapping the <button>, not the other way round: a heading is flow
    // content and would be invalid inside a button, and this element IS the page
    // heading on local — the switcher replaced the header title rather than
    // sitting under it.
    h(
      "h1",
      { className: "project-switcher-heading" },
      h(
        "button",
        {
          "aria-expanded": open ? "true" : "false",
          "aria-haspopup": "menu",
          "aria-controls": open ? menuId : undefined,
          className: "project-switcher-trigger",
          "data-active-project-id": activeProjectId || "",
          onClick: () => setOpen((wasOpen) => !wasOpen),
          title: labelTooltip || currentLabel,
          type: "button",
        },
        h(
          "span",
          { className: "project-switcher-label", id: titleId || undefined },
          currentLabel
        ),
        h("span", { "aria-hidden": "true", className: "project-switcher-caret" })
      )
    ),
    open
      ? h(
          "div",
          { className: "project-switcher-menu", id: menuId, role: "menu" },
          h(
            "button",
            {
              className:
                "project-switcher-option"
                + (activeProjectId ? "" : " is-active"),
              onClick: () => choose(null),
              role: "menuitem",
              type: "button",
            },
            ALL_SESSIONS_LABEL
          ),
          projects.map((project) =>
            h(
              "button",
              {
                className:
                  "project-switcher-option"
                  + (project.id === activeProjectId ? " is-active" : ""),
                "data-project-id": project.id,
                key: project.id,
                onClick: () => choose(project.id),
                role: "menuitem",
                type: "button",
              },
              project.name || project.id
            )
          ),
          onCreateProject
            ? h(
                "button",
                {
                  className: "project-switcher-option project-switcher-create",
                  onClick: () => {
                    close();
                    onCreateProject();
                  },
                  role: "menuitem",
                  type: "button",
                },
                createLabel
              )
            : null
        )
      : null
  );
}
