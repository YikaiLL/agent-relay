// Remote's consolidated Settings modal.
//
// Remote had no Settings surface at all, so the chrome that local files under
// Settings was scattered across the sidebar instead: a labelled "Providers"
// health section pinned between "New session" and the relay list, and a lone
// theme picker in the footer. Both are things you set once and then never look
// at, occupying the column you scan constantly.
//
// This is the same shape as local's SettingsModal (react-shell.js) and reuses
// its CSS wholesale — `.settings-modal`, `.settings-tabs`, `.settings-tab`,
// `.settings-panel` — so the two shells cannot drift apart visually.
//
// The one deliberate difference is how a tab is selected. Local's panels are
// always mounted and toggled with `hidden`, because every id inside has to
// resolve at `dom.js` import time; remote has no such constraint, so the
// inactive panel is simply not rendered.
//
// Device pairing is NOT here. It stays behind its own modal off the sidebar's
// "Manage" row: pairing is a task you perform, not a preference you set, and it
// owns a QR code, an approval list and a live expiry. Folding it in would make
// this modal the third thing it is, and give pairing two entry points.

import React from "react";
import { ManagedDialog } from "../shared/managed-dialog.js";
import { ThemePickerRow } from "../shared/theme-picker.js";
import { ProviderStatusSection } from "./provider-status-section.js";

const h = React.createElement;

const TABS = [
  { key: "providers", label: "Providers" },
  { key: "appearance", label: "Appearance" },
];

export function RemoteSettingsModal({ onClose, open, providerModel }) {
  const [tab, setTab] = React.useState("providers");

  // Reopening lands on Providers rather than wherever the last visit ended.
  // The tab you left is a detail of a session that is over; the tab that
  // answers "is my agent actually reachable" is the reason to open this at all.
  React.useEffect(() => {
    if (open) {
      setTab("providers");
    }
  }, [open]);

  return h(
    ManagedDialog,
    {
      className: "settings-modal panel-modal panel-modal-wide",
      id: "remote-settings-modal",
      open,
      onRequestClose: onClose,
    },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "Settings"),
      h(
        "button",
        {
          className: "header-button close-modal-btn",
          id: "close-remote-settings-modal",
          onClick: onClose,
          type: "button",
        },
        "×"
      )
    ),
    h(
      "div",
      { className: "settings-tabs", role: "tablist", "aria-label": "Settings sections" },
      ...TABS.map((entry) =>
        h(
          "button",
          {
            key: entry.key,
            className: `settings-tab${tab === entry.key ? " is-active" : ""}`,
            id: `remote-settings-tab-${entry.key}`,
            type: "button",
            role: "tab",
            "aria-selected": tab === entry.key ? "true" : "false",
            "data-settings-tab": entry.key,
            onClick: () => setTab(entry.key),
          },
          entry.label
        )
      )
    ),
    h(
      "section",
      { className: "panel-modal-body settings-body" },
      tab === "providers"
        ? h(
            "div",
            { className: "settings-panel", "data-settings-panel": "providers" },
            // The empty case is decided HERE, not by letting ProviderStatusSection
            // return null: `h()` builds an element object either way, so `h(...) ||
            // fallback` is always the element and the fallback is unreachable.
            //
            // In the sidebar an empty panel could just vanish. In a tab you opened
            // on purpose, vanishing is indistinguishable from a broken screen.
            providerModel?.length
              ? // `.provider-status-panel`, not the sidebar's wrapper:
                // `.remote-access-shell` carries sidebar padding that is
                // neutralised only while it is inside `.sidebar`.
                h(ProviderStatusSection, {
                  caption: null,
                  className: "provider-status-panel",
                  model: providerModel,
                })
              : h("p", { className: "provider-status-empty" }, "No providers are configured on this relay."),
            h(
              "p",
              { className: "sidebar-hint" },
              "Which agent a session uses is chosen when you start it, and cannot be changed afterwards — fork the session to hand it to another agent."
            )
          )
        : null,
      tab === "appearance"
        ? h(
            "div",
            { className: "settings-panel", "data-settings-panel": "appearance" },
            h("section", { className: "details-section" }, h(ThemePickerRow))
          )
        : null
    )
  );
}
