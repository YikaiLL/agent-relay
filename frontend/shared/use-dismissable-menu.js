// Outside-pointer and Escape dismissal for a popup anchored to a trigger.
//
// Written once because there are now three of these — the project switcher, the
// project picker, and every settings pill in the launch dialogs — and the two
// rules they share are both easy to get subtly wrong in ways that only show up
// on one surface:
//
//   stopPropagation: the sidebar search reads a bare Escape as "close AND clear
//   the query". A menu that lets Escape bubble silently wipes a search the user
//   never touched.
//
//   preventDefault: a modal `<dialog>` closes on Escape through the browser's
//   close-request handling. Inside the launch dialogs, an uncancelled Escape
//   dismisses the whole dialog along with the menu, discarding a typed prompt.
//
// Both are bound ONLY while the menu is open, which is what keeps the dialog
// dismissable from the keyboard when no menu is showing.

import { useCallback, useEffect } from "react";

export function useDismissableMenu({ open, onClose, rootRef }) {
  const close = useCallback(() => onClose?.(), [onClose]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) {
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

    // Capture phase: the key must be consumed before it reaches surface-level
    // handlers, not after they have already acted on it.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close, rootRef]);
}
