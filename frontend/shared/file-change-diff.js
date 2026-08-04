function *iterateLines(value) {
  const text = String(value || "");
  let start = 0;
  while (start <= text.length) {
    const end = text.indexOf("\n", start);
    if (end < 0) {
      yield text.slice(start);
      return;
    }
    yield text.slice(start, end);
    start = end + 1;
  }
}

export function parseUnifiedDiffRows(value, { maxRows = Number.POSITIVE_INFINITY } = {}) {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of iterateLines(value)) {
    if (!line) {
      if (inHunk) {
        rows.push({ line, marker: " ", newLine, oldLine, type: "context" });
        oldLine += 1;
        newLine += 1;
        if (rows.length > maxRows) break;
      }
      continue;
    }

    if (line.startsWith("diff --git") || line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      inHunk = true;
      continue;
    }

    if (line === "\\ No newline at end of file") {
      rows.push({ line, marker: "", oldLine: null, newLine: null, type: "meta" });
      if (rows.length > maxRows) break;
      continue;
    }

    if (!inHunk && !line.startsWith("+") && !line.startsWith("-") && !line.startsWith(" ")) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      rows.push({ line, marker: "+", oldLine: null, newLine, type: "add" });
      newLine += 1;
      if (rows.length > maxRows) break;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      rows.push({ line, marker: "-", oldLine, newLine: null, type: "delete" });
      oldLine += 1;
      if (rows.length > maxRows) break;
      continue;
    }

    rows.push({
      line,
      marker: " ",
      oldLine: inHunk ? oldLine : null,
      newLine: inHunk ? newLine : null,
      type: "context",
    });
    if (inHunk) {
      oldLine += 1;
      newLine += 1;
    }
    if (rows.length > maxRows) break;
  }

  return rows;
}

export function sanitizeFileChange(change) {
  if (!change || typeof change !== "object") {
    return null;
  }

  const path = typeof change.path === "string" ? change.path.trim() : "";
  if (!path) {
    return null;
  }

  const changeType = typeof change.change_type === "string" && change.change_type.trim()
      ? change.change_type
      : typeof change.kind === "string" && change.kind.trim()
        ? change.kind
        : typeof change.type === "string" && change.type.trim() && change.type !== "fileChange"
          ? change.type
          : "update";
  const rawDiff = typeof change.diff === "string" ? change.diff : "";

  return {
    change_type: changeType,
    diff: normalizeFileChangeDiff(path, changeType, rawDiff),
    path,
  };
}

export function looksLikeUnifiedDiff(diff) {
  const text = String(diff || "");
  return (
    text.startsWith("diff --git ")
    || text.includes("\n@@ ")
    || text.startsWith("@@ ")
    || text.includes("\n--- ")
    || text.includes("\n+++ ")
    || text.startsWith("--- ")
    || text.startsWith("+++ ")
  );
}

