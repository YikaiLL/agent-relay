// The project menu popup — one implementation, three placements.
//
// It was previously inlined in `ProjectSwitcher`, which was fine while the
// switcher was the only thing that opened it. The launch and fork dialogs now
// pick a project too, and re-typing this markup in a dialog is exactly how the
// two sidebars drifted before the switcher itself was shared. So the popup moves
// here and the switcher becomes one of its callers.
//
// Class names stay `.project-switcher-*` on purpose. They are load-bearing in
// three places that have nothing to do with this refactor — the stylesheet, the
// switcher's own DOM tests, and remote's drawer rule that anchors the menu to the
// top bar rather than to its 32px trigger (`.project-switcher-top
// .project-switcher-menu`). Renaming them buys a tidier prefix and risks all
// three; the comment is cheaper.
//
// Dismissal (outside pointer, Escape) is NOT here. It belongs to whatever owns
// the open/closed state, and the two owners need different things: the switcher
// closes itself, while inside a `<dialog>` Escape has to be swallowed before the
// browser treats it as a close request for the dialog behind the menu.

import React from "react";

const h = React.createElement;

export function ProjectMenu({
  createLabel = "New project",
  // Rows come from `buildProjectPickerRows` — the menu deliberately does no
  // deriving of its own, so what a row says is decided in one pure, tested place
  // rather than drifting between the three placements.
  rows = [],
  id = null,
  heading = "Projects",
  onSelect = null,
  onCreateProject = null,
  onRenameProject = null,
  onDeleteProject = null,
  // Rename/delete act on the ACTIVE project only. The menu names many projects
  // and can act on exactly one; a rename that silently landed on another row
  // would not be recoverable.
  activeProject = null,
}) {
  return h(
    "div",
    { className: "project-switcher-menu", id: id || undefined, role: "menu" },
    heading
      ? h("div", { className: "project-switcher-menu-heading" }, heading)
      : null,
    rows.map((row) =>
      h(
        "button",
        {
          // menuitemradio, not menuitem: this is a single-choice set and exactly
          // one row is current, which is what the tick draws. A screen reader
          // otherwise has to infer "selected" from a decorative glyph.
          "aria-checked": row.active ? "true" : "false",
          className: "project-switcher-option" + (row.active ? " is-active" : ""),
          "data-project-id": row.id || "",
          key: row.id || "__default__",
          onClick: () => onSelect?.(row.id),
          role: "menuitemradio",
          type: "button",
        },
        h(
          "span",
          { className: "project-switcher-option-text" },
          h("span", { className: "project-switcher-option-label" }, row.label),
          row.subtitle
            ? h("span", { className: "project-switcher-option-subtitle" }, row.subtitle)
            : null
        ),
        // Drawn always and hidden with opacity rather than conditionally
        // rendered, so a row does not change width when it becomes current.
        h("span", { "aria-hidden": "true", className: "project-switcher-option-check" }, "✓")
      )
    ),
    onCreateProject
      ? h(
          "button",
          {
            className: "project-switcher-option project-switcher-create",
            onClick: () => onCreateProject(),
            role: "menuitem",
            type: "button",
          },
          createLabel
        )
      : null,
    // Destructive pair last, behind their own divider, never mixed into the list
    // of places you can navigate to.
    activeProject && onRenameProject
      ? h(
          "button",
          {
            className: "project-switcher-option project-switcher-manage",
            onClick: () =>
              onRenameProject(activeProject.id, activeProject.name || activeProject.id),
            role: "menuitem",
            type: "button",
          },
          "Rename project"
        )
      : null,
    activeProject && onDeleteProject
      ? h(
          "button",
          {
            className:
              "project-switcher-option project-switcher-manage project-switcher-danger",
            onClick: () =>
              onDeleteProject(activeProject.id, activeProject.name || activeProject.id),
            role: "menuitem",
            type: "button",
          },
          "Delete project"
        )
      : null
  );
}
