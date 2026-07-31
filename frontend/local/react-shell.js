import React from "react";
import { ClientLog } from "../shared/client-log.js";
import { ConversationComposer } from "../shared/composer.js";
import { RefreshButton } from "../shared/refresh-button.js";
import { StartSessionDialog } from "../shared/start-session-dialog.js";
import { ThemePickerRow } from "../shared/theme-picker.js";
import { PLUS_SVG, CHEVRON_RIGHT_SVG, SETTINGS_SVG } from "../svg.js";

const h = React.createElement;

// Far-left 64px icon rail: brand logo (top) and a Settings gear (bottom). The
// rail lives OUTSIDE the .app-shell grid (in .local-frame) so the grid math is
// untouched. The gear is wired imperatively in app.js by id (#icon-rail-settings).
function IconRail() {
  return h(
    "nav",
    { className: "icon-rail", "aria-label": "Primary" },
    h("img", {
      className: "icon-rail-logo",
      src: "/static/sealwire_logo.png",
      alt: "Sealwire",
      width: 30,
      height: 30,
    }),
    h("div", { className: "icon-rail-spacer" }),
    h(
      "button",
      {
        className: "icon-rail-button icon-rail-settings",
        id: "icon-rail-settings",
        type: "button",
        title: "Settings",
        "aria-label": "Settings",
      },
      h("span", { className: "inline-icon", "aria-hidden": "true", dangerouslySetInnerHTML: { __html: SETTINGS_SVG } })
    )
  );
}

function iconNode(svgMarkup, extraClass = "") {
  return h("span", {
    className: extraClass ? `inline-icon ${extraClass}` : "inline-icon",
    "aria-hidden": "true",
    dangerouslySetInnerHTML: { __html: svgMarkup },
  });
}

function Sidebar({ launchModel = null, onLaunchFieldChange = null, onLaunchStart = null }) {
  return h(
    "aside",
    { className: "sidebar", "data-thread-view": "sessions" },
    h(
      "div",
      { className: "sidebar-top-bar" },
      h(
        "button",
        {
          "aria-label": "Hide navigation panel",
          className: "header-button header-panel-toggle sidebar-top-toggle",
          id: "sidebar-top-toggle",
          title: "Hide navigation panel (⌘B)",
          type: "button",
        },
        h(ToggleLeftPanelIcon)
      ),
      // The seal sits in the lockup, not in the icon rail. The rail is only up
      // while the sidebar is collapsed, so leaving the brand there would mean the
      // app has no mark at all in its normal, expanded state. Matches how the
      // remote shell has always built this row. `alt` is empty because the
      // wordmark beside it already names the app.
      h(
        "div",
        { className: "sidebar-brand" },
        h("img", {
          className: "sidebar-brand-logo",
          src: "/static/sealwire_logo.png",
          alt: "",
          width: 24,
          height: 24,
        }),
        h("span", { className: "sidebar-brand-name" }, "Sealwire")
      )
    ),
    h(AuthForm),
    // Group the sidebar by cwd folders (Sessions) or by Project. Lifted to the top
    // of the sidebar to match the projects mockup; wired imperatively in app.js by id.
    h(
      "div",
      { className: "thread-view-toggle", role: "group", "aria-label": "Group sessions by" },
      h(
        "button",
        { className: "thread-view-toggle-button is-active", id: "threads-view-sessions", type: "button" },
        "Sessions"
      ),
      h(
        "button",
        { className: "thread-view-toggle-button", id: "threads-view-projects", type: "button" },
        "Projects"
      )
    ),
    // Mode-gated primary actions: Sessions → New session; Projects → + New
    // project. Both stay mounted (ids intact); CSS hides the inactive one via
    // the sidebar's data-thread-view attribute. Neither is hidden in the
    // conversation view — the primary action stays reachable from a session.
    h(LaunchPanel, { launchModel, onLaunchFieldChange, onLaunchStart }),
    h(
      "div",
      { className: "projects-toolbar", id: "projects-toolbar" },
      h(
        "button",
        { className: "start-session-button", id: "projects-create-button", type: "button" },
        iconNode(PLUS_SVG),
        h("span", null, "New project")
      )
    ),
    h(ThreadDrawer),
    h(ThreadContextMenu),
    h(ProjectContextMenu),
    h("div", { id: "fork-session-dialog-root" }),
    // Footer: what the relay is doing on the left, the way into Settings on the
    // right. The gear is the DESKTOP entry now that the icon rail only exists
    // while the sidebar is collapsed. It is not the only one — this whole bar is
    // `display: none` on local mobile, which is what #open-settings-header in the
    // chat header covers. Wired imperatively in app.js by id, like the rail gear.
    h(
      "div",
      { className: "sidebar-bottom-bar sidebar-host-status", id: "sidebar-host-status" },
      h("span", { className: "sidebar-host-dot", id: "sidebar-host-dot", "aria-hidden": "true" }),
      h("span", { className: "sidebar-host-label", id: "sidebar-host-label" }, "Local relay · Live"),
      h(
        "button",
        {
          className: "sidebar-settings-button",
          id: "sidebar-settings",
          type: "button",
          title: "Settings",
          "aria-label": "Settings",
        },
        iconNode(SETTINGS_SVG)
      )
    ),
    h("div", {
      className: "sidebar-resize",
      id: "sidebar-resize",
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": "Resize navigation panel",
      tabIndex: 0,
    })
  );
}

