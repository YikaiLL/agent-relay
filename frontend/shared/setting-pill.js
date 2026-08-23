// One settings control in the launch dialogs: a pill that names its setting and
// its current value, and opens a menu of the alternatives.
//
// It replaces a labelled `<select>` per setting. The reason is not decoration —
// a native `<option>` can only render a single string, and three things the
// dialogs need to say do not fit in one:
//
//   * "default" / "inherited" tags beside a value, so the user can see which
//     choices they have actually made and which are being resolved for them.
//   * A provider heading above a group of models, now that Provider and Model
//     are one control.
//   * A per-row subtitle explaining what a permission level actually permits.
//
// The pill also renders in an INHERITED state (dashed) for the fork dialog,
// where a field the user has not touched is deliberately sent as null so the
// relay resolves it from the source thread. That state has to be visually
// distinct from a chosen value, because the two produce different requests.

import React, { useCallback, useId, useRef, useState } from "react";

import { useDismissableMenu } from "./use-dismissable-menu.js";

const h = React.createElement;

export function SettingPill({
  // Either `options` (flat) or `groups` (sectioned, for the model picker).
  // Groups win when both are supplied.
  disabled = false,
  groups = null,
  id = null,
  inherited = false,
  label,
  onSelect = null,
  options = null,
  tag = null,
  value,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);

  useDismissableMenu({ onClose: close, open, rootRef });

  const sections = groups || [{ label: null, options: options || [], provider: null }];

  const choose = (option) => {
    close();
    onSelect?.(option.value, option);
  };

  return h(
    "div",
    { className: "setting-pill" + (inherited ? " is-inherited" : ""), ref: rootRef },
    h(
      "button",
      {
        "aria-controls": open ? menuId : undefined,
        "aria-expanded": open ? "true" : "false",
        "aria-haspopup": "menu",
        className: "setting-pill-trigger",
        disabled: disabled || undefined,
        id: id || undefined,
        onClick: () => setOpen((wasOpen) => !wasOpen),
        type: "button",
      },
      h("span", { className: "setting-pill-label" }, label),
      h("span", { className: "setting-pill-value" }, value),
      tag ? h("span", { className: "setting-pill-tag" }, tag) : null,
      h("span", { "aria-hidden": "true", className: "project-switcher-caret" })
    ),
    open
      ? h(
          "div",
          { className: "setting-pill-menu", id: menuId, role: "menu" },
          sections.map((section, index) =>
            h(
              "div",
              { className: "setting-pill-section", key: section.provider || section.label || index },
              section.label
                ? h("div", { className: "setting-pill-section-heading" }, section.label)
                : null,
              // A catalogue-less provider still renders a choosable row (see
              // buildModelPickerGroups), so this is a NOTE beside it, not a
              // replacement for it.
              section.empty
                ? h(
                    "div",
                    { className: "setting-pill-section-empty" },
                    "Catalogue unavailable — the relay will pick"
                  )
                : null,
              section.options.map((option) =>
                h(
                  "button",
                  {
                    "aria-checked": option.selected ? "true" : "false",
                    className:
                      "setting-pill-option" + (option.selected ? " is-active" : ""),
                    "data-value": option.value,
                    key: `${section.provider || ""}:${option.value}`,
                    onClick: () => choose(option),
                    role: "menuitemradio",
                    type: "button",
                  },
                  h(
                    "span",
                    { className: "setting-pill-option-text" },
                    h("span", { className: "setting-pill-option-label" }, option.label),
                    option.subtitle
                      ? h(
                          "span",
                          { className: "setting-pill-option-subtitle" },
                          option.subtitle
                        )
                      : null
                  ),
                  option.tag
                    ? h("span", { className: "setting-pill-option-tag" }, option.tag)
                    : null,
                  h(
                    "span",
                    { "aria-hidden": "true", className: "setting-pill-option-check" },
                    "✓"
                  )
                )
              )
            )
          )
        )
      : null
  );
}
