// A denylist rather than an "every id exists" scan, because control ids are derived
// from the dialog id (`${dialogId}-cwd`) and no syntactic scan can resolve them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.dirname(path.dirname(HARNESS));
const REPO = path.dirname(SCRIPTS);

// Each entry: the dead selector, and what replaced it.
const REMOVED = [
  ["#cwd-input", "the workspace picker — startLocalSession({ cwd }) drives it"],
  ["#provider-input", "the model pill menu — startLocalSession({ provider })"],
  ["#approval-policy-input", "the approval pill — startLocalSession({ approvalPolicy })"],
  ["#start-session-button", "`#${dialogId}-start`"],
  ["#remote-provider-input", "the model pill menu — startRemoteSession drives it"],
  ["#remote-model-input", "the model pill menu — startRemoteSession drives it"],
  ["#remote-approval-policy-input", "the approval pill — startRemoteSession({ approvalPolicy })"],
  ["#remote-cwd-input", "`#remote-start-session-dialog-cwd`"],
  ["#remote-start-session-button", "`#remote-start-session-dialog-start`"],
];

function scriptFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...scriptFiles(full));
    } else if (entry.name.endsWith(".mjs") || entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

// Comments legitimately name these ids; only live code is a defect.
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const FILES = scriptFiles(SCRIPTS);

test("the scripts tree has sources to scan at all", () => {
  assert.ok(FILES.length > 20, `expected a real tree, found ${FILES.length} files`);
});

test("no e2e script drives a removed start-session control", () => {
  const offences = [];

  for (const file of FILES) {
    if (file === fileURLToPath(import.meta.url)) continue;
    const code = withoutComments(fs.readFileSync(file, "utf8"));
    for (const [selector, replacement] of REMOVED) {
      // Word-boundary on the right so `#cwd-input` does not match
      // `#remote-cwd-input-something`; the leading `#` anchors the left.
      const pattern = new RegExp(`${selector}(?![\\w-])`);
      if (pattern.test(code)) {
        offences.push(
          `${path.relative(REPO, file)} still drives "${selector}" — use ${replacement}`
        );
      }
    }
  }

  assert.deepEqual(
    offences,
    [],
    `e2e scripts driving controls the UI no longer renders:\n  ${offences.join("\n  ")}`
  );
});