function AuthForm() {
  return h(
    "form",
    { className: "workspace-form auth-form", hidden: true, id: "connection-form" },
    h("label", { className: "sidebar-label", htmlFor: "api-token-input" }, "API Token"),
    h(
      "div",
      { className: "workspace-picker" },
      h("input", {
        autoComplete: "off",
        id: "api-token-input",
        placeholder: "Enter RELAY_API_TOKEN to sign in",
        type: "password",
      }),
      h("button", { className: "load-button", id: "apply-token-button", type: "submit" }, "Sign In")
    )
  );
}

function LaunchPanel({ launchModel = null, onLaunchFieldChange = null, onLaunchStart = null }) {
  const m = launchModel || {};
  return h(
    "section",
    { className: "launch-panel" },
    h(
      "div",
      { className: "launch-actions" },
      h(
        "button",
        {
          className: "start-session-button",
          id: "open-start-session-dialog",
          onClick: () => document.getElementById("launch-start-session-dialog")?.setAttribute("open", ""),
          type: "button",
        },
        iconNode(PLUS_SVG),
        h("span", null, "New session")
      )
    ),
  );
}

function LaunchStartSessionDialog({ launchModel, onLaunchFieldChange }) {
  const m = launchModel || {};
  return h(StartSessionDialog, {
    id: "launch-start-session-dialog",
    cwd: m.fields?.cwd || "",
    fields: m.fields || {},
    onFieldChange: onLaunchFieldChange || (() => {}),
    // StartSessionDialog auto-closes itself on Start click; the actual API
    // call fires from app.js via the #start-session-button document listener.
    onStart: null,
    startPending: false,
    providerOptions: m.providerOptions || [],
    models: m.models || [],
    approvalOptions: m.approvalOptions || [],
    effortOptions: m.effortOptions || [],
    workspaceInputId: "cwd-input",
    suggestionsListId: "workspace-suggestions",
    startButtonId: "start-session-button",
    initialPromptAttachmentsId: "start-prompt-attachments",
    labels: {
      initialPromptPlaceholder: "Optional first task. Paste an image to attach it.",
    },
    settingsPrefix: "",
    directoryFormId: "directory-form",
    loadButtonId: "load-directory-button",
    // Claude supports deferred start — the relay accepts no initial prompt
    // and promotes the session on the first composer message.
    requireInitialPrompt: false,
  });
}

function ThreadDrawer() {
  return h(
    "details",
    { className: "sidebar-drawer" },
    h(
      "summary",
      { className: "sidebar-drawer-summary" },
      h(
        "div",
        null,
        h("p", { className: "sidebar-caption" }, "Sessions"),
        h("p", { className: "sidebar-hint", id: "threads-count" }, "Loading workspace groups...")
      ),
      h(RefreshButton, { id: "threads-refresh-button", label: "Refresh sessions" })
    ),
    h(
      "div",
      { className: "sidebar-drawer-body" },
      h(
        "div",
        {
          className: "conversation-list",
          "data-thread-list-scroll-root": "",
          id: "threads-list",
        },
        h("p", { className: "sidebar-empty" }, "Sessions will appear here once the relay loads saved workspaces.")
      )
    )
  );
}

