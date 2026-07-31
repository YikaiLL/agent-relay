// Viewport-aware placement for the sidebar context menus (session rows and
// project rows). Both used to be positioned by clamping the click point against
// a hardcoded height guess, which meant a right-click on a row near the bottom
// of a long list opened a menu that ran off the bottom edge. Placement here is
// flip-based: prefer opening down/right from the click, but anchor the menu's
// bottom/right edge at the click when that side has no room.

/** Gap kept between the menu and the viewport edges. */
export const CONTEXT_MENU_MARGIN_PX = 12;

// Only used when the menu can't be measured (never rendered / zero-size layout).
const FALLBACK_MENU_WIDTH_PX = 220;
const FALLBACK_MENU_HEIGHT_PX = 96;

function clamp(value, min, max) {
  // `min` wins when the menu is larger than the space it has to live in, so we
  // stay pinned to the top/left margin instead of drifting off screen.
  return Math.max(min, Math.min(value, max));
}

/**
 * Pure placement math. Returns viewport (`position: fixed`) coordinates plus the
 * side each axis ended up on, so callers/tests can assert the flip.
 *
 * @returns {{ left: number, top: number, placement: "above"|"below", alignment: "left"|"right" }}
 */
export function placeContextMenu({
  anchorX = 0,
  anchorY = 0,
  menuWidth = 0,
  menuHeight = 0,
  viewportWidth = 0,
  viewportHeight = 0,
  margin = CONTEXT_MENU_MARGIN_PX,
} = {}) {
  const spaceBelow = viewportHeight - margin - anchorY;
  const spaceAbove = anchorY - margin;
  // Prefer downward (the familiar direction); flip up only when the menu
  // genuinely doesn't fit below. If it fits neither way, take the roomier side
  // so the clamp below loses as little of the menu as possible.
  const openAbove =
    menuHeight > spaceBelow && (menuHeight <= spaceAbove || spaceAbove > spaceBelow);

  const spaceRight = viewportWidth - margin - anchorX;
  const spaceLeft = anchorX - margin;
  const alignRight =
    menuWidth > spaceRight && (menuWidth <= spaceLeft || spaceLeft > spaceRight);

  const rawTop = openAbove ? anchorY - menuHeight : anchorY;
  const rawLeft = alignRight ? anchorX - menuWidth : anchorX;

  return {
    left: clamp(rawLeft, margin, viewportWidth - margin - menuWidth),
    top: clamp(rawTop, margin, viewportHeight - margin - menuHeight),
    placement: openAbove ? "above" : "below",
    alignment: alignRight ? "right" : "left",
  };
}

/**
 * Measure an already-visible menu element and write its `position: fixed`
 * coordinates. Callers must unhide the menu (and finish populating it) first,
 * so the measured height reflects the real content — that measurement is the
 * whole point: a fixed guess is what let the menu overflow the bottom edge.
 */
/**
 * Rebuild a visible menu's dynamic content and re-place it from the SAME click
 * anchor. Placement depends on the menu's measured height, so any content swap
 * invalidates it: the session menu opens as a one-line "Loading projects…" note
 * and is repopulated into a tall project list once the payload settles, and a
 * `top` computed for the short version leaves the tall one hanging off the
 * bottom edge. Populate and place are one call so a caller can't do the first
 * without the second.
 *
 * Only for a menu that is (or is becoming) visible — it unhides to measure.
 * Returns null, without populating, when there's no usable anchor.
 */
export function updateContextMenuContent(menu, anchor, populate, view) {
  if (!menu || !menu.style || !anchor) {
    return null;
  }
  // A missing coordinate degrades to the top-left corner: the menu is still
  // reachable, where bailing out would leave it hidden with no way to open it.
  const clientX = Number.isFinite(anchor.clientX) ? anchor.clientX : 0;
  const clientY = Number.isFinite(anchor.clientY) ? anchor.clientY : 0;
  if (typeof populate === "function") {
    populate();
  }
  // Measuring a hidden element reports zero, which would fall back to the
  // placeholder size and mis-place the menu.
  menu.hidden = false;
  return positionContextMenuElement(menu, clientX, clientY, view);
}

export function positionContextMenuElement(menu, anchorX, anchorY, view) {
  if (!menu || !menu.style) {
    return null;
  }
  const viewport = view || (typeof window !== "undefined" ? window : null);
  const rect =
    typeof menu.getBoundingClientRect === "function" ? menu.getBoundingClientRect() : null;
  const menuWidth = rect?.width || menu.offsetWidth || FALLBACK_MENU_WIDTH_PX;
  const menuHeight = rect?.height || menu.offsetHeight || FALLBACK_MENU_HEIGHT_PX;

  const placement = placeContextMenu({
    anchorX,
    anchorY,
    menuWidth,
    menuHeight,
    viewportWidth: viewport?.innerWidth || 0,
    viewportHeight: viewport?.innerHeight || 0,
  });
  menu.style.left = `${Math.round(placement.left)}px`;
  menu.style.top = `${Math.round(placement.top)}px`;
  return placement;
}
