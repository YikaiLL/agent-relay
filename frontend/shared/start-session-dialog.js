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

// Fully controlled: every value arrives in `fields` and leaves through
// `onFieldChange`. `start-session-payload.test.mjs` pins the resulting request.
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
  onOpenModelPicker = null,
  // Its own callback, not two onFieldChange calls: provider, model and effort must
  // move together, and the second of two sequential calls reads a stale render.
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
      // Sessions do NOT get a worktree — only Task-team runs provision one — so
      // this must not promise isolation the session does not have.
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
      // `hidden` is the host's to set: React owning it re-hid pasted attachments
      // on the next keystroke.
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
        onOpen: onOpenModelPicker,
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
