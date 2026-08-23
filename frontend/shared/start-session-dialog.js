import React from "react";

import { ProjectPicker } from "./project-picker.js";
import { SettingPill } from "./setting-pill.js";
import { WorkspacePicker } from "./workspace-picker.js";
import { abbreviateHomePath } from "./workspace-chip-model.js";
import { buildModelPickerGroups, selectedModelChip } from "./model-picker-model.js";
import {
  PromptCard,
  SessionContextBar,
  SessionDialogShell,
  SettingPillRow,
  SubmitShortcutHint,
} from "./session-dialog-chrome.js";

const h = React.createElement;

// The New session dialog.
//
// Two structural changes from the version this replaces, both of which move work
// out of the user's way rather than rearranging it:
//
//  * Provider and Model are ONE control. Picking a model implies its provider,
//    so the pair can no longer be left inconsistent and the dialog is one
//    decision shorter. See model-picker-model.js.
//  * The prompt is the largest element instead of the last. It is the only field
//    most launches fill in; it used to sit under four dropdowns.
//
// The dialog is fully CONTROLLED — every value arrives in `fields` and every
// change leaves through `onFieldChange`. The local surface used to read its
// values back off the DOM by element id at submit time; that is gone, and
// `frontend/local/session/start-session-payload.test.mjs` pins the request body
// across the change.
export function StartSessionDialog({
  approvalOptions = [],
  effortOptions = [],
  fields = {},
  gitContext = null,
  id,
  initialPromptAttachmentsId = null,
  attachControl = null,
  modelsStatus = "ready",
  onCreateProject = null,
  onFieldChange = null,
  // Model selection is reported through its OWN callback, not as two
  // onFieldChange calls. Provider, model and effort have to move together: the
  // effort levels are model-specific, so a Codex `xhigh` carried onto a Claude
  // model that only offers high/max is submitted verbatim and the relay honours
  // it. Two sequential field changes cannot be resolved atomically by either
  // host — the second one reads catalogues from the render before the first.
  onSelectModel = null,
  onRequestClose = null,
  onStart = null,
  projects = [],
  providerModels = {},
  providers = [],
  // Claude consumes its first prompt at thread creation, so an empty prompt
  // would start a session that cannot be talked to until it is re-prompted.
  requireInitialPrompt = true,
  startPending = false,
  threadActivity = null,
  threadAttention = null,
  threadProjectId = {},
  threadReviewing = null,
  threads = [],
  workspaceSuggestions = [],
}) {
  const cwd = fields.cwd || "";
  const provider = fields.provider || "";
  const isClaudeCode = provider === "claude_code";
  const requiresInitialPrompt = requireInitialPrompt && isClaudeCode;
  const hasInitialPrompt = Boolean(fields.initialPrompt?.trim());
  const startDisabled =
    startPending || !cwd.trim() || (requiresInitialPrompt && !hasInitialPrompt);

  const modelChip = selectedModelChip({
    providerModels,
    selectedModel: fields.model || "",
    selectedProvider: provider,
  });

  const submit = () => {
    if (startDisabled) {
      return;
    }
    // Close optimistically so the user immediately sees the (possibly pending)
    // session view, then let the host fire the actual start.
    document.getElementById(id)?.close?.();
    onStart?.();
  };

  const selectedApproval = approvalOptions.find((option) => option.value === fields.approvalPolicy);
  const selectedEffort = effortOptions.find((option) => option.value === fields.effort);

  return h(
    SessionDialogShell,
    {
      actions: [
        h(
          "button",
          {
            className: "session-dialog-cancel",
            key: "cancel",
            onClick: () => {
              onRequestClose?.();
              document.getElementById(id)?.close?.();
            },
            type: "button",
          },
          "Cancel"
        ),
        h(
          "button",
          {
            className: "session-dialog-submit",
            disabled: startDisabled,
            id: `${id}-start`,
            key: "start",
            onClick: submit,
            type: "button",
          },
          startPending ? "Starting…" : "Start session",
          h(SubmitShortcutHint)
        ),
      ],
      // Honest copy. Sessions do NOT run in a fresh worktree — only Task-team
      // runs provision one (state/app/worktree.rs is called solely from
      // start_team_run). Saying otherwise would promise isolation the session
      // does not have, which is exactly the promise someone would rely on before
      // letting an agent write.
      footerHint: cwd ? `Runs in ${abbreviateHomePath(cwd)}` : "Choose a directory to run in",
      id,
      onRequestClose,
      title: "New session",
    },
    h(SessionContextBar, {
      key: "context",
      project: h(ProjectPicker, {
        activeProjectId: fields.projectId || null,
        onCreateProject,
        onSelectProject: (projectId) => onFieldChange?.("projectId", projectId),
        projects,
        threadActivity,
        threadAttention,
        threadProjectId,
        threadReviewing,
        threads,
      }),
      workspace: h(WorkspacePicker, {
        gitContext,
        inputId: `${id}-cwd`,
        onChange: (next) => onFieldChange?.("cwd", next),
        suggestions: workspaceSuggestions,
        value: cwd,
      }),
    }),
    h(PromptCard, {
      // `hidden` is deliberately NOT set here. The host fills this mount
      // imperatively and toggles visibility as chips come and go; letting React
      // own the attribute meant every re-render (a keystroke in the prompt) reset
      // it to true and hid attachments the user had just pasted.
      accessory: initialPromptAttachmentsId
        ? h("div", {
            "aria-live": "polite",
            className: "composer-attachments start-session-attachments",
            id: initialPromptAttachmentsId,
          })
        : null,
      attachControl,
      hint: requiresInitialPrompt
        ? "Claude Code starts when you send the first prompt"
        : "Leave empty to start idle",
      id: `${id}-start-prompt`,
      key: "prompt",
      onChange: (next) => onFieldChange?.("initialPrompt", next),
      onSubmit: submit,
      placeholder: initialPromptAttachmentsId
        ? "What should it work on? Paste an image to attach it."
        : "What should it work on?",
      value: fields.initialPrompt ?? "",
    }),
    h(
      SettingPillRow,
      { key: "pills" },
      h(SettingPill, {
        groups: buildModelPickerGroups({
          providerModels,
          providers,
          selectedModel: fields.model || "",
          selectedProvider: provider,
        }),
        id: `${id}-model`,
        key: "model",
        label: "Model",
        onSelect: (value, option) => {
          onSelectModel?.({ model: value, provider: option.provider || provider });
        },
        tag: modelChip.tag,
        value: modelChip.value,
      }),
      h(SettingPill, {
        id: `${id}-effort`,
        key: "effort",
        label: "Effort",
        onSelect: (value) => onFieldChange?.("effort", value),
        options: effortOptions.map((option) => ({
          ...option,
          selected: option.value === fields.effort,
        })),
        value: selectedEffort?.label || fields.effort || "default",
      }),
      h(SettingPill, {
        id: `${id}-approval`,
        key: "approval",
        label: "Permissions",
        onSelect: (value) => onFieldChange?.("approvalPolicy", value),
        options: approvalOptions.map((option) => ({
          ...option,
          selected: option.value === fields.approvalPolicy,
        })),
        tag: selectedApproval?.tag || null,
        value: selectedApproval?.label || fields.approvalPolicy || "default",
      })
    ),
    modelsStatus === "loading" || modelsStatus === "error"
      ? h(
          "p",
          {
            className: "session-dialog-note",
            "data-models-status": modelsStatus,
            id: `${id}-models-hint`,
            key: "models-hint",
          },
          modelsStatus === "loading"
            ? "Loading models…"
            : "Couldn’t load the model list — switch provider or reconnect to retry."
        )
      : null
  );
}
