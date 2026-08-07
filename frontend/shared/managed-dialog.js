// A `<dialog>` whose open state follows a prop instead of imperative calls.
//
// Extracted from remote/react-app.js so surfaces that live in their own module
// (the remote Settings modal) can use it without importing the whole remote app
// back — that import would be circular, since react-app.js mounts them.
//
// Three behaviours it exists to centralise, all easy to forget one of:
//   - `showModal()` is only called when the dialog is not already open. Calling
//     it twice throws in some engines, and re-entering it would reset focus.
//   - Esc fires `cancel`, which is preventDefault-ed and routed through
//     `onRequestClose`, so dismissal has ONE path and parent state cannot drift
//     out of sync with what is on screen.
//   - A click that lands on the dialog element itself — not on any child — is
//     the backdrop, so it dismisses too.
//
// The `setAttribute("open")` fallbacks are for environments with no dialog
// implementation (jsdom without the polyfill); they keep the component render-
// testable rather than adding real non-modal behaviour.

import React from "react";

const h = React.createElement;
const { useEffect, useRef } = React;

export function ManagedDialog({ children, className, id, onRequestClose, open }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (open) {
      if (!dialog.open) {
        if (typeof dialog.showModal === "function") {
          dialog.showModal();
        } else {
          dialog.setAttribute("open", "");
        }
      }
      return;
    }

    if (dialog.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return undefined;
    }

    const handleCancel = (event) => {
      event.preventDefault();
      onRequestClose?.();
    };

    dialog.addEventListener("cancel", handleCancel);
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
    };
  }, [onRequestClose]);

  return h(
    "dialog",
    {
      className,
      id,
      onClick: (event) => {
        if (event.target === event.currentTarget) {
          onRequestClose?.();
        }
      },
      ref: dialogRef,
    },
    children
  );
}
