import fs from "node:fs/promises";
import path from "node:path";

const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_DIFF_LINES = 1400;
// Lines of unchanged context emitted around each change in a unified hunk.
const DIFF_CONTEXT_LINES = 3;
// Upper bound on the LCS DP table (rows * cols). Above this we fall back to a
// whole-file replacement diff to avoid pathological O(n*m) cost/memory on huge
// files (still bounded downstream by MAX_DIFF_LINES).
const MAX_LCS_CELLS = 4_000_000;
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

function renderFileDiff(filePath, oldContent, newContent, { oldExists = true, newExists = true } = {}) {
  if (oldExists && newExists && oldContent === newContent) return "";
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);

  const header = [`diff --git a/${filePath} b/${filePath}`];
  if (!oldExists) header.push("new file mode 100644");
  if (!newExists) header.push("deleted file mode 100644");
  header.push(oldExists ? `--- a/${filePath}` : "--- /dev/null");
  header.push(newExists ? `+++ b/${filePath}` : "+++ /dev/null");

  // `null` ops means even the differing middle is too large to diff minimally, so the
  // patch degrades to a whole-file replacement.
  const ops = computeLineOps(oldLines, newLines);
  const body = ops
    ? buildUnifiedHunks(ops)
    : replacementBody(oldLines, newLines, oldExists, newExists);

  // No line-level changes (e.g. only a trailing-newline difference) → no diff.
  if (!body.length) return "";

  const lines = [...header, ...body];
  if (lines.length > MAX_DIFF_LINES) {
    return [
      ...lines.slice(0, MAX_DIFF_LINES - 1),
      `# Diff truncated by agent-relay: ${lines.length - MAX_DIFF_LINES + 1} lines omitted`,
    ].join("\n") + "\n";
  }
  return lines.join("\n") + "\n";
}

// Classic LCS line diff: returns an ordered list of {type, line} ops where type
// is "equal" | "del" | "add". Compares lines with strict equality.
//
// The O(n*m) DP runs only over the lines that actually differ — a shared prefix and
// suffix are peeled off first and re-emitted as `equal` ops. Skipping that peel is what
// made a one-character edit to package-lock.json (5993 lines) price itself out of the
// cost cap at 5993^2 ≈ 36M cells and degrade to a whole-file replacement, which the
// line-budget truncation then cut off before the first `+`, rendering the edit as the
// whole file being deleted.
//
// Returns null when even the differing middle is over MAX_LCS_CELLS, so the caller can
// fall back instead of paying pathological time and memory (the DP allocates n*m
// Int32s).
function computeLineOps(oldLines, newLines) {
  const shortest = Math.min(oldLines.length, newLines.length);
  let head = 0;
  while (head < shortest && oldLines[head] === newLines[head]) head += 1;
  let tail = 0;
  while (
    tail < shortest - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const oldMid = oldLines.slice(head, oldLines.length - tail);
  const newMid = newLines.slice(head, newLines.length - tail);
  if (oldMid.length * newMid.length > MAX_LCS_CELLS) return null;

  const ops = [];
  for (let k = 0; k < head; k += 1) ops.push({ type: "equal", line: oldLines[k] });
  for (const op of diffMiddle(oldMid, newMid)) ops.push(op);
  for (let k = oldLines.length - tail; k < oldLines.length; k += 1) {
    ops.push({ type: "equal", line: oldLines[k] });
  }
  return ops;
}

// Whole-file replacement, used only when the differing middle is still too large to diff
// minimally. Removals and additions each get their own half of the line budget: emitting
// every removal first lets the MAX_DIFF_LINES truncation cut the patch off before the
// first `+`, which renders a rewrite as a whole-file deletion (-N/+0) — visually
// identical to the file having been erased.
function replacementBody(oldLines, newLines, oldExists, newExists) {
  // Leaves room for the file header (up to 4 lines), the hunk header and both omission
  // notes, so the outer truncation never has to cut this body.
  const perSide = Math.floor((MAX_DIFF_LINES - 8) / 2);
  return [
    `@@ -${rangeHeader(oldLines.length, oldExists)} +${rangeHeader(newLines.length, newExists)} @@`,
    ...budgetedSide(oldLines, "-", perSide),
    ...budgetedSide(newLines, "+", perSide),
  ];
}

function budgetedSide(lines, sign, limit) {
  const shown = lines.slice(0, limit).map((line) => `${sign}${line}`);
  if (lines.length > shown.length) {
    const kind = sign === "-" ? "removed" : "added";
    shown.push(`# ${lines.length - shown.length} ${kind} lines omitted by agent-relay`);
  }
  return shown;
}

function diffMiddle(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  // dp[i][j] = length of the LCS of oldLines[i..] and newLines[j..].
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "equal", line: oldLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", line: oldLines[i] });
      i += 1;
    } else {
      ops.push({ type: "add", line: newLines[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: "del", line: oldLines[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: "add", line: newLines[j] });
    j += 1;
  }
  return ops;
}

// Turn an ordered op list into unified-diff hunk lines with DIFF_CONTEXT_LINES
// of context around each change region. Adjacent change regions whose context
// windows touch are coalesced into a single hunk.
function buildUnifiedHunks(ops) {
  const changeIndexes = [];
  for (let k = 0; k < ops.length; k += 1) {
    if (ops[k].type !== "equal") changeIndexes.push(k);
  }
  if (!changeIndexes.length) return [];

  const context = DIFF_CONTEXT_LINES;
  const lastIndex = ops.length - 1;
  const hunks = [];
  let start = Math.max(0, changeIndexes[0] - context);
  let end = Math.min(lastIndex, changeIndexes[0] + context);
  for (let x = 1; x < changeIndexes.length; x += 1) {
    const idx = changeIndexes[x];
    if (idx - context <= end + 1) {
      end = Math.min(lastIndex, idx + context);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, idx - context);
      end = Math.min(lastIndex, idx + context);
    }
  }
  hunks.push([start, end]);

  // Prefix sums of consumed old/new lines so hunk headers get 1-based starts.
  const oldPrefix = new Array(ops.length + 1).fill(0);
  const newPrefix = new Array(ops.length + 1).fill(0);
  for (let k = 0; k < ops.length; k += 1) {
    const { type } = ops[k];
    oldPrefix[k + 1] = oldPrefix[k] + (type === "equal" || type === "del" ? 1 : 0);
    newPrefix[k + 1] = newPrefix[k] + (type === "equal" || type === "add" ? 1 : 0);
  }

  const lines = [];
  for (const [s, e] of hunks) {
    const oldCount = oldPrefix[e + 1] - oldPrefix[s];
    const newCount = newPrefix[e + 1] - newPrefix[s];
    const oldStart = oldCount > 0 ? oldPrefix[s] + 1 : oldPrefix[s];
    const newStart = newCount > 0 ? newPrefix[s] + 1 : newPrefix[s];
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let k = s; k <= e; k += 1) {
      const op = ops[k];
      if (op.type === "equal") lines.push(` ${op.line}`);
      else if (op.type === "del") lines.push(`-${op.line}`);
      else lines.push(`+${op.line}`);
    }
  }
  return lines;
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

function summarizeFileChange(toolName, filePath) {
  const basename = path.basename(filePath || "file");
  const normalizedName = normalizeToolName(toolName);
  if (normalizedName === "write") return `Wrote ${basename}`;
  return `Edited ${basename}`;
}
