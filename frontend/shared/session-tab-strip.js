import React from "react";

import { selectThreadDot } from "./thread-dot.js";

const { useState } = React;
const h = React.createElement;

// The tab strip for a project's open sessions — Chrome/terminal shaped: pinned
// tabs hold a zone on the left, the focused tab is highlighted, tabs can be
// closed and dragged to reorder.
//
// Ordering is NOT decided here. The caller passes `items` already in strip order
// (pinned first), which is what `shared/tab-layout.js` guarantees; this component
// only reports intent (`onFocus` / `onClose` / `onTogglePin` / `onMove`) and lets
// the model own the invariants. Same split as ProjectSidebarList: a precomputed
// view model in, callbacks out.
//
// `onMove(tabId, toIndex)` uses the target tab's CURRENT index as the dragged
// tab's final index, which reads correctly dragging in either direction.
//
// Mobile: the strip scrolls horizontally and every action is an explicit control
// (a × button, a pin button) — there is no right-click or hover affordance to
// depend on. Closing a tab only closes the view; the session is untouched.

function CloseGlyph() {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      width: "12",
      height: "12",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2.2",
      strokeLinecap: "round",
    },
    h("path", { d: "M6 6l12 12M18 6L6 18" })
  );
}

function PinGlyph({ filled }) {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      width: "12",
      height: "12",
      viewBox: "0 0 24 24",
      fill: filled ? "currentColor" : "none",
      stroke: "currentColor",
      strokeWidth: "1.8",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    h("path", { d: "M12 17v4" }),
    h("path", { d: "M7 4h10l-1.2 7.2a2 2 0 0 0 .6 1.8L18 15H6l1.6-2a2 2 0 0 0 .6-1.8z" })
  );
}

function SessionTab({
  item,
  focused,
  isDragging,
  isDropTarget,
  onFocus,
  onClose,
  onTogglePin,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}) {
  // One source of truth for the activity dot, shared with the thread list and
  // project cards — a tab must never disagree with the sidebar about a session.
  const dot = selectThreadDot({
    activity: item.activity || null,
    attentionKind: item.attentionKind || null,
    reviewing: Boolean(item.reviewing),
  });

  return h(
    "div",
    {
      className:
        `session-tab${focused ? " is-focused" : ""}`
        + `${item.pinned ? " is-pinned" : ""}`
        + `${isDragging ? " is-dragging" : ""}`
        + `${isDropTarget ? " is-drop-target" : ""}`,
      "data-tab-id": item.tabId,
      "data-thread-id": item.threadId,
      draggable: true,
      onDragStart: (event) => onDragStart(event, item.tabId),
      onDragOver: (event) => onDragOver(event, item.tabId),
      onDrop: (event) => onDrop(event, item.tabId),
      onDragEnd,
    },
    h(
      "button",
      {
        type: "button",
        role: "tab",
        "aria-selected": focused ? "true" : "false",
        className: "session-tab-main",
        onClick: () => onFocus?.(item.tabId),
        title: item.tooltip || item.title,
      },
      dot
        ? h("span", { className: dot.className, "aria-hidden": "true" })
        : h("span", { className: "session-tab-dot-placeholder", "aria-hidden": "true" }),
      h("span", { className: "session-tab-title" }, item.title),
      dot ? h("span", { className: "sr-only" }, dot.label) : null
    ),
    h(
      "button",
      {
        type: "button",
        className: `session-tab-pin${item.pinned ? " is-pinned" : ""}`,
        title: item.pinned ? "Unpin tab" : "Pin tab",
        "aria-label": item.pinned ? `Unpin ${item.title}` : `Pin ${item.title}`,
        "aria-pressed": item.pinned ? "true" : "false",
        onClick: (event) => {
          event.stopPropagation();
          onTogglePin?.(item.tabId, !item.pinned);
        },
      },
      h(PinGlyph, { filled: item.pinned })
    ),
    h(
      "button",
      {
        type: "button",
        className: "session-tab-close",
        title: "Close tab",
        "aria-label": `Close ${item.title}`,
        onClick: (event) => {
          event.stopPropagation();
          onClose?.(item.tabId);
        },
      },
      h(CloseGlyph)
    )
  );
}

