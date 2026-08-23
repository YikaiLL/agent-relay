// The chrome both launch dialogs share: shell, context bar, prompt card, footer.
//
// New session and Fork session ask the same question — "start an agent, here,
// like this" — and differ only in what they inherit. Before this they were two
// hand-built `<dialog>`s that happened to use the same two class names, and they
// had already drifted (one closed on backdrop click and one did not; one said
// "x" and the other "×"). Sharing the chassis makes the differences the only
// thing either file expresses.

import React from "react";

const h = React.createElement;

// Order matters: the context bar answers "where", the prompt answers "what", and
// the pills answer "how". The old dialogs led with a Provider dropdown, which put
// the least-changed decision first.
export function SessionDialogShell({
  actions = null,
  badge = null,
  children,
  footerHint = null,
  id,
  onRequestClose = null,
  title,
}) {
  const close = () => {
    onRequestClose?.();
    document.getElementById(id)?.close?.();
  };

  return h(
    "dialog",
    {
      className: "panel-modal session-dialog",
      id,
      onClose: () => onRequestClose?.(),
      // Backdrop click dismisses. `event.target === currentTarget` is only true
      // for the backdrop itself, because every child renders inside the sections
      // below — a click on the body cannot reach here.
      onClick: (event) => {
        if (event.target === event.currentTarget) {
          close();
        }
      },
    },
    h(
      "div",
      { className: "session-dialog-header" },
      h(
        "div",
        { className: "session-dialog-title" },
        h("h2", null, title),
        badge
      ),
      h(
        "button",
        {
          "aria-label": "Close",
          className: "session-dialog-close",
          onClick: close,
          type: "button",
        },
        "×"
      )
    ),
    h("section", { className: "session-dialog-body" }, children),
    h(
      "div",
      { className: "session-dialog-footer" },
      h("p", { className: "session-dialog-hint" }, footerHint),
      h("div", { className: "session-dialog-actions" }, actions)
    )
  );
}

// The "where" row: which project the session is filed under, and which directory
// it runs in. One row because they are one thought — and because keeping them
// adjacent is what makes it obvious that the project is NOT derived from the
// path (projects are deliberately not bound to a cwd; see ProjectView's docs).
export function SessionContextBar({ project = null, workspace = null }) {
  return h(
    "div",
    { className: "session-context-bar" },
    project,
    project && workspace
      ? h("span", { "aria-hidden": "true", className: "session-context-sep" }, "/")
      : null,
    workspace
  );
}

// The prompt, as the largest thing in the dialog. It is the only field most
// launches actually fill in, and the old layout buried it under four dropdowns.
export function PromptCard({
  accessory = null,
  attachControl = null,
  hint = null,
  id,
  onChange = null,
  onSubmit = null,
  placeholder = "",
  value,
}) {
  return h(
    "div",
    { className: "session-prompt-card" },
    h("textarea", {
      className: "session-prompt-input",
      id,
      onChange: (event) => onChange?.(event.target.value),
      // Cmd/Ctrl+Enter submits from inside the textarea, matching the footer's
      // ⌘↵ hint. Plain Enter must stay a newline: this is a task description,
      // not a chat message, and multi-line prompts are the norm.
      onKeyDown: (event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onSubmit?.();
        }
      },
      placeholder,
      rows: 5,
      // Left undefined when the caller does not manage the value, which keeps
      // the textarea uncontrolled for hosts that read it at submit time.
      value: value ?? undefined,
    }),
    accessory,
    h(
      "div",
      { className: "session-prompt-foot" },
      attachControl || h("span"),
      hint ? h("span", { className: "session-prompt-hint" }, hint) : null
    )
  );
}

// The row of settings pills. A plain wrapper, but named so both dialogs wrap
// them identically and the CSS has one hook for the wrap behaviour that mobile
// depends on.
export function SettingPillRow({ children }) {
  return h("div", { className: "session-setting-pills" }, children);
}

// The keyboard hint on the primary action. Rendered as its own element rather
// than baked into the label so it can be hidden on touch, where there is no
// ⌘ and the shortcut is unreachable.
export function SubmitShortcutHint() {
  return h("span", { "aria-hidden": "true", className: "session-submit-shortcut" }, "⌘↵");
}