export function synthesizeAddedFileDiff(path, content) {
  const normalizedLines = String(content || "").replaceAll("\r\n", "\n").split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${normalizedLines.length} @@`,
    ...normalizedLines.map((line) => `+${line}`),
  ].join("\n");
}

export function normalizeFileChangeDiff(path, changeType, diff) {
  if (!diff) {
    return "";
  }
  if ((changeType === "add" || changeType === "create") && !looksLikeUnifiedDiff(diff)) {
    return synthesizeAddedFileDiff(path, diff);
  }
  return diff;
}

export function mergeFileChangeDiff(existingDiff, incomingDiff) {
  const existing = String(existingDiff || "").trim();
  const incoming = String(incomingDiff || "").trim();
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }
  if (existing === incoming || existing.includes(incoming)) {
    return existing;
  }
  if (incoming.includes(existing)) {
    return incoming;
  }
  return `${existing}\n${incoming}`;
}

const WINDOWS_ROOT_PATTERN = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:$/;

// Split a path into resolved segments, the way `path.normalize` does: `.` dropped, `..`
// popped, duplicate separators collapsed. An absolute path cannot climb above its own
// root, so `..` there is discarded rather than kept.
function splitResolvedSegments(value) {
  const normalized = normalizePath(value);
  const absolute = isAbsolutePath(normalized);
  const windows = WINDOWS_ROOT_PATTERN.test(normalized);
  const segments = [];
  for (const raw of normalized.split("/")) {
    if (!raw || raw === ".") {
      continue;
    }
    if (raw === "..") {
      const last = segments[segments.length - 1];
      if (segments.length && last !== ".." && !WINDOWS_DRIVE_PATTERN.test(last)) {
        segments.pop();
      } else if (!absolute) {
        segments.push("..");
      }
      continue;
    }
    segments.push(raw);
  }
  return { absolute, segments, windows };
}

function joinResolvedSegments({ absolute, segments, windows }) {
  const joined = segments.join("/");
  if (!absolute || windows) {
    return joined;
  }
  return `/${joined}`;
}

// The tail of `target` below `base`, or null when `target` does not live under it. Windows
// compares case-insensitively because `path.win32.relative` does; POSIX does not, because
// `path.posix.relative` does not.
function segmentsBelow(base, target) {
  if (!base.absolute || !target.absolute || base.windows !== target.windows) {
    return null;
  }
  if (target.segments.length <= base.segments.length) {
    return null;
  }
  const fold = base.windows;
  for (let index = 0; index < base.segments.length; index += 1) {
    const from = base.segments[index];
    const to = target.segments[index];
    if (fold ? from.toLowerCase() !== to.toLowerCase() : from !== to) {
      return null;
    }
  }
  return target.segments.slice(base.segments.length).join("/");
}

// One file reaches the renderer spelled two ways: a change's `path` is ABSOLUTE (the
// worker reports it that way so the relay can tell which worktree a thread wrote in)
// while the patch header inside its diff is repo-RELATIVE (what `git apply` requires).
// Keying on the raw strings made those two spellings two files, so a single edit drew two
// stacked cards.
//
// The key must be EQUIVALENT to the producer, which is `path.relative` (see
// `patchHeaderPath` in claude-worker/file-diff.mjs) — not merely prefix-slicing the root
// off. Anywhere the arithmetic diverges the same file keys twice and the empty card comes
// back: a root of `/`, a `.`/`..` segment, a doubled separator, a Windows path whose drive
// or directory differs only in case. `frontend/shared/file-change-diff.test.mjs` pins the
// key against node's `path` for exactly those.
//
// What it deliberately will NOT do is guess: with no root, or for a path that does not
// live under it, the key stays the whole path and nothing merges. Matching on a path
// SUFFIX instead would fold a root-level `x.js` into `deep/x.js`, which are two files.
export function fileChangePathKey(path, root = "") {
  const target = splitResolvedSegments(path);
  if (!target.segments.length) {
    return normalizePath(path);
  }
  const base = root ? splitResolvedSegments(root) : null;
  const key = (base && segmentsBelow(base, target)) ?? joinResolvedSegments(target);
  // A Windows path names the same file whatever the case, so the two spellings have to
  // agree on it — including when one side arrives already relative.
  return target.windows || base?.windows ? key.toLowerCase() : key;
}

export function mergeFileChangeLists(existingChanges, incomingChanges, options = null) {
  const root = options?.currentCwd || "";
  const merged = [];
  const indexByKey = new Map();

  function mergeOne(change) {
    const normalized = sanitizeFileChange(change);
    if (!normalized) {
      return;
    }

    // The first spelling wins the display slot: explicit changes are merged before
    // diff-derived ones, so the card keeps the absolute path the entry actually carries
    // (which the display map then shortens against the same root).
    const key = fileChangePathKey(normalized.path, root);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, merged.length);
      merged.push({ ...normalized });
      return;
    }

    const existing = merged[existingIndex];
    existing.diff = mergeFileChangeDiff(existing.diff, normalized.diff);
    if (existing.change_type === "update" && normalized.change_type !== "update") {
      existing.change_type = normalized.change_type;
    }
  }

  for (const change of existingChanges || []) {
    mergeOne(change);
  }
  for (const change of incomingChanges || []) {
    mergeOne(change);
  }

  return merged;
}

export function parseFileChangesFromDiff(diff) {
  if (!diff) {
    return [];
  }

  const changes = [];
  let currentLines = [];
  let currentPath = "";

  function flushCurrentChange() {
    if (!currentPath || !currentLines.length) {
      currentLines = [];
      return;
    }
    changes.push({
      change_type: "update",
      diff: currentLines.join("\n"),
      path: currentPath,
    });
    currentLines = [];
  }

  for (const line of String(diff).split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushCurrentChange();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentPath = match?.[2] || match?.[1] || "";
    }
    currentLines.push(line);
  }

  flushCurrentChange();
  return changes;
}

export function collectFileChangesFromJsonValue(value, fileChanges, seenKeys) {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectFileChangesFromJsonValue(item, fileChanges, seenKeys);
    }
    return;
  }

  const normalized = sanitizeFileChange(value);
  if (normalized) {
    const key = `${normalized.path}\u0000${normalized.diff}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      fileChanges.push(normalized);
    }
  }

  for (const nestedValue of Object.values(value)) {
    if (nestedValue && typeof nestedValue === "object") {
      collectFileChangesFromJsonValue(nestedValue, fileChanges, seenKeys);
    }
  }
}

export function parseFileChangesFromInputPreview(inputPreview) {
  if (!inputPreview) {
    return [];
  }

  try {
    const parsed = JSON.parse(inputPreview);
    const fileChanges = [];
    collectFileChangesFromJsonValue(parsed, fileChanges, new Set());
    return fileChanges;
  } catch {
    return [];
  }
}

