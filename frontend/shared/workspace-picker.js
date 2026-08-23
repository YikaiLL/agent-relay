// A combobox, not a menu: the workspace is a free path, so a fixed list would drop
// the ability to launch in a directory the relay has never seen.

import React, { useCallback, useEffect, useId, useRef, useState } from "react";

import { abbreviateHomePath, gitContextLabel } from "./workspace-chip-model.js";
import { useDismissableMenu } from "./use-dismissable-menu.js";

const h = React.createElement;

const FOLDER_ICON = h(
  "svg",
  {
    "aria-hidden": "true",
    className: "workspace-picker-icon",
    fill: "none",
    height: "14",
    stroke: "currentColor",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    strokeWidth: "1.6",
    viewBox: "0 0 24 24",
    width: "14",
  },
  h("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" })
);

export function WorkspacePicker({
  // Null renders no chip: "not a repo" is the common case and is not worth a line.
  gitContext = null,
  disabled = false,
  id = null,
  inputId = null,
  onChange = null,
  suggestions = [],
  value = "",
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);

  useDismissableMenu({ onClose: close, open, rootRef });

  // Re-seed the field whenever the panel opens, so it always starts from the
  // value actually in effect rather than from an abandoned edit.
  useEffect(() => {
    if (open) {
      setDraft(value);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open, value]);

  const commit = (next) => {
    close();
    const trimmed = String(next || "").trim();
    if (trimmed) {
      onChange?.(trimmed);
    }
  };

  // Only trust a context naming the path shown, or path B wears path A's branch
  // while its probe is in flight. Compared on the relay's normalized spelling.
  const contextMatchesValue =
    gitContext
    && (!gitContext.cwd
      || gitContext.cwd === value
      || abbreviateHomePath(gitContext.cwd) === abbreviateHomePath(value));
  const gitLabel = contextMatchesValue ? gitContextLabel(gitContext) : null;

  return h(
    "div",
    { className: "workspace-picker", ref: rootRef },
    h(
      "button",
      {
        "aria-controls": open ? panelId : undefined,
        "aria-expanded": open ? "true" : "false",
        "aria-haspopup": "dialog",
        "aria-label": `Workspace: ${value || "none chosen"}`,
        className: "workspace-picker-trigger",
        disabled: disabled || undefined,
        id: id || undefined,
        onClick: () => setOpen((wasOpen) => !wasOpen),
        type: "button",
      },
      FOLDER_ICON,
      h(
        "span",
        { className: "workspace-picker-path", title: value || "" },
        abbreviateHomePath(value) || "Choose a directory"
      ),
      gitLabel
        ? h(
            "span",
            {
              className:
                "workspace-picker-git" + (gitContext?.dirty ? " is-dirty" : ""),
            },
            gitLabel
          )
        : null,
      h("span", { "aria-hidden": "true", className: "project-switcher-caret" })
    ),
    open
      ? h(
          "div",
          { className: "workspace-picker-panel", id: panelId },
          h("input", {
            autoComplete: "off",
            className: "workspace-picker-input",
            id: inputId || undefined,
            onChange: (event) => setDraft(event.target.value),
            // Without this, accepting a typed path means clicking away — which
            // reads as "my typing was ignored".
            onKeyDown: (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit(draft);
              }
            },
            placeholder: "/path/to/project or ~/project",
            ref: inputRef,
            spellCheck: false,
            type: "text",
            value: draft,
          }),
          suggestions.length
            ? h(
                "div",
                { className: "workspace-picker-suggestions", role: "listbox" },
                suggestions.map((suggestion) =>
                  h(
                    "button",
                    {
                      "aria-selected": suggestion.cwd === value ? "true" : "false",
                      className:
                        "workspace-picker-suggestion"
                        + (suggestion.cwd === value ? " is-active" : ""),
                      key: suggestion.cwd,
                      onClick: () => commit(suggestion.cwd),
                      role: "option",
                      type: "button",
                    },
                    h(
                      "span",
                      { className: "workspace-picker-suggestion-path" },
                      abbreviateHomePath(suggestion.cwd)
                    ),
                    suggestion.label
                      ? h(
                          "span",
                          { className: "workspace-picker-suggestion-label" },
                          suggestion.label
                        )
                      : null
                  )
                )
              )
            : null
        )
      : null
  );
}