export function SessionTabStrip({
  items = [],
  focusedTabId = null,
  onFocus = null,
  onClose = null,
  onTogglePin = null,
  onMove = null,
  onNewTab = null,
  emptyMessage = "No open sessions.",
}) {
  const [draggingId, setDraggingId] = useState(null);
  const [dropTargetId, setDropTargetId] = useState(null);

  const clearDrag = () => {
    setDraggingId(null);
    setDropTargetId(null);
  };

  const handleDragStart = (event, tabId) => {
    setDraggingId(tabId);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      try {
        event.dataTransfer.setData("text/plain", tabId);
      } catch {
        // Some browsers restrict setData outside a user gesture; `draggingId` in
        // state is the source of truth and dataTransfer is only a courtesy.
      }
    }
  };

  const handleDragOver = (event, tabId) => {
    if (!draggingId) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    if (tabId !== dropTargetId) {
      setDropTargetId(tabId);
    }
  };

  const handleDrop = (event, tabId) => {
    event.preventDefault();
    if (draggingId && draggingId !== tabId) {
      const toIndex = items.findIndex((item) => item.tabId === tabId);
      if (toIndex >= 0) {
        onMove?.(draggingId, toIndex);
      }
    }
    clearDrag();
  };

  if (!items.length) {
    return h(
      "div",
      { className: "session-tab-strip is-empty", role: "tablist", "aria-label": "Open sessions" },
      h("p", { className: "session-tab-empty" }, emptyMessage),
      onNewTab
        ? h(
            "button",
            {
              type: "button",
              className: "session-tab-new",
              title: "Open a session",
              "aria-label": "Open a session",
              onClick: () => onNewTab(),
            },
            "+"
          )
        : null
    );
  }

  return h(
    "div",
    { className: "session-tab-strip", role: "tablist", "aria-label": "Open sessions" },
    ...items.map((item) =>
      h(SessionTab, {
        key: item.tabId,
        item,
        focused: item.tabId === focusedTabId,
        isDragging: draggingId === item.tabId,
        isDropTarget: dropTargetId === item.tabId && draggingId !== item.tabId,
        onFocus,
        onClose,
        onTogglePin,
        onDragStart: handleDragStart,
        onDragOver: handleDragOver,
        onDrop: handleDrop,
        onDragEnd: clearDrag,
      })
    ),
    onNewTab
      ? h(
          "button",
          {
            type: "button",
            className: "session-tab-new",
            title: "Open a session",
            "aria-label": "Open a session",
            onClick: () => onNewTab(),
          },
          "+"
        )
      : null
  );
}

/**
 * Build the strip's view model from a tab workspace plus the same per-thread
 * signal maps the sidebar is fed. Kept next to the component so a caller doesn't
 * have to know how a layout tree maps onto a tab label.
 *
 * `resolveThread(threadId)` returns `{ title, tooltip }` for a session. A tab
 * holding a split shows the first session's title with a pane count, which is
 * enough until panes get their own affordance.
 */
export function buildSessionTabItems({
  workspace = null,
  resolveThread = null,
  threadActivity = null,
  threadAttention = null,
  threadReviewing = null,
  layoutThreadIds = null,
} = {}) {
  const tabs = workspace?.tabs || [];
  return tabs.map((tab) => {
    const threadIds = layoutThreadIds ? layoutThreadIds(tab.layout) : [];
    const primaryId = threadIds[0] || "";
    const resolved = resolveThread?.(primaryId) || {};
    const paneSuffix = threadIds.length > 1 ? ` (${threadIds.length})` : "";
    return {
      tabId: tab.id,
      threadId: primaryId,
      pinned: Boolean(tab.pinned),
      title: `${resolved.title || "Session"}${paneSuffix}`,
      tooltip: resolved.tooltip || null,
      activity: threadActivity?.get?.(primaryId) || null,
      attentionKind: threadAttention?.get?.(primaryId) || null,
      reviewing: Boolean(threadReviewing?.has?.(primaryId)),
    };
  });
}
