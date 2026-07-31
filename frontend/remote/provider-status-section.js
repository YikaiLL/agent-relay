// The remote sidebar's "Providers" panel: one row per configured provider, showing
// its health.
//
// Its own module so the mark-vs-name fallback below is reachable from a DOM test
// without importing the whole remote app.
//
// Local renders the same model, but imperatively and inside the Settings modal
// (react-shell.js + render-session.js), so there is no component to share — only the
// model (buildProviderStatusModel) and the CSS are common.

import React from "react";
import { providerMark } from "../shared/provider-mark.js";

const h = React.createElement;

export function ProviderStatusSection({ model }) {
  if (!model || model.length === 0) {
    return null;
  }
  return h(
    "section",
    { className: "remote-access-shell provider-status-shell" },
    h("p", { className: "sidebar-caption" }, "Providers"),
    h(
      "ul",
      { className: "provider-status-list", id: "remote-provider-status-list" },
      ...model.map((row) => {
        // The agent's MARK instead of its name, matching the session rows and tabs.
        // The drawer is narrow and this row already spends its width on a status dot
        // and a status word; the mark says which agent in a fixed slot.
        //
        // Falls back to the name for any provider we ship no icon for (`fake`, and
        // anything new) — never another vendor's logo. The name is kept for screen
        // readers either way, so trading the text for a glyph costs nothing there.
        const mark = providerMark(row.key, "provider-mark");
        return h(
          "li",
          {
            key: row.key,
            className: "provider-status-row",
            "data-provider": row.key,
            "data-status": row.status,
            title: row.reason || undefined,
          },
          h("span", {
            className: `provider-status-dot ${row.dotClass}`,
            "aria-hidden": "true",
          }),
          h(
            "span",
            { className: "provider-status-name" },
            mark || row.label,
            mark ? h("span", { className: "sr-only" }, row.label) : null
          ),
          h("span", { className: "provider-status-state" }, row.statusLabel)
        );
      })
    )
  );
}