function ThreadContextMenu() {
  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "context-menu", hidden: true, id: "thread-context-menu" },
      h("button", { className: "context-menu-button", id: "fork-thread-button", type: "button" }, "Fork session"),
      h("button", { className: "context-menu-button", id: "archive-thread-button", type: "button" }, "Archive session"),
      h("button", {
        className: "context-menu-button context-menu-button-danger",
        id: "delete-thread-button",
        type: "button",
      }, "Delete permanently"),
      // Per-session Project assignment is one row here — "Projects  <current> ›" — that
      // opens the submenu below. Flat-listing every Project at this level buried the
      // session actions once a few Projects existed.
      h("div", { className: "context-menu-separator", role: "separator" }),
      h(
        "button",
        {
          className: "context-menu-button context-menu-submenu-trigger",
          id: "thread-project-submenu-trigger",
          type: "button",
          "aria-haspopup": "true",
          "aria-expanded": "false",
          "aria-controls": "thread-project-submenu",
        },
        h("span", { className: "context-menu-submenu-title" }, "Projects"),
        h("span", { className: "context-menu-submenu-value", id: "thread-project-current-label" }, "None"),
        iconNode(CHEVRON_RIGHT_SVG, "context-menu-submenu-chevron")
      )
    ),
    // Second level, a SIBLING of the menu (not a child): the menu scrolls its own
    // overflow, and nesting the submenu inside would let that clip it. Positioned
    // imperatively against the trigger in app.js, and populated there when it opens
    // (one button per Project + unassign + "New project…") from state.projects and the
    // thread's current membership.
    h(
      "div",
      { className: "context-menu context-menu-submenu", hidden: true, id: "thread-project-submenu", role: "menu" },
      h("div", { className: "context-menu-projects", id: "thread-project-actions" })
    )
  );
}

// Right-click menu for a project row in the sidebar (Projects mode). Rename/Delete
// reuse the existing renameProject/deleteProject handlers (app.js). Positioned +
// toggled imperatively by id, mirroring #thread-context-menu.
function ProjectContextMenu() {
  return h(
    "div",
    { className: "context-menu", hidden: true, id: "project-context-menu" },
    h("button", { className: "context-menu-button", id: "rename-project-button", type: "button" }, "Rename project"),
    h("button", {
      className: "context-menu-button context-menu-button-danger",
      id: "delete-project-button",
      type: "button",
    }, "Delete project")
  );
}

function InfoIcon() {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      fill: "none",
      height: "14",
      viewBox: "0 0 16 16",
      width: "14",
      stroke: "currentColor",
      strokeWidth: "1.4",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    h("circle", { cx: "8", cy: "8", r: "6.25" }),
    h("line", { x1: "8", y1: "7.3", x2: "8", y2: "11.5" }),
    h("circle", { cx: "8", cy: "5", r: "0.7", fill: "currentColor", stroke: "none" })
  );
}

function BackArrowIcon() {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      fill: "none",
      height: "14",
      viewBox: "0 0 16 16",
      width: "14",
      stroke: "currentColor",
      strokeWidth: "1.6",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    h("path", { d: "M10 3.5L5.5 8L10 12.5" })
  );
}

function ToggleLeftPanelIcon() {
  return h(
    "svg",
    { "aria-hidden": "true", fill: "none", height: "16", viewBox: "0 0 16 16", width: "16", stroke: "currentColor", strokeWidth: "1.4" },
    h("rect", { x: "1.5", y: "2.5", width: "13", height: "11", rx: "2" }),
    h("line", { x1: "6", y1: "2.5", x2: "6", y2: "13.5" })
  );
}

function ToggleRightPanelIcon() {
  return h(
    "svg",
    { "aria-hidden": "true", fill: "none", height: "16", viewBox: "0 0 16 16", width: "16", stroke: "currentColor", strokeWidth: "1.4" },
    h("rect", { x: "1.5", y: "2.5", width: "13", height: "11", rx: "2" }),
    h("line", { x1: "10", y1: "2.5", x2: "10", y2: "13.5" })
  );
}

function ComposeIcon() {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      fill: "none",
      height: "16",
      viewBox: "0 0 16 16",
      width: "16",
      stroke: "currentColor",
      strokeWidth: "1.4",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    h("path", { d: "M2.5 13.5h4l6.5-6.5a1.8 1.8 0 0 0-2.5-2.5L4 11v2.5z" }),
    h("path", { d: "M10 5.5l2 2" })
  );
}

