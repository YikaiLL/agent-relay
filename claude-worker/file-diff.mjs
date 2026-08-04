import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const requireFromHere = createRequire(import.meta.url);
let diffLib = null;

// jsdiff is loaded on first use, not at import time, mirroring how the worker defers the
// Anthropic SDK: the process must boot — and answer `shutdown` — without resolving any
// third-party module. `scripts/sealwire-package.test.mjs` proves that by running the
// packed worker with no node_modules at all, so a static import here would break startup
// in the tarball layout rather than at the first file edit.
function diffModule() {
  if (!diffLib) diffLib = requireFromHere("diff");
  return diffLib;
}

const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_DIFF_LINES = 1400;
// Lines of unchanged context emitted around each change in a unified hunk.
const DIFF_CONTEXT_LINES = 3;
// Cap on the edit distance the diff will explore. Myers is O(N*D), so two large files
// that differ almost everywhere degrade to O(N^2): unbounded, 20k lines of pure churn
// took ~58 SECONDS, and the worker runs one NDJSON loop — that is a minute-long freeze
// of the session, not a slow render. Bounding D to the number of lines the patch could
// ever DISPLAY means we never compute detail the truncation would throw away anyway.
const MAX_EDIT_DISTANCE = MAX_DIFF_LINES;
const FILE_EDIT_TOOLS = new Set(["edit", "multiedit", "write", "notebookedit"]);

// `root` (the session cwd) is what lets the patch header be repo-relative, which is
// what `git apply` requires. Optional because some callers genuinely have no root; the
// header then stays absolute and the patch is honestly unappliable.
export function fileChangeFromToolInput(toolName, input, root = null) {
  if (!isFileEditTool(toolName)) return null;
  const filePath = filePathFromInput(input);
  if (!filePath) return null;
  const header = patchHeaderPath(root, filePath);

  const normalizedName = normalizeToolName(toolName);
  if (normalizedName === "write") {
    const content = typeof input?.content === "string" ? input.content : "";
    return buildFileChange(filePath, null, content, header);
  }

  if (normalizedName === "multiedit" && Array.isArray(input?.edits)) {
    const oldContent = input.edits
      .map((edit) => (typeof edit?.old_string === "string" ? edit.old_string : ""))
      .join("\n");
    const newContent = input.edits
      .map((edit) => (typeof edit?.new_string === "string" ? edit.new_string : ""))
      .join("\n");
    return buildFileChange(filePath, oldContent, newContent, header);
  }

  if (typeof input?.old_string === "string" || typeof input?.new_string === "string") {
    return buildFileChange(
      filePath,
      typeof input.old_string === "string" ? input.old_string : "",
      typeof input.new_string === "string" ? input.new_string : "",
      header
    );
  }

  return {
    path: filePath,
    change_type: "modify",
    diff: "",
  };
}

export function fileChangeTool({
  toolName,
  input,
  resultPreview = null,
  fileChange = null,
  root = null,
}) {
  const change = fileChange ?? fileChangeFromToolInput(toolName, input, root);
  if (!change) return null;
  const title = summarizeFileChange(toolName, change.path);
  return {
    item_type: "fileChange",
    name: toolName || "Edit",
    title,
    detail: title,
    query: null,
    path: change.path,
    url: null,
    command: null,
    input_preview: null,
    result_preview: resultPreview,
    diff: change.diff || null,
    file_changes: [change],
  };
}

