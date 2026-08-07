// Is the remote sidebar's gesture tracer armed?
//
// Its own module, and a pure function, because the thing it gates is a hazard rather than
// a feature: the tracer calls `renderLog()` — `patchRemoteState`, a re-render — on every
// pointerdown, touchstart, wheel and scroll over the sidebar. A re-render landing between
// mousedown and mouseup replaces the `dangerouslySetInnerHTML` glyph inside a button, and
// the browser then fires no click at all. `.inline-icon { pointer-events: none }` covers
// the buttons that carry that class; `.project-switcher-trigger`'s svg does not, and a
// real e2e run shows the tracer firing with that svg as the pointerdown target.
//
// So the default has to be OFF, and "off" has to mean no listeners rather than listeners
// that decline to log — an installed listener is still a listener.
//
// Kept as a tool rather than deleted because it only earns its keep on the device that
// needs it. You frequently cannot reach a console on a phone, which is why it renders into
// the client log panel in the first place; deleting it would take the instrument away at
// exactly the moment the next sidebar scroll report arrives.

const STORAGE_KEY = "sealwire:sidebar-debug";
const QUERY_KEY = "sidebarDebug";
const ON_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * @param {object}  [source]
 * @param {string}  [source.search]  `location.search` (a leading "?" is optional)
 * @param {object}  [source.storage] anything with `getItem` — normally `localStorage`
 */
export function sidebarGestureDebugEnabled({ search = "", storage = null } = {}) {
  const query = readQueryFlag(search);
  // An explicit value in the URL is the whole answer, in BOTH directions. Without the
  // negative case a flag set once during an investigation could only be cleared by hand,
  // which is how a debug switch becomes permanent.
  if (query !== null) {
    return query;
  }
  return readStoredFlag(storage);
}

function readQueryFlag(search) {
  if (typeof search !== "string" || !search) {
    return null;
  }
  let params;
  try {
    params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    return null;
  }
  if (!params.has(QUERY_KEY)) {
    return null;
  }
  return ON_VALUES.has(String(params.get(QUERY_KEY)).toLowerCase());
}

function readStoredFlag(storage) {
  // Reading `localStorage` THROWS in Safari private browsing and in some embedded
  // webviews — the phone-shaped environments this tracer exists for. This runs from
  // `bootRemoteRuntime`, so an uncaught throw here would stop the surface from starting
  // over a debug flag.
  try {
    const value = storage?.getItem?.(STORAGE_KEY);
    return value != null && ON_VALUES.has(String(value).toLowerCase());
  } catch {
    return false;
  }
}

export { STORAGE_KEY as SIDEBAR_DEBUG_STORAGE_KEY, QUERY_KEY as SIDEBAR_DEBUG_QUERY_KEY };