function ChatHeader() {
  return h(
    "header",
    { className: "chat-header" },
    h(
      "div",
      { className: "chat-header-leading" },
      h(
        "div",
        { className: "chat-header-collapsed-actions" },
        h(
          "button",
          {
            "aria-label": "Show navigation panel",
            className: "header-button header-panel-toggle header-panel-toggle-left",
            id: "toggle-left-panel",
            type: "button",
            title: "Show navigation panel (⌘B)",
          },
          h(ToggleLeftPanelIcon)
        ),
        h(
          "button",
          {
            "aria-label": "Start new session",
            className: "header-button header-compose-button",
            id: "new-session-compose-button",
            type: "button",
            title: "Start new session",
          },
          h(ComposeIcon)
        )
      ),
      h(
        "button",
        {
          className: "header-icon-button chat-heading-back-button",
          hidden: true,
          id: "go-console-home",
          title: "Back to console",
          "aria-label": "Back to console",
          type: "button",
        },
        h(BackArrowIcon)
      ),
      h(
        "div",
        { className: "chat-heading" },
        h(
          "div",
          { className: "chat-heading-title-row" },
          h("h1", { id: "workspace-title" }, "Relay console"),
          h(
            "button",
            {
              "aria-label": "Session details",
              className: "header-icon-button chat-heading-info-button",
              id: "open-session-details",
              type: "button",
              title: "Session details",
            },
            h(InfoIcon)
          ),
        ),
        h("p", { className: "chat-subtitle", id: "workspace-subtitle" })
      )
    ),
    h(
      "div",
      { className: "chat-header-actions" },
      h("span", {
        className: "model-badge-compact",
        hidden: true,
        id: "local-model-badge",
      }),
      h("span", { className: "status-badge", id: "status-badge" }, "Idle"),
      // Mobile-only Settings entry: the icon rail (which holds the gear) is hidden
      // ≤960px, so this keeps Providers/Devices/Log/Appearance reachable in every
      // view (the header is always present, even in conversation where the sidebar
      // collapses). Hidden on desktop via CSS.
      h(
        "button",
        {
          className: "header-button header-settings-button",
          id: "open-settings-header",
          type: "button",
          title: "Settings",
          "aria-label": "Settings",
        },
        iconNode(SETTINGS_SVG)
      ),
      // Shown only when the title is naming a PROJECT (see header-labels.js): starting
      // an agent into a project is the action that belongs to one. render-session.js
      // owns the hidden flag and the project id. Lives in the header actions — beside
      // the panel toggle — rather than inline with the title, so it reads as an action
      // and lines up with the other header controls.
      h(
        "button",
        {
          className: "header-new-agent-button",
          hidden: true,
          id: "header-new-agent",
          type: "button",
          title: "Start an agent in this project",
        },
        iconNode(PLUS_SVG),
        h("span", null, "New agent")
      ),
      h(
        "button",
        {
          "aria-label": "Toggle side panel",
          className: "header-button header-panel-toggle header-panel-toggle-right",
          id: "toggle-right-panel",
          type: "button",
          title: "Toggle side panel (⌥⌘B)",
        },
        h(ToggleRightPanelIcon)
      )
    )
  );
}

function OverviewStrip() {
  return h(
    "section",
    { "aria-label": "Relay overview", className: "overview-strip", id: "overview-strip" },
    h("div", { className: "overview-status-bar", id: "overview-security-badges" })
  );
}

function ConsoleGrid() {
  return h(
    "section",
    { className: "console-grid" },
    h(ThreadPanel)
  );
}

// "Recent events" audit — moved out of the retired console home into the
// Settings > Log tab. Keeps ids #audit-timeline / #audit-summary so the
// render-session.js populate path is unchanged.
function AuditTimelineCard() {
  return h(
    "details",
    // Collapsed by default: Recent events is a curated subset of the relay log
    // above, so it starts folded to avoid duplicating the same stream on open.
    { className: "console-card console-card-audit console-card-collapsible" },
    h(
      "summary",
      { className: "console-card-summary" },
      h("span", { className: "console-card-title" }, "Recent events"),
      h("span", { className: "console-card-hint", id: "audit-summary" }),
      h("span", {
        className: "console-card-summary-chevron",
        "aria-hidden": "true",
        dangerouslySetInnerHTML: { __html: CHEVRON_RIGHT_SVG },
      })
    ),
    h(
      "div",
      { className: "audit-list", id: "audit-timeline" },
      h("p", { className: "sidebar-empty" }, "No events yet.")
    )
  );
}