export function createFileDiffTracker(cwd) {
  const calls = new Map();
  const root = cwd || process.cwd();

  return {
    async capture(event) {
      if (event?.type !== "tool_call_requested" || !isFileEditTool(event.name)) {
        return event;
      }
      const filePath = filePathFromInput(event.args);
      if (!filePath || !event.id) return event;
      const absolutePath = path.resolve(root, filePath);
      calls.set(event.id, {
        filePath,
        absolutePath,
        input: event.args ?? {},
        toolName: event.name,
        before: await readTextSnapshot(absolutePath),
      });
      return event;
    },

    async enrichResult(event) {
      if (event?.type !== "tool_call_result" || !event.id) return event;
      const call = calls.get(event.id);
      if (!call) return event;
      calls.delete(event.id);

      const after = await readTextSnapshot(call.absolutePath);
      // Must carry the root too: this fallback is what ships whenever the on-disk read
      // is unusable (file over the snapshot cap, or a success with no visible diff), and
      // without it those edits keep the absolute header the rest of this fix removes.
      const fallbackChange = fileChangeFromToolInput(call.toolName, call.input, root);
      // A failed tool result never landed on disk, so the input-derived
      // reconstruction must never stand in for it — otherwise a failed Edit (the
      // common no/non-unique-match case that leaves the file untouched) would be
      // shown as a completed change. Only the authoritative on-disk diff is
      // trustworthy on failure; when nothing changed that is an empty diff.
      const failed = event.is_error === true;

      // edit/multiedit/write/notebookedit never DELETE a file. If the re-read
      // finds the file gone or empty even though it held content before, it did
      // not observe the tool's write — a truncate-then-write window, a path that
      // moved or was removed after the turn, or a filesystem race — so an
      // on-disk diff would be a bogus whole-file deletion (-N/+0) that renders a
      // one-line edit as the entire file being removed. Rebuild the diff from the
      // tool input applied to the captured preimage so it stays a correct,
      // appliable `modify`. On a failed result, or when the input cannot be
      // reconstructed (NotebookEdit, an old_string that never matched), emit no
      // diff rather than fabricate one.
      const beforeHadContent = call.before.exists && call.before.content !== "";
      const afterVanished = !after.skipped && (!after.exists || after.content === "");
      if (beforeHadContent && afterVanished) {
        const postimage = failed
          ? null
          : intendedPostimage(call.toolName, call.input, call.before.content);
        const reconstructed = postimage != null
          ? buildFileChange(
              call.filePath,
              call.before.content,
              postimage,
              patchHeaderPath(root, call.filePath)
            )
          : { path: call.filePath, change_type: "modify", diff: "" };
        const tool = fileChangeTool({
          toolName: call.toolName,
          input: call.input,
          resultPreview: event.content ?? null,
          fileChange: reconstructed,
        });
        return tool ? { ...event, tool } : event;
      }

      const fileChange =
        call.before.skipped || after.skipped
          ? {
              path: call.filePath,
              change_type: changeType(call.before.exists, after.exists),
              diff: "",
            }
          : buildFileChange(
              call.filePath,
              call.before.exists ? call.before.content : null,
              after.exists ? after.content : null,
              patchHeaderPath(root, call.filePath)
            );

      // Fill in from the input-reconstructed fallback only when the on-disk diff
      // is empty AND the result succeeded — never for a failed edit.
      const useFallback = !failed && Boolean(fallbackChange) && !fileChange?.diff;
      const tool = fileChangeTool({
        toolName: call.toolName,
        input: call.input,
        resultPreview: event.content ?? null,
        fileChange: useFallback ? fallbackChange : fileChange,
      });
      return tool ? { ...event, tool } : event;
    },
  };
}

function isFileEditTool(toolName) {
  return FILE_EDIT_TOOLS.has(normalizeToolName(toolName));
}

function normalizeToolName(toolName) {
  return String(toolName || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function filePathFromInput(input) {
  for (const key of ["file_path", "path", "notebook_path"]) {
    if (typeof input?.[key] === "string" && input[key].trim()) {
      return input[key];
    }
  }
  return "";
}

async function readTextSnapshot(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return { exists: false, content: "", skipped: true };
    if (stat.size > MAX_SNAPSHOT_BYTES) return { exists: true, content: "", skipped: true };
    return { exists: true, content: await fs.readFile(filePath, "utf8"), skipped: false };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, content: "", skipped: false };
    return { exists: false, content: "", skipped: true };
  }
}

// `headerPath` is what goes INSIDE the patch (`diff --git a/<headerPath> ...`), which
// git requires to be repo-relative. It is deliberately separate from `path`, the field
// consumers read to know WHICH file changed — that one stays absolute so the relay can
// tell which worktree a thread has been writing in. Defaults to filePath for callers
// with no repo root to relativize against.
function buildFileChange(filePath, oldContent, newContent, headerPath = filePath) {
  const oldExists = oldContent !== null && oldContent !== undefined;
  const newExists = newContent !== null && newContent !== undefined;
  return {
    path: filePath,
    change_type: changeType(oldExists, newExists),
    diff: renderFileDiff(headerPath, oldExists ? oldContent : "", newExists ? newContent : "", {
      oldExists,
      newExists,
    }),
  };
}

// The path to write into the patch header. Relative to the repo root when the file is
// inside it — the case `git apply` can actually handle. A file OUTSIDE the root (an
// agent working in a linked worktree) has no valid relative form: `../other/x.js`
// escapes the repo and git refuses it just as it refuses an absolute path. Keep it
// absolute there so the patch is honestly unappliable rather than looking valid and
// being applied against the wrong tree. Undoing those needs to run git in the worktree
// that owns the file, which is separate work.
export function patchHeaderPath(root, filePath) {
  if (!root || !path.isAbsolute(filePath)) return filePath;
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative;
}

function changeType(oldExists, newExists) {
  if (!oldExists && newExists) return "add";
  if (oldExists && !newExists) return "delete";
  return "modify";
}

// Reconstruct the intended post-edit content by applying the tool input to the
// captured pre-edit content. Used only when the on-disk re-read is unusable, so
// the diff is computed against the real preimage (a correct, appliable modify).
// Returns null when the input cannot be applied — an unknown/notebook tool,
// missing fields, or an old_string that isn't present in the preimage (i.e. the
// edit would not have matched) — so the caller can degrade to an empty diff
// instead of fabricating one.
function intendedPostimage(toolName, input, beforeContent) {
  const name = normalizeToolName(toolName);
  if (name === "write") {
    return typeof input?.content === "string" ? input.content : null;
  }
  if (typeof beforeContent !== "string") return null;
  if (name === "edit") {
    return applyStringEdit(beforeContent, input?.old_string, input?.new_string, input?.replace_all);
  }
  if (name === "multiedit" && Array.isArray(input?.edits)) {
    let content = beforeContent;
    for (const edit of input.edits) {
      content = applyStringEdit(content, edit?.old_string, edit?.new_string, edit?.replace_all);
      if (content == null) return null;
    }
    return content;
  }
  return null;
}

