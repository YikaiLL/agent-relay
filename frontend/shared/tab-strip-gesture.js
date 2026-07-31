// Pointer gesture rules for the session tab strip.
//
// The strip has to serve two horizontal drags on the same pixels: panning the
// strip (there are more tabs than fit) and reordering a tab. Native HTML5
// drag-and-drop can't share that space — the browser claims the gesture the
// moment the pointer moves — so the strip drives both from pointer events and
// this module owns the arbitration:
//
//   press + move            → pan (the common case: reach a tab that's off-screen)
//   press + hold, then move → reorder (the tab "lifts" first, like a phone home screen)
//
// Everything here is pure: the component feeds coordinates in and applies the
// scrollLeft / drop-target the machine reports back. That keeps the interesting
// decisions testable without a browser.

export const REORDER_HOLD_MS = 260;
// Below this the press is still a click-in-waiting, so a shaky hand doesn't pan.
export const PAN_SLOP_PX = 6;
// While reordering, a pointer this close to an edge drags the strip along with
// it — otherwise a tab could never be moved past the visible window.
export const EDGE_ZONE_PX = 44;
export const EDGE_STEP_PX = 18;

/**
 * @returns {{
 *   mode: "idle"|"pending"|"panning"|"reorder",
 *   tabId: string|null,
 *   down: (input: object) => boolean,
 *   hold: () => boolean,
 *   move: (input: {x: number}) => object|null,
 *   up: () => {mode: string, tabId: string|null, moved: boolean},
 *   reset: () => void,
 * }}
 */
export function createStripGesture({ slop = PAN_SLOP_PX } = {}) {
  let mode = "idle";
  let origin = null;
  let moved = false;

  const reset = () => {
    mode = "idle";
    origin = null;
    moved = false;
  };

  return {
    get mode() {
      return mode;
    },
    get tabId() {
      return origin?.tabId ?? null;
    },

    // Returns false when the press isn't ours to take: a secondary button, or a
    // touch (the browser's own momentum scrolling is better than anything we'd
    // hand-roll, and touch never had reordering to begin with).
    down({ tabId = null, x = 0, scrollLeft = 0, button = 0, pointerType = "mouse" } = {}) {
      if (button !== 0 || pointerType === "touch") {
        reset();
        return false;
      }
      mode = "pending";
      origin = { tabId: tabId || null, x, scrollLeft };
      moved = false;
      return true;
    },

    // The hold timer fired. Only a press that hasn't turned into a pan yet can
    // still become a reorder — once panning, the gesture is committed.
    hold() {
      if (mode !== "pending" || !origin?.tabId) {
        return false;
      }
      mode = "reorder";
      return true;
    },

    move({ x = 0 } = {}) {
      if (mode === "idle" || !origin) {
        return null;
      }
      const dx = x - origin.x;
      if (mode === "pending") {
        if (Math.abs(dx) < slop) {
          return null;
        }
        mode = "panning";
      }
      moved = true;
      if (mode === "panning") {
        // Content follows the pointer: dragging left reveals tabs to the right.
        return { mode, scrollLeft: origin.scrollLeft - dx };
      }
      return { mode, x, tabId: origin.tabId };
    },

    up() {
      const result = { mode, tabId: origin?.tabId ?? null, moved };
      reset();
      return result;
    },

    reset,
  };
}

/**
 * Which tab the pointer is over while reordering. Nearest wins, so the 2px gaps
 * between tabs and the padding past either end never read as "no target" —
 * a reorder drag that flickered its target would be unusable.
 *
 * @param {number} pointerX viewport x
 * @param {Array<{tabId: string, left: number, right: number}>} rects strip order
 */
export function resolveDropTabId(pointerX, rects = []) {
  let bestId = null;
  let bestDistance = Infinity;
  for (const rect of rects) {
    if (!rect || typeof rect.tabId !== "string") {
      continue;
    }
    const distance =
      pointerX < rect.left ? rect.left - pointerX : pointerX > rect.right ? pointerX - rect.right : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = rect.tabId;
    }
  }
  return bestId;
}

/**
 * How far to nudge the strip when a reorder drag reaches its edge. Movement
 * driven rather than timer driven: no runaway scroll if a drag is abandoned
 * with the pointer parked over the edge.
 */
export function edgeScrollStep(pointerX, { left = 0, right = 0, zone = EDGE_ZONE_PX, step = EDGE_STEP_PX } = {}) {
  if (right <= left) {
    return 0;
  }
  if (pointerX <= left + zone) {
    return -step;
  }
  if (pointerX >= right - zone) {
    return step;
  }
  return 0;
}

/**
 * The scrollLeft that brings [start, end) into view, moving the least distance.
 * Used to keep the focused tab reachable after a focus change — with a fixed
 * tab width the focused session is otherwise free to sit off-screen.
 */
export function scrollLeftToReveal({
  scrollLeft = 0,
  viewport = 0,
  start = 0,
  end = 0,
  margin = 0,
  max = Infinity,
} = {}) {
  if (viewport <= 0) {
    return scrollLeft;
  }
  let next = scrollLeft;
  if (start - margin < scrollLeft) {
    next = start - margin;
  } else if (end + margin > scrollLeft + viewport) {
    next = end + margin - viewport;
  }
  const ceiling = Number.isFinite(max) ? Math.max(0, max) : Infinity;
  return Math.max(0, Math.min(next, ceiling));
}

/**
 * A wheel notch, in horizontal pixels. A vertical wheel scrolls the strip
 * sideways — the strip is one line tall, so a mouse with no horizontal axis
 * would otherwise have no way to reach a tab.
 */
export function wheelScrollDelta({ deltaX = 0, deltaY = 0, deltaMode = 0 } = {}, viewport = 0) {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? viewport || 0 : 1;
  const raw = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
  return raw * unit;
}
