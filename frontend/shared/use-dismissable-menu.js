// Escape needs BOTH: stopPropagation (the sidebar search reads a bare Escape as
// "close and clear") and preventDefault (a modal `<dialog>` would close too).
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

    // Capture phase: consumed before surface-level handlers act on it.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close, rootRef]);
}
