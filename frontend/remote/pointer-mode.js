// Which input class is driving the remote surface, as a piece of remote state.
//
// Sibling of `navigation.js`, and deliberately NOT part of it: that module answers
// "how wide is the viewport" (drawer vs desktop layout), this one answers "is there a
// mouse". They disagree usefully — a narrow desktop window is drawer-shaped but still
// mouse-driven, and a big tablet is wide but still finger-driven — so folding them
// together would lose exactly the distinction this exists to draw.
//
// Held as state rather than read at each render so the value has one source, changes
// re-render through the store every other remote field already uses, and a flip
// (plugging in a mouse, detaching a tablet keyboard, toggling device emulation) is
// observed rather than sampled once at boot.

import { hasDesktopPointer, observeDesktopPointer } from "../shared/pointer-class.js";
import { patchRemoteState, state } from "./state.js";

let detachPointerListener = null;

export function initializeRemotePointerClass(win = window) {
  detachPointerListener?.();
  detachPointerListener = null;
  applyRemotePointerClass(hasDesktopPointer(win));
  detachPointerListener = observeDesktopPointer(win, applyRemotePointerClass);
}

export function stopRemotePointerClass() {
  detachPointerListener?.();
  detachPointerListener = null;
}

function applyRemotePointerClass(desktop) {
  const next = desktop ? "desktop" : "touch";
  if (state.remotePointerClass === next) {
    return;
  }
  patchRemoteState({ remotePointerClass: next });
}
