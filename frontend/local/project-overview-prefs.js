// Per-project pin + manual card order, persisted client-side (localStorage). Desktop
// only for now — the mobile/remote surface will get its own treatment later, and a
// server-persisted, cross-device version is a deliberate follow-up. Fails soft:
// storage being unavailable or corrupt degrades to "no prefs", never throws.

const KEY_PREFIX = "sealwire:project-overview:";
const EMPTY = { pinned: [], order: [] };

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null; // access itself can throw (privacy mode, disabled storage)
  }
}

function sanitizeIds(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === "string" && id) : [];
}

export function loadProjectPrefs(projectId) {
  if (!projectId) {
    return { ...EMPTY };
  }
  const store = storage();
  if (!store) {
    return { ...EMPTY };
  }
  try {
    const raw = store.getItem(KEY_PREFIX + projectId);
    if (!raw) {
      return { ...EMPTY };
    }
    const parsed = JSON.parse(raw);
    return { pinned: sanitizeIds(parsed?.pinned), order: sanitizeIds(parsed?.order) };
  } catch {
    return { ...EMPTY };
  }
}

function saveProjectPrefs(projectId, prefs) {
  const store = storage();
  if (!store || !projectId) {
    return;
  }
  try {
    store.setItem(
      KEY_PREFIX + projectId,
      JSON.stringify({ pinned: sanitizeIds(prefs.pinned), order: sanitizeIds(prefs.order) }),
    );
  } catch {
    // Quota / unavailable — the in-memory view already reflects the change this
    // session; losing persistence is acceptable, a thrown error is not.
  }
}

export function toggleProjectPin(projectId, threadId) {
  const prefs = loadProjectPrefs(projectId);
  const pinned = new Set(prefs.pinned);
  if (pinned.has(threadId)) {
    pinned.delete(threadId);
  } else {
    pinned.add(threadId);
  }
  const next = { pinned: [...pinned], order: prefs.order };
  saveProjectPrefs(projectId, next);
  return next;
}

export function setProjectOrder(projectId, orderedIds) {
  const prefs = loadProjectPrefs(projectId);
  const next = { pinned: prefs.pinned, order: sanitizeIds(orderedIds) };
  saveProjectPrefs(projectId, next);
  return next;
}