function ThreadPanel() {
  return h(
    "section",
    { className: "thread-panel" },
    h(
      "section",
      { className: "thread-shell" },
      h(
        "div",
        { className: "chat-thread", id: "transcript" },
        h(
          "div",
          { className: "thread-empty" },
          h("h2", null, "Relay standing by"),
          h("p", null, "Load a workspace, then use this console to watch the live session, control state, and trusted devices.")
        )
      )
    )
  );
}

function ComposerShell() {
  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "workspace-diff-chip-host" },
      h("div", { className: "workspace-diff-chip-slot", id: "workspace-diff-chip-mount" }),
      h("div", { className: "workspace-diff-chip-slot", id: "reviewer-chip-mount" })
    ),
    h(
      "section",
      { className: "control-banner control-banner-compact", hidden: true, id: "control-banner" },
      h("span", { className: "control-summary", id: "control-summary" }, "Another device has control"),
      h(
        "button",
        {
          className: "control-button",
          id: "take-over-button",
          type: "button",
        },
        "Take over"
      )
    ),
    h(
      "form",
      { className: "composer-shell", hidden: true, id: "message-form" },
      h(ConversationComposer, {
        actionsBeforeSend: h("span", { id: "composer-settings-mount" }),
        attachmentArea: h("div", {
          className: "composer-attachments",
          hidden: true,
          id: "composer-attachments",
        }),
        // The local surface is always desktop: Enter sends, Shift+Enter is a newline.
        enterSubmits: true,
        messageId: "message-input",
        messagePlaceholder: "Start or open a session first.",
        modelId: "message-model",
        models: [{ display_name: "gpt-5.4", model: "gpt-5.4" }],
        sendButtonId: "send-button",
        stopButtonId: "stop-button",
      })
    )
  );
}

function WorkspaceChangesRail() {
  return h(
    "aside",
    {
      className: "right-rail",
      id: "workspace-changes-rail",
      "aria-label": "Workspace overview",
    },
    h("div", {
      className: "right-rail-resize",
      id: "right-rail-resize",
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": "Resize workspace panel",
      tabIndex: 0,
    }),
    h(
      "button",
      {
        "aria-label": "Hide workspace panel",
        className: "header-button header-panel-toggle rail-top-toggle",
        id: "rail-top-toggle",
        title: "Hide workspace panel (⌥⌘B)",
        type: "button",
      },
      h(ToggleRightPanelIcon)
    ),
    h("div", { id: "workspace-changes-mount" })
  );
}

function ChatShell() {
  return h(
    "main",
    { className: "chat-shell", "data-view": "console" },
    h(ChatHeader),
    // Tab strip for the active project's open sessions. Filled by
    // renderSessionTabs() through its own React sub-root, like #client-log-root —
    // the shell is rendered once, so anything data-driven needs its own root.
    h("div", { className: "session-tab-strip-mount", id: "session-tab-strip-mount" }),
    h(OverviewStrip),
    // Projects "card overview" main-area view. Filled by renderProjectOverview();
    // shown only when data-view="project-overview" (CSS-gated like console/conversation).
    h("section", { className: "project-overview-mount", id: "project-overview" }),
    h(ConsoleGrid),
    h("div", { className: "pending-action-banner", id: "pending-action-banner", hidden: true }),
    h(
      "div",
      {
        className: "agent-working-indicator agent-working-indicator-ready",
        id: "agent-working-indicator",
        role: "status",
        "aria-live": "polite",
        hidden: true,
      },
      h("span", { className: "agent-working-indicator-dot", "aria-hidden": "true" }),
      h(
        "span",
        { className: "agent-working-indicator-label", id: "agent-working-indicator-label" },
        ""
      )
    ),
    h("div", { className: "review-idle-nudge", id: "review-idle-nudge", hidden: true }),
    h(ComposerShell)
  );
}

function SessionDetailsModal() {
  return h(
    "dialog",
    { className: "panel-modal panel-modal-wide", id: "session-details-modal" },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "Relay details"),
      h("button", {
        className: "header-button close-modal-btn",
        id: "close-session-details-modal",
        type: "button",
      }, "\u00d7")
    ),
    h(
      "section",
      { className: "panel-modal-body session-details-shell" },
      h(
        "section",
        { className: "details-section" },
        h("h3", { className: "details-heading" }, "Workspace"),
        h("p", { className: "details-path", id: "session-details-path" }, "No workspace path yet.")
      ),
      h(
        "section",
        { className: "details-section" },
        h("h3", { className: "details-heading" }, "Environment"),
        h("section", { className: "session-meta", id: "session-meta" }, h("span", { className: "meta-empty" }, "Session details will appear here."))
      ),
      h(
        "section",
        { className: "details-section" },
        h("h3", { className: "details-heading" }, "Build"),
        h("p", { className: "build-info-inline", id: "build-info-local" }, "Loading...")
      )
    )
  );
}

