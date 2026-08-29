import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApprovalCard } from "./shared/transcript-react.js";
import { APPROVAL_KIND_LABELS, approvalKindLabel } from "./shared/approval-labels.js";

// The approval card is the highest-stakes control in the product: it is where a
// user authorises an agent to touch their machine. Two things were wrong with
// how it presented itself.
//
// 1. It printed `approval.kind` raw, so the header read
//    "Approval requiredcommand_execution" — the wire enum, and with no
//    separator, because `.message-meta` is not a flex container and the two
//    elements are emitted adjacent with no whitespace between them.
// 2. The working directory — the single best answer to "what can this touch" —
//    was buried as the third line of prose, in the same style as the
//    explanation above it.
//
// Deliberately NOT changed here: no severity colour. `ApprovalRequestView`
// (protocol.rs:1389) carries no risk field, no provider sends one, and red is
// already spoken for on this screen — the session-settings gear rings red when
// the approval policy is `bypass`. A red card next to a red "approvals are off"
// ring would make the same colour mean two opposite things.

const HERE = dirname(fileURLToPath(import.meta.url));

const APPROVAL = {
  request_id: "req_8f2a",
  kind: "command_execution",
  summary: "Run a shell command",
  detail: "Claude wants to run a command in the workspace.",
  command: "rm -rf web/ && npm run build",
  cwd: "/Users/luchi/git/agent-relay",
  supports_session_scope: true,
};

function render(approval = APPROVAL) {
  return renderToStaticMarkup(React.createElement(ApprovalCard, { approval, options: null }));
}

test("every ApprovalKind the relay can send has a human label", () => {
  // The four variants of ApprovalKind (state/relay/approval.rs:85-105). If the
  // relay grows a fifth, this list is where it has to be named.
  assert.deepEqual(Object.keys(APPROVAL_KIND_LABELS).sort(), [
    "command_execution",
    "file_change",
    "permissions",
    "plan",
  ]);
  assert.equal(approvalKindLabel("command_execution"), "Shell command");
  assert.equal(approvalKindLabel("file_change"), "File change");
});

test("an unknown kind falls back to the wire value rather than vanishing", () => {
  // Showing a raw enum is bad; showing nothing at all is worse — the user would
  // be approving something with no idea what category it is.
  assert.equal(approvalKindLabel("teleportation"), "teleportation");
  assert.equal(approvalKindLabel(""), "");
  assert.equal(approvalKindLabel(null), "");
});

test("the card names the kind in words, not the wire enum", () => {
  const markup = render();
  assert.match(markup, /Shell command/);
  assert.doesNotMatch(
    markup,
    /command_execution/,
    "the serialized enum must not reach the screen"
  );
});

test("the kind sits in its own element so it can be spaced and styled", () => {
  assert.match(render(), /class="approval-kind"/);
});

test("the header cannot run its label into the kind", () => {
  // The markup emits <strong> and <span> adjacent with no whitespace, so the
  // separation has to come from CSS. Without this the header renders as one
  // run-on word, which is the bug that started this.
  const css = readFileSync(join(HERE, "conversation.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // Whole-selector match. A bare /\.message-meta\s*\{/ also matches
  // `.message-card-reasoning-empty .message-meta {`, and would have asserted
  // against that unrelated rule instead — the same trap the project-switcher
  // guard has a dedicated regression test for.
  const bodies = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match = re.exec(css);
  while (match) {
    if (match[1].split(",").map((s) => s.trim()).includes(".message-meta")) {
      bodies.push(match[2]);
    }
    match = re.exec(css);
  }
  assert.equal(bodies.length, 1, "expected exactly one `.message-meta` rule");
  assert.match(bodies[0], /display:\s*flex/, "`.message-meta` must be a flex row");
  assert.match(bodies[0], /gap:\s*\d/, "`.message-meta` must set a gap");
});

test("the working directory is a scope chip, not a third line of prose", () => {
  const markup = render();
  assert.match(markup, /class="approval-scope-chip"/);
  assert.match(markup, /\/Users\/luchi\/git\/agent-relay/);
  assert.doesNotMatch(
    markup,
    /class="approval-copy">cwd:/,
    "cwd must not render as prose in the same style as the explanation"
  );
});

test("a request without a cwd renders no empty scope row", () => {
  const markup = render({ ...APPROVAL, cwd: null });
  // Anchored on the class attribute: the Approve buttons carry a
  // `data-approval-scope` attribute, so a bare /approval-scope/ would match the
  // decision buttons and pass no matter what this branch rendered.
  assert.doesNotMatch(markup, /class="approval-scope/);
});

test("the card still carries no severity styling", () => {
  const markup = render();
  assert.doesNotMatch(
    markup,
    /data-tone|is-danger|approval-danger/,
    "nothing on the wire says how dangerous a request is; do not imply it"
  );
});

test("a long working directory stays fully recoverable", () => {
  // Regression: the first version of the scope chip ellipsised the path with
  // only a generic "Working directory" tooltip, so on a narrow remote screen
  // the exact directory a command was about to run in became unreadable — for
  // the one card where that matters most. The prose line it replaced wrapped.
  const cwd = "/Users/luchi/git/agent-relay/.sealwire/worktrees/some-very-long-worktree-name";
  const markup = render({ ...APPROVAL, cwd });

  assert.match(markup, new RegExp(`title="Working directory: ${cwd.replace(/\//g, "\\/")}"`),
    "the exact path must be in the tooltip, not just the field name");

  const css = readFileSync(join(HERE, "conversation.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = css.match(/\.approval-scope-path\s*\{([^}]*)\}/);
  assert.ok(rule, "expected an `.approval-scope-path` rule");
  assert.doesNotMatch(rule[1], /text-overflow:\s*ellipsis/,
    "the path must wrap rather than truncate — a clipped path cannot be read back");
  assert.match(rule[1], /overflow-wrap:\s*anywhere/,
    "long path segments have to break instead of forcing a sideways scroll");
});
