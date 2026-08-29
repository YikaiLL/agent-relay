// Escape needs BOTH: stopPropagation (the sidebar search reads a bare Escape as
// "close and clear") and preventDefault (a modal `<dialog>` would close too).
import { useCallback, useEffect } from "react";

/**
 * Closes a menu on Escape or on a pointer press outside it.
 *
 * `rootRef` is the trigger's wrapper. `menuRef` matters when the menu is
 * PORTALLED out of that wrapper (see `use-anchored-menu.js`): the menu is then no
 * longer a DOM descendant of the root, so a press on one of its own rows looks
 * like a press outside and would close the menu before the row's click could
 * land — the classic "the dropdown ignores my taps" bug. Both subtrees count as
 * inside.
 */
export function useDismissableMenu({ open, onClose, rootRef, menuRef = null }) {
  const close = useCallback(() => onClose?.(), [onClose]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onPointerDown = (event) => {
      const inRoot = rootRef.current?.contains(event.target);
      const inMenu = menuRef?.current?.contains(event.target);
      if (!inRoot && !inMenu) {
        close();
      }
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        close();
      }
    };

    // Capture phase: consumed before surface-level handlers act on it.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close, rootRef, menuRef]);
}
