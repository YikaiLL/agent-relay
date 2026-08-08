// What KIND of pointer is driving this surface — the one place the repo reasons about
// it, so the `(pointer: fine)` vs `(any-pointer: fine)` decision is made once.
//
// The distinction that matters is the PRIMARY pointer. `(any-pointer: fine)` is true on
// a touch-first device with an accessory mouse or trackpad attached — an iPad with a
// Magic Keyboard reports it — while `(pointer: fine)` stays false there, because the
// pointer the user actually reaches for is still a finger. Every question this module
// answers is really "is this a mouse-driven machine", so primary is always the right
// axis.
//
// `win` is injectable throughout: these are pure functions of a window-shaped object,
// testable under plain Node.

function matchesQuery(win, query, fallback) {
  if (!win || typeof win.matchMedia !== "function") {
    return fallback;
  }
  try {
    return Boolean(win.matchMedia(query).matches);
  } catch {
    // Some embedded webviews throw on an unsupported feature query rather than
    // returning a non-matching MediaQueryList.
    return fallback;
  }
}

const FINE_POINTER = "(pointer: fine)";
const DESKTOP_POINTER = "(hover: hover) and (pointer: fine)";

/**
 * A fine primary pointer: a mouse or trackpad is the main input.
 *
 * Fails OPEN. Callers using this are choosing a keyboard-first default that a touch
 * device merely opts out of, so an environment that cannot answer should get the
 * desktop behaviour rather than be treated as a phone.
 */
export function hasFinePrimaryPointer(win = typeof window !== "undefined" ? window : undefined) {
  return matchesQuery(win, FINE_POINTER, true);
}

/**
 * A desktop-class pointer: a fine primary pointer AND real hover.
 *
 * Stricter than `hasFinePrimaryPointer` because it gates UI whose controls are
 * hover-revealed — a surface that can point but cannot hover would render affordances
 * the user can never see.
 *
 * Fails CLOSED, the opposite of `hasFinePrimaryPointer`: this gates ADDITIVE desktop
 * UI, so an environment that cannot answer must keep the plainer layout rather than be
 * handed controls it may not be able to operate.
 */
export function hasDesktopPointer(win = typeof window !== "undefined" ? window : undefined) {
  return matchesQuery(win, DESKTOP_POINTER, false);
}

/**
 * Watch `hasDesktopPointer` and call `onChange(next)` when it flips — plugging in a
 * mouse, detaching a tablet keyboard, or toggling device emulation in devtools.
 *
 * Returns a detach function; returns a no-op when the environment cannot observe, so
 * callers never have to branch on support.
 */
export function observeDesktopPointer(win, onChange) {
  if (!win || typeof win.matchMedia !== "function" || typeof onChange !== "function") {
    return () => {};
  }

  let query;
  try {
    query = win.matchMedia(DESKTOP_POINTER);
  } catch {
    return () => {};
  }

  const handle = () => onChange(Boolean(query.matches));

  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", handle);
    return () => query.removeEventListener("change", handle);
  }
  // Safari < 14 and some webviews only have the deprecated form.
  if (typeof query.addListener === "function") {
    query.addListener(handle);
    return () => query.removeListener?.(handle);
  }
  return () => {};
}