// Literal (non-regex) string replacement mirroring the Claude Edit tool. Uses
// index/slice so `$`-sequences in new_string are inserted verbatim. Returns null
// when old_string is absent, so an edit that never matched can't be reconstructed.
function applyStringEdit(content, oldString, newString, replaceAll) {
  if (typeof oldString !== "string" || typeof newString !== "string" || oldString === "") {
    return null;
  }
  if (!content.includes(oldString)) return null;
  if (replaceAll) return content.split(oldString).join(newString);
  const at = content.indexOf(oldString);
  return content.slice(0, at) + newString + content.slice(at + oldString.length);
}

// Renders a git-style unified diff. The hunk bodies come from jsdiff (Myers), which owns
// every detail of the unified format we used to hand-roll and get subtly wrong: minimal
// hunks, context coalescing, the `@@ -0,0` convention for a created file, and the
// `\ No newline at end of file` marker. The file header stays ours because it is
// git-specific (`diff --git a/x b/x`, mode lines) and because the relay's appliability
// check and the repo-relative header rule are pinned to this exact shape.
function renderFileDiff(filePath, oldContent, newContent, { oldExists = true, newExists = true } = {}) {
  if (oldExists && newExists && oldContent === newContent) return "";

  const { structuredPatch } = diffModule();
  const patch = structuredPatch(filePath, filePath, oldContent, newContent, undefined, undefined, {
    context: DIFF_CONTEXT_LINES,
    maxEditLength: MAX_EDIT_DISTANCE,
  });
  // A patch with no hunks means no line-level change at all. `undefined` is different:
  // jsdiff hit the edit-distance cap and gave up, so we degrade rather than render
  // nothing.
  if (patch && !patch.hunks.length) return "";

  const header = [`diff --git a/${filePath} b/${filePath}`];
  if (!oldExists) header.push("new file mode 100644");
  if (!newExists) header.push("deleted file mode 100644");
  header.push(oldExists ? `--- a/${filePath}` : "--- /dev/null");
  header.push(newExists ? `+++ b/${filePath}` : "+++ /dev/null");

  const body = patch
    ? hunkLines(patch)
    : replacementBody(oldContent, newContent, oldExists, newExists);
  if (!body.length) return "";

  return `${truncateDiff([...header, ...body]).join("\n")}\n`;
}

// formatPatch emits its own `Index:`/`---`/`+++` preamble; keep only the hunks so the
// git header built above is the one that ships. Slicing to the first `@@` leaves every
// detail of hunk rendering to jsdiff.
function hunkLines(patch) {
  const { formatPatch } = diffModule();
  const formatted = formatPatch(patch).split("\n");
  const firstHunk = formatted.findIndex((line) => line.startsWith("@@"));
  return firstHunk < 0 ? [] : formatted.slice(firstHunk).filter((line) => line !== "");
}

// Used only when jsdiff bails at MAX_EDIT_DISTANCE: every old line removed, every new
// line added. Reaching here means the edit distance already exceeds the number of lines
// the patch can display, so this body is always truncated and never appliable — it exists
// to show the shape of the change, not to be applied.
function replacementBody(oldContent, newContent, oldExists, newExists) {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  return [
    `@@ -${rangeHeader(oldLines.length, oldExists)} +${rangeHeader(newLines.length, newExists)} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];
}

function splitLines(content) {
  if (!content) return [];
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  return normalized ? normalized.split("\n") : [];
}

function rangeHeader(lineCount, exists) {
  if (!exists || lineCount === 0) return "0,0";
  return lineCount === 1 ? "1" : `1,${lineCount}`;
}

// Bounds a patch to MAX_DIFF_LINES by keeping its head AND its tail, not just its head.
// A whole-file rewrite is a single hunk of every removal followed by every addition, so
// head-only truncation drops all the `+` lines and the change renders as -N/+0 — which
// the UI cannot tell apart from the file having been deleted. Keeping both ends means
// both signs survive whatever shape the patch has.
function truncateDiff(lines) {
  if (lines.length <= MAX_DIFF_LINES) return lines;
  const kept = MAX_DIFF_LINES - 1;
  const head = Math.ceil(kept / 2);
  const tail = kept - head;
  return [
    ...lines.slice(0, head),
    `# Diff truncated by agent-relay: ${lines.length - kept} lines omitted`,
    ...lines.slice(lines.length - tail),
  ];
}

function summarizeFileChange(toolName, filePath) {
  const basename = path.basename(filePath || "file");
  const normalizedName = normalizeToolName(toolName);
  if (normalizedName === "write") return `Wrote ${basename}`;
  return `Edited ${basename}`;
}
