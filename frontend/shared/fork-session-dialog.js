import React from "react";

import {
  FORK_PROJECT_INHERIT,
  FORK_PROJECT_NONE,
  INHERIT,
  forkFieldsAreSubmittable,
  forkInheritableFields,
  forkIsLossy,
  normalizeForkFields,
} from "./fork-fields.js";
import { ProjectPicker } from "./project-picker.js";
import { SettingPill } from "./setting-pill.js";
import { WorkspacePicker } from "./workspace-picker.js";
import { abbreviateHomePath } from "./workspace-chip-model.js";
import { buildModelPickerGroups, selectedModelChip } from "./model-picker-model.js";
import { providerLabel } from "./provider-labels.js";
import { formatRelativeTime } from "../remote/utils.js";
import {
  PromptCard,
  SessionContextBar,
  SessionDialogShell,
  SettingPillRow,
  SubmitShortcutHint,
} from "./session-dialog-chrome.js";

const h = React.createElement;

const INHERIT_LABEL = "Inherit from source";

// A thread's preview can be its entire first message — a replay-fork handoff blob
// or a reviewer prompt runs to tens of thousands of characters. Rendering that in
// the source card overflowed the dialog before the fork was even created.
const MAX_SOURCE_LABEL_CHARS = 80;
function forkSourceLabel(sourceThread) {
  const raw = sourceThread?.name || sourceThread?.preview || sourceThread?.id || "session";
  const firstLine = String(raw).split("\n", 1)[0].trim() || "session";
  return firstLine.length > MAX_SOURCE_LABEL_CHARS
    ? `${firstLine.slice(0, MAX_SOURCE_LABEL_CHARS - 1)}…`
    : firstLine;
}

const BRANCH_ICON = h(
  "svg",
  {
    "aria-hidden": "true",
    className: "fork-source-icon",
    fill: "none",
    height: "16",
    stroke: "currentColor",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    strokeWidth: "1.6",
    viewBox: "0 0 24 24",
    width: "16",
  },
  h("circle", { cx: "6", cy: "6", r: "2.4" }),
  h("circle", { cx: "6", cy: "18", r: "2.4" }),
  h("circle", { cx: "18", cy: "10", r: "2.4" }),
  h("path", { d: "M6 8.4v7.2M8.4 6h4.2a3 3 0 0 1 3 3v.4" })
);

// A field the user has not touched is sent as null on purpose, so the relay
// resolves it from the SOURCE thread. That is a different request from choosing
// the same value explicitly, which is why the pill renders it as a distinct
// (dashed, tagged) state rather than showing a concrete value that would be a
// lie about what will be sent.
function inheritedPill({ inheritable, value }) {
  const isInherited = inheritable && value === INHERIT;
  return {
    inherited: isInherited,
    tag: isInherited ? "inherited" : null,
  };
}

function withInheritOption(options, inheritable) {
  return inheritable ? [{ value: INHERIT, label: INHERIT_LABEL }, ...(options || [])] : options || [];
}