export function parseFilePathsFromDetail(detail) {
  const detailMatch = String(detail || "").match(/^Target files?:\s*(.+)$/i);
  if (!detailMatch) {
    return [];
  }

  return detailMatch[1].split(",").map((path) => path.trim()).filter(Boolean);
}

export function parseFilePathsFromInputPreview(inputPreview) {
  const inputMatch = String(inputPreview || "").match(/^Files:\n([\s\S]+)$/i);
  if (!inputMatch) {
    return [];
  }

  return inputMatch[1].split("\n").map((path) => path.trim()).filter(Boolean);
}

// `options.currentCwd` is the session root used to reconcile the two path spellings (see
// fileChangePathKey). Callers that render through the transcript already carry it on the
// tool as `display_options`; the explicit argument is for the ones that don't.
export function getFileChanges(tool, options = null) {
  const currentCwd = options?.currentCwd || tool?.display_options?.currentCwd || "";
  const explicitChanges = Array.isArray(tool?.file_changes)
    ? tool.file_changes.map(sanitizeFileChange).filter(Boolean)
    : [];
  const diffChanges = parseFileChangesFromDiff(tool?.diff);
  if (explicitChanges.length) {
    const mergedChanges = mergeFileChangeLists(explicitChanges, diffChanges, { currentCwd });
    if (!diffChanges.length && mergedChanges.length === 1 && !mergedChanges[0].diff && tool?.diff) {
      mergedChanges[0].diff = String(tool.diff);
    }
    return mergedChanges;
  }

  const structuredInputChanges = parseFileChangesFromInputPreview(tool?.input_preview);
  if (structuredInputChanges.length) {
    return structuredInputChanges;
  }

  if (diffChanges.length) {
    return diffChanges;
  }

  const fallbackPaths = [
    ...parseFilePathsFromDetail(tool?.detail),
    ...parseFilePathsFromInputPreview(tool?.input_preview),
    ...(tool?.path ? [tool.path] : []),
  ];
  const seenPaths = new Set();
  return fallbackPaths
    .filter((path) => {
      if (!path || seenPaths.has(path)) {
        return false;
      }
      seenPaths.add(path);
      return true;
    })
    .map((path) => ({
      change_type: "update",
      diff: "",
      path,
    }));
}

export function diffStats(diff) {
  if (!diff) return { added: 0, removed: 0 };
  let added = 0, removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

export function fileBasename(path) {
  return String(path || "unknown").split("/").pop() || "unknown";
}

export function splitPathSegments(path) {
  return String(path || "unknown")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean);
}

export function isAbsolutePath(path) {
  const normalized = String(path || "").replaceAll("\\", "/");
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
}

export function normalizePath(path) {
  return String(path || "").replaceAll("\\", "/");
}

export function relativeDisplayPath(path, currentCwd) {
  const normalizedPath = normalizePath(path);
  const normalizedCwd = normalizePath(currentCwd).replace(/\/+$/, "");
  if (!normalizedPath || !normalizedCwd) {
    return null;
  }
  if (normalizedPath === normalizedCwd) {
    return "";
  }
  if (!normalizedPath.startsWith(`${normalizedCwd}/`)) {
    return null;
  }
  return normalizedPath.slice(normalizedCwd.length + 1);
}

export function commonLeadingSegments(paths) {
  if (!paths.length) {
    return [];
  }

  const segmentLists = paths.map(splitPathSegments);
  const first = segmentLists[0] || [];
  let count = 0;
  while (
    count < first.length
    && segmentLists.every((segments) => segments[count] === first[count])
  ) {
    count += 1;
  }
  return first.slice(0, count);
}

export function buildFileDisplayPathMap(fileChanges, options = null) {
  const uniquePaths = [...new Set(fileChanges.map((change) => String(change?.path || "unknown")))];
  const absolutePaths = uniquePaths.filter(isAbsolutePath);
  const absolutePrefix = commonLeadingSegments(absolutePaths);
  const displayPathMap = new Map();
  const currentCwd = options?.currentCwd || "";

  for (const path of uniquePaths) {
    const normalized = normalizePath(path) || "unknown";
    const segments = splitPathSegments(path);
    if (!segments.length) {
      displayPathMap.set(path, "unknown");
      continue;
    }

    const cwdRelativePath = relativeDisplayPath(path, currentCwd);
    if (cwdRelativePath) {
      displayPathMap.set(path, cwdRelativePath);
      continue;
    }

    if (isAbsolutePath(path) && absolutePrefix.length > 0 && absolutePrefix.length < segments.length) {
      displayPathMap.set(path, segments.slice(absolutePrefix.length).join("/"));
      continue;
    }

    displayPathMap.set(path, normalized || fileBasename(path));
  }

  return displayPathMap;
}