function WorkspaceDiffModal() {
  return h(
    "dialog",
    { className: "panel-modal panel-modal-wide", id: "workspace-diff-modal" },
    h(
      "div",
      { className: "modal-header" },
      // Title is mounted (createWorkspaceDiffSheet) so it follows the active tab.
      // Diff refresh now lives inside the Changes body, not this header.
      h("div", { className: "modal-title-slot", id: "workspace-diff-title" }),
      h(
        "div",
        { className: "modal-header-actions" },
        h(
          "button",
          {
            className: "header-button close-modal-btn",
            id: "close-workspace-diff-modal",
            type: "button",
          },
          "×"
        )
      )
    ),
    h(
      "section",
      { className: "panel-modal-body" },
      h("div", { id: "workspace-diff-mount" })
    )
  );
}

// The devices/security surface \u2014 extracted from the old standalone SecurityModal
// so it can be embedded in the Settings modal's Devices tab. Keeps every id
// (#pending-pairings-list, #pairing-panel, allowed-roots, #paired-devices-list\u2026)
// so dom.js/render-security.js/app.js wiring resolves unchanged.
function DevicesPanelBody() {
  return h(
    "section",
    { className: "remote-access-shell" },
    hSecuritySection("Pending Pairing Requests", "Approve or reject devices that are asking to pair."),
      h(
        "div",
        { className: "paired-devices-list", id: "pending-pairings-list" },
        h("p", { className: "sidebar-empty" }, "No devices are waiting for local approval.")
      ),
      h(
        "div",
        { className: "sidebar-row" },
        h(
          "div",
          null,
          h("p", { className: "sidebar-caption" }, "Remote Pairing"),
          h("p", { className: "sidebar-hint" }, "Create a QR link for the broker-hosted mobile surface.")
        ),
        h("button", { className: "sidebar-link-button", id: "start-pairing-button", type: "button" }, "New QR")
      ),
      h(
        "div",
        { className: "pairing-scope-row" },
        h("label", { className: "sidebar-label", htmlFor: "pairing-path-scope-input" }, "Pairing path scope (optional)"),
        h("input", {
          autoComplete: "off",
          id: "pairing-path-scope-input",
          list: "workspace-suggestions",
          placeholder: "/Users/me/projects/specific-repo",
          type: "text",
        }),
        h("p", { className: "sidebar-hint" }, "Limit the next QR's paired device to this path. Empty = no per-device restriction (relay roots still apply).")
      ),
      h(
        "section",
        { className: "pairing-panel", hidden: true, id: "pairing-panel" },
        h("div", { "aria-live": "polite", className: "pairing-qr", id: "pairing-qr" }),
        h("p", { className: "pairing-copy", id: "pairing-expiry" }, "Pairing ticket not created yet."),
        h("p", { className: "pairing-copy", id: "pairing-scope-summary" }),
        h("label", { className: "sidebar-label", htmlFor: "pairing-link-input" }, "Pairing Link"),
        h(
          "div",
          { className: "workspace-picker" },
          h("input", { id: "pairing-link-input", readOnly: true, type: "text" }),
          h("button", { className: "load-button", id: "copy-pairing-link-button", type: "button" }, "Copy")
        )
      ),
      hSecuritySection("Workspace Roots", "Limit every device on this relay to specific root directories. Leave empty for unrestricted access."),
      hAllowedRootsForm(),
      h(
        "div",
        { className: "paired-devices-list", id: "allowed-roots-list" },
        h("p", { className: "sidebar-empty" }, "No workspace restrictions are configured.")
      ),
      hSecuritySection("Device Security", "Review known devices, fingerprints, and broker access."),
      h(
        "div",
        { className: "paired-devices-list", id: "paired-devices-list" },
        h("p", { className: "sidebar-empty" }, "No remote devices have touched this relay yet.")
      )
  );
}

