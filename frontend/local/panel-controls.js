// One unified state model per panel: the CSS variable holds the displayed
// width, and "closed" is just "width === 0". A separate localStorage entry
// remembers the most recent non-zero width so the toggle button can restore it.
// Both the drag handle and the toggle button mutate the same variable; the
// drag handle also collapses to 0 when the user pulls past a small threshold.

const CLOSE_THRESHOLD = 80;
const DEFAULT_OPEN_WIDTH = 300;
const MOBILE_BREAKPOINT = 960;

export function createPanelControl({
  cssVarName,
  widthStorageKey,
  openWidthStorageKey,
  minOpenWidth = 200,
  maxOpenWidth = 520,
  defaultOpenWidth = DEFAULT_OPEN_WIDTH,
  side = "left",
  // Sidebar/rail can collapse to 0 and reopen via a toggle. Panels without a
  // reopen control (Tasks Orchestrator) must pass false so drag/keyboard never
  // store an unrecoverable zero width.
  collapsible = true,
  // Optional ceiling that can track a container (e.g. half the Tasks workspace).
  // Must stay in the controller — a CSS-only cap leaves drag/keyboard starting
  // from the uncapped stored width and creates a dead zone.
  resolveMaxOpenWidth = null,
}) {
  const root = document.documentElement;
  const widthFloor = collapsible ? 0 : minOpenWidth;

  function effectiveMax() {
    if (typeof resolveMaxOpenWidth !== "function") return maxOpenWidth;
    let resolved;
    try {
      resolved = resolveMaxOpenWidth();
    } catch (_error) {
      return maxOpenWidth;
    }
    if (resolved == null || !Number.isFinite(resolved)) return maxOpenWidth;
    // Never below minOpenWidth when the panel cannot collapse — otherwise the
    // floor and ceiling cross and every setWidth fights itself.
    return Math.min(maxOpenWidth, Math.max(minOpenWidth, Math.round(resolved)));
  }

  let openWidth = clamp(
    readNumber(openWidthStorageKey, defaultOpenWidth),
    minOpenWidth,
    maxOpenWidth
  );
  let currentWidth = readNumber(widthStorageKey, openWidth);
  if (!collapsible && currentWidth <= 0) {
    currentWidth = openWidth;
  }
  if (currentWidth > 0 && currentWidth < minOpenWidth) {
    currentWidth = minOpenWidth;
  }
  if (currentWidth > maxOpenWidth) currentWidth = maxOpenWidth;
  currentWidth = Math.min(currentWidth, effectiveMax());
  if (!collapsible && currentWidth < minOpenWidth) currentWidth = minOpenWidth;
  applyWidth(root, cssVarName, currentWidth);

  function getWidth() {
    return currentWidth;
  }

  function setWidth(value, { commit = true, updateOpenWidth = true } = {}) {
    const ceiling = effectiveMax();
    // Prefer the caller's intent up to the absolute max. Container ceiling only
    // affects what is painted — otherwise a temporary narrow shell rewrites the
    // saved desktop preference on every click/release.
    const intended = Math.max(widthFloor, Math.min(value, maxOpenWidth));
    const painted = Math.max(widthFloor, Math.min(intended, ceiling));
    currentWidth = painted;
    applyWidth(root, cssVarName, painted);
    if (updateOpenWidth && intended >= minOpenWidth) {
      openWidth = intended;
      writeNumber(openWidthStorageKey, intended);
    }
    if (commit) {
      // Persist intent when updating preference so a later wider container can
      // restore it. Closing (updateOpenWidth false) records the painted width.
      writeNumber(widthStorageKey, updateOpenWidth ? intended : painted);
    }
    emit();
  }

  function isOpen() {
    return currentWidth > 0;
  }

  function open() {
    setWidth(openWidth);
  }

  function close() {
    if (!collapsible) {
      setWidth(minOpenWidth, { updateOpenWidth: false });
      return;
    }
    setWidth(0, { updateOpenWidth: false });
  }

  function toggle() {
    if (!collapsible) {
      setWidth(defaultOpenWidth);
      return;
    }
    if (isOpen()) {
      close();
    } else {
      open();
    }
  }

  /** Paint preferred width clamped to the live container max without touching storage. */
  function reclampToContainer() {
    setWidth(openWidth, { commit: false, updateOpenWidth: false });
  }

  function getPreferredWidth() {
    return openWidth;
  }

  const listeners = new Set();
  function emit() {
    listeners.forEach((listener) => {
      try {
        listener({ width: currentWidth, isOpen: currentWidth > 0 });
      } catch (error) {
        console.warn("panel-control listener failed", error);
      }
    });
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener({ width: currentWidth, isOpen: currentWidth > 0 });
    return () => listeners.delete(listener);
  }

  function attachResizeHandle(handle) {
    if (!handle) return null;
    let dragging = false;
    let pointerId = null;
    let dragStartWidth = currentWidth;
    let dragStartX = 0;
    let dragMoved = false;

    function onPointerDown(event) {
      if (isMobile()) return;
      dragging = true;
      dragMoved = false;
      pointerId = event.pointerId;
      // Reclamp from the preferred width in case the container changed; do not
      // persist — a temporary narrow shell must not rewrite the saved preference.
      reclampToContainer();
      dragStartWidth = currentWidth;
      dragStartX = event.clientX;
      handle.setPointerCapture?.(event.pointerId);
      document.body.classList.add("is-resizing-panel");
      event.preventDefault();
    }

    function onPointerMove(event) {
      if (!dragging) return;
      const delta = event.clientX - dragStartX;
      if (Math.abs(delta) >= 1) dragMoved = true;
      const next = side === "left"
        ? dragStartWidth + delta
        : dragStartWidth - delta;
      setWidth(Math.max(widthFloor, Math.min(next, maxOpenWidth)), {
        commit: false,
        updateOpenWidth: false,
      });
    }

    function onPointerUp() {
      if (!dragging) return;
      dragging = false;
      if (pointerId != null && handle.releasePointerCapture) {
        try {
          handle.releasePointerCapture(pointerId);
        } catch (_error) {
          // ignore
        }
      }
      pointerId = null;
      document.body.classList.remove("is-resizing-panel");
      if (collapsible && currentWidth < CLOSE_THRESHOLD) {
        // Snap to 0 — user dragged past the close threshold.
        setWidth(0, { updateOpenWidth: false });
        return;
      }
      const snappedPaint = clamp(currentWidth, minOpenWidth, effectiveMax());
      // No-op click, or a drag that the container ceiling fully blocked: keep
      // the saved preference and only refresh the painted width.
      if (!dragMoved || snappedPaint === dragStartWidth) {
        reclampToContainer();
        return;
      }
      setWidth(snappedPaint);
    }

    function onDoubleClick() {
      // Intent is the default even when paint is container-capped.
      setWidth(defaultOpenWidth);
    }

    function onKeyDown(event) {
      if (isMobile()) return;
      const delta = event.shiftKey ? 32 : 8;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const growing =
          (event.key === "ArrowRight" && side === "left") ||
          (event.key === "ArrowLeft" && side === "right");
        const next = side === "left"
          ? currentWidth + (event.key === "ArrowRight" ? delta : -delta)
          : currentWidth + (event.key === "ArrowLeft" ? delta : -delta);
        const ceiling = effectiveMax();
        const painted = Math.max(widthFloor, Math.min(next, ceiling));
        // Blocked grow against the container cap must not rewrite preference.
        if (growing && painted === currentWidth) return;
        setWidth(Math.max(widthFloor, Math.min(next, maxOpenWidth)));
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    }

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);
    handle.addEventListener("dblclick", onDoubleClick);
    handle.addEventListener("keydown", onKeyDown);

    return {
      destroy() {
        handle.removeEventListener("pointerdown", onPointerDown);
        handle.removeEventListener("pointermove", onPointerMove);
        handle.removeEventListener("pointerup", onPointerUp);
        handle.removeEventListener("pointercancel", onPointerUp);
        handle.removeEventListener("dblclick", onDoubleClick);
        handle.removeEventListener("keydown", onKeyDown);
      },
    };
  }

  function attachToggleButton(button) {
    if (!button) return null;
    function onClick() {
      toggle();
    }
    button.addEventListener("click", onClick);
    const unsub = subscribe(({ isOpen: open }) => {
      button.setAttribute("aria-pressed", open ? "true" : "false");
      button.classList.toggle("is-active", open);
    });
    return {
      destroy() {
        button.removeEventListener("click", onClick);
        unsub();
      },
    };
  }

  return {
    getWidth,
    getPreferredWidth,
    setWidth,
    reclampToContainer,
    isOpen,
    open,
    close,
    toggle,
    subscribe,
    attachResizeHandle,
    attachToggleButton,
  };
}

function applyWidth(root, cssVarName, value) {
  root.style.setProperty(cssVarName, `${Math.round(value)}px`);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function readNumber(key, fallback) {
  if (!key || typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch (_error) {
    return fallback;
  }
}

function writeNumber(key, value) {
  if (!key || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch (_error) {
    // ignore
  }
}

function isMobile() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
}