export function ForkSessionDialog({
  approvalOptions = [],
  effortOptions = [],
  error = "",
  fields = {},
  forkCapabilities = [],
  gitContext = null,
  id = "fork-session-dialog",
  // Opt-in mount for pasted-image chips. Local passes an id; remote leaves it
  // null because a paired device cannot send image bytes at all.
  initialPromptAttachmentsId = null,
  modelsStatus = "ready",
  onCreateProject = null,
  onFieldChange = null,
  onFork = null,
  onRequestClose = null,
  onSelectModel = null,
  pending = false,
  projects = [],
  providerModels = {},
  providers = [],
  sourceThread = null,
  threadActivity = null,
  threadAttention = null,
  threadProjectId = {},
  threadReviewing = null,
  threads = [],
  workspaceSuggestions = [],
}) {
  const sourceTitle = forkSourceLabel(sourceThread);
  const sourceProvider = sourceThread?.provider || "";
  const targetProvider = fields.provider || sourceProvider;
  const inheritable = forkInheritableFields({ sourceProvider, targetProvider });
  // Normalize at render time so a catalog that arrives asynchronously seeds the
  // field too — a provider switch made before the models load would otherwise
  // leave the picker holding a value it never offers.
  const shownFields = normalizeForkFields(fields, {
    sourceProvider,
    models: providerModels[targetProvider] || [],
  });
  const submittable = forkFieldsAreSubmittable(shownFields, { sourceProvider });
  const lossy = forkIsLossy({
    sourceProvider,
    targetProvider,
    upToItemId: fields.upToItemId || "",
    forkPointIsTip: Boolean(fields.forkPointIsTip),
    capabilities: forkCapabilities,
  });

  const cwd = shownFields.cwd || "";
  const forkDisabled = pending || !sourceThread?.id || !cwd.trim() || !submittable;

  const closeDialog = () => {
    onRequestClose?.();
    document.getElementById(id)?.close?.();
  };
  const submit = () => {
    if (forkDisabled) {
      return;
    }
    onFork?.(shownFields);
  };

  const modelInherits = inheritable.has("model") && shownFields.model === INHERIT;
  const modelChip = modelInherits
    ? { tag: "inherited", value: INHERIT_LABEL }
    : selectedModelChip({
        providerModels,
        selectedModel: shownFields.model || "",
        selectedProvider: targetProvider,
      });

  const selectedApproval = approvalOptions.find(
    (option) => option.value === shownFields.approvalPolicy
  );
  const selectedEffort = effortOptions.find((option) => option.value === shownFields.effort);
  const approvalState = inheritedPill({
    inheritable: inheritable.has("approvalPolicy"),
    value: shownFields.approvalPolicy,
  });
  const effortState = inheritedPill({
    inheritable: inheritable.has("effort"),
    value: shownFields.effort,
  });

  return h(
    SessionDialogShell,
    {
      actions: [
        h(
          "button",
          { className: "session-dialog-cancel", key: "cancel", onClick: closeDialog, type: "button" },
          "Cancel"
        ),
        h(
          "button",
          {
            className: "session-dialog-submit",
            disabled: forkDisabled,
            id: `${id}-submit`,
            key: "fork",
            onClick: submit,
            type: "button",
          },
          pending ? "Forking…" : "Fork session",
          h(SubmitShortcutHint)
        ),
      ],
      // The badge says whether context survives; the footer says where the branch
      // lands. Both are honest about what the relay actually does: a fork runs in
      // the source's cwd unless told otherwise — it does NOT get its own worktree,
      // so the source and the branch share a working tree and can collide.
      badge: h(
        "span",
        {
          className: "session-dialog-badge" + (lossy ? " is-lossy" : ""),
          "data-fork-mode": lossy ? "replay" : "native",
        },
        lossy ? "transcript replay" : "full context preserved"
      ),
      footerHint: cwd
        ? `Branches in ${abbreviateHomePath(cwd)} · the source keeps running`
        : "Choose a directory for the branch",
      id,
      onRequestClose,
      title: "Fork session",
    },
    h(
      "div",
      { className: "fork-source-card", key: "source" },
      BRANCH_ICON,
      h(
        "div",
        { className: "fork-source-text" },
        h("span", { className: "fork-source-eyebrow" }, "Forking from"),
        h("span", { className: "fork-source-title", title: sourceTitle }, sourceTitle),
        h(
          "span",
          { className: "fork-source-meta" },
          [
            fields.upToItemId ? "from a message mid-session" : null,
            // No message count: the relay has no honest one. It witnesses only
            // what it has loaded, which for a provider-paged Claude thread is a
            // fraction of the history — so any number here would be a floor
            // presented as a total. `updated_at` is server-corrected and real.
            sourceThread?.updated_at
              ? `last active ${formatRelativeTime(sourceThread.updated_at)}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")
        )
      )
    ),
    lossy
      ? h(
          "p",
          { className: "session-dialog-note", "data-fork-mode": "replay", key: "lossy" },
          sourceProvider && targetProvider && sourceProvider !== targetProvider
            ? `Handing off ${providerLabel(sourceProvider)} → ${providerLabel(targetProvider)} by replaying the transcript. Provider-native state (tool results, cached context) will not carry over.`
            : "Branching mid-session replays the transcript. Provider-native state will not carry over."
        )
      : null,
    h(SessionContextBar, {
      key: "context",
      // Untouched, the picker shows the source's project is inherited rather than
      // naming a project the request will not actually carry.
      project: h(ProjectPicker, {
        activeProjectId:
          shownFields.projectId === FORK_PROJECT_INHERIT
          || shownFields.projectId === FORK_PROJECT_NONE
            ? null
            : shownFields.projectId,
        label: "Project",
        onCreateProject,
        onSelectProject: (projectId) =>
          onFieldChange?.("projectId", projectId === null ? FORK_PROJECT_NONE : projectId),
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
      accessory: initialPromptAttachmentsId
        ? h("div", {
            "aria-live": "polite",
            className: "composer-attachments start-session-attachments",
            id: initialPromptAttachmentsId,
          })
        : null,
      // A native fork already carries the source context, so an empty prompt
      // leaves the branch idle rather than burning a turn on a canned
      // instruction. A replay fork always sends one (the transcript IS the
      // prompt), which is why the hint differs.
      hint: lossy ? "Leave empty to replay and summarize" : "Leave empty to branch and wait",
      id: `${id}-start-prompt`,
      key: "prompt",
      onChange: (next) => onFieldChange?.("initialPrompt", next),
      onSubmit: submit,
      placeholder: initialPromptAttachmentsId
        ? "What should the fork try instead? Paste an image to attach it."
        : "What should the fork try instead?",
      value: shownFields.initialPrompt ?? "",
    }),
    h(
      SettingPillRow,
      { key: "pills" },
      h(SettingPill, {
        groups: (inheritable.has("model")
          ? [
              {
                empty: false,
                label: null,
                options: [
                  {
                    label: INHERIT_LABEL,
                    provider: sourceProvider,
                    selected: modelInherits,
                    tag: null,
                    value: INHERIT,
                  },
                ],
                provider: "__inherit__",
              },
            ]
          : []
        ).concat(
          buildModelPickerGroups({
            providerModels,
            providers,
            selectedModel: modelInherits ? "" : shownFields.model || "",
            selectedProvider: targetProvider,
          })
        ),
        id: `${id}-model`,
        inherited: modelInherits,
        key: "model",
        label: "Model",
        onSelect: (value, option) =>
          onSelectModel?.({ model: value, provider: option.provider || targetProvider }),
        tag: modelChip.tag,
        value: modelChip.value,
      }),
      h(SettingPill, {
        id: `${id}-effort`,
        inherited: effortState.inherited,
        key: "effort",
        label: "Effort",
        onSelect: (value) => onFieldChange?.("effort", value),
        options: withInheritOption(effortOptions, inheritable.has("effort")).map((option) => ({
          ...option,
          selected: option.value === shownFields.effort,
        })),
        tag: effortState.tag,
        value: effortState.inherited
          ? INHERIT_LABEL
          : selectedEffort?.label || shownFields.effort || "default",
      }),
      h(SettingPill, {
        id: `${id}-approval`,
        inherited: approvalState.inherited,
        key: "approval",
        label: "Permissions",
        onSelect: (value) => onFieldChange?.("approvalPolicy", value),
        options: withInheritOption(
          approvalOptions,
          inheritable.has("approvalPolicy")
        ).map((option) => ({ ...option, selected: option.value === shownFields.approvalPolicy })),
        tag: approvalState.tag || selectedApproval?.tag || null,
        value: approvalState.inherited
          ? INHERIT_LABEL
          : selectedApproval?.label || shownFields.approvalPolicy || "default",
      })
    ),
    error
      ? h(
          "p",
          {
            className: "session-dialog-note is-error",
            "data-fork-error": "true",
            key: "error",
            role: "alert",
          },
          error
        )
      : null,
    modelsStatus === "loading" || modelsStatus === "error"
      ? h(
          "p",
          {
            className: "session-dialog-note",
            "data-models-status": modelsStatus,
            id: `${id}-models-hint`,
            key: "models-hint",
          },
          modelsStatus === "loading" ? "Loading models…" : "Couldn’t load the model list."
        )
      : null
  );
}