function hSecuritySection(caption, hint) {
  return h(
    "div",
    { className: "sidebar-row" },
    h(
      "div",
      null,
      h("p", { className: "sidebar-caption" }, caption),
      h("p", { className: "sidebar-hint" }, hint)
    )
  );
}

function hAllowedRootsForm() {
  return h(
    "form",
    { className: "workspace-form", id: "allowed-roots-form" },
    h("label", { className: "sidebar-label", htmlFor: "allowed-roots-input" }, "Allowed Roots"),
    h("textarea", {
      id: "allowed-roots-input",
      placeholder: "~/projects\n~/Documents/projects",
      rows: "4",
    }),
    h(
      "div",
      { className: "workspace-picker" },
      h("button", { className: "load-button", id: "save-allowed-roots-button", type: "submit" }, "Save roots")
    ),
    h("p", { className: "sidebar-hint", id: "allowed-roots-summary" }, "This relay is currently unrestricted.")
  );
}

// Consolidated Settings modal opened from the icon-rail gear. Four always-mounted
// tab panels (toggled by `hidden`, never conditionally rendered) so every id inside
// resolves at dom.js import time. Tab switching is wired imperatively in app.js
// (setSettingsTab) by the #settings-tab-* / data-settings-panel ids.
function SettingsModal() {
  const tab = (key, label, active = false) =>
    h(
      "button",
      {
        className: `settings-tab${active ? " is-active" : ""}`,
        id: `settings-tab-${key}`,
        type: "button",
        role: "tab",
        "aria-selected": active ? "true" : "false",
        "data-settings-tab": key,
      },
      label
    );
  const panel = (key, active, ...children) =>
    h(
      "div",
      { className: "settings-panel", "data-settings-panel": key, hidden: !active },
      ...children
    );
  return h(
    "dialog",
    { className: "settings-modal panel-modal panel-modal-wide", id: "settings-modal" },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "Settings"),
      h("button", {
        className: "header-button close-modal-btn",
        id: "close-settings-modal",
        type: "button",
      }, "×")
    ),
    h(
      "div",
      { className: "settings-tabs", role: "tablist", "aria-label": "Settings sections" },
      tab("providers", "Providers", true),
      tab("devices", "Devices"),
      tab("log", "Log"),
      tab("appearance", "Appearance")
    ),
    h(
      "section",
      { className: "panel-modal-body settings-body" },
      panel(
        "providers",
        true,
        h(
          "section",
          { className: "provider-status-panel", id: "provider-status-panel" },
          h("p", { className: "sidebar-caption" }, "Providers"),
          h("ul", { className: "provider-status-list", id: "provider-status-list" })
        )
      ),
      panel("devices", false, h(DevicesPanelBody)),
      panel(
        "log",
        false,
        h(
          "section",
          { className: "details-section" },
          h("h3", { className: "details-heading" }, "Relay log"),
          h(
            "div",
            { id: "client-log-root" },
            h(ClientLog, { lines: ["Booting web client..."] })
          )
        ),
        h("section", { className: "details-section" }, h(AuditTimelineCard))
      ),
      panel(
        "appearance",
        false,
        h("section", { className: "details-section" }, h(ThemePickerRow))
      )
    )
  );
}

function PairingApprovalModal() {
  return h(
    "dialog",
    { className: "panel-modal pairing-approval-modal", id: "pairing-approval-modal" },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "Approve pairing"),
      h("button", {
        className: "header-button close-modal-btn",
        id: "close-pairing-approval-modal",
        type: "button",
      }, "×")
    ),
    h(
      "section",
      { className: "panel-modal-body pairing-approval-shell" },
      h("p", { className: "panel-modal-copy", id: "pairing-approval-hint" },
        "A remote device is requesting access. Approve or reject before the request times out."),
      h("div", { className: "paired-devices-list", id: "pairing-approval-list" })
    )
  );
}

export function LocalShell({ launchModel = null, onLaunchFieldChange = null, onLaunchStart = null }) {
  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "local-frame" },
      h(IconRail),
      h(
        "div",
        { className: "app-shell app-shell-with-rail", "data-view": "console" },
        h(Sidebar, { launchModel, onLaunchFieldChange, onLaunchStart }),
        h(ChatShell),
        h(WorkspaceChangesRail)
      )
    ),
    h(LaunchStartSessionDialog, { launchModel, onLaunchFieldChange }),
    h(SessionDetailsModal),
    h(WorkspaceDiffModal),
    h(SettingsModal),
    h(PairingApprovalModal)
  );
}
