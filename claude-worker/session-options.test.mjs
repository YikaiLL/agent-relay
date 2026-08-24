import test from "node:test";
import assert from "node:assert/strict";

import { buildSessionOptionsBase, createCwdReporter } from "./session-options.mjs";

const noopCanUseTool = () => ({ behavior: "allow", updatedInput: {} });
const defaults = { canUseTool: noopCanUseTool, defaultSettingSources: ["user"] };

test("default permission mode does not set allowDangerouslySkipPermissions", () => {
  const opts = buildSessionOptionsBase({ cwd: "/tmp", permissionMode: "default" }, defaults);
  assert.equal(opts.permissionMode, "default");
  assert.ok(!("allowDangerouslySkipPermissions" in opts));
});

test("acceptEdits does not opt into dangerous skip either", () => {
  const opts = buildSessionOptionsBase({ cwd: "/tmp", permissionMode: "acceptEdits" }, defaults);
  assert.equal(opts.permissionMode, "acceptEdits");
  assert.ok(!("allowDangerouslySkipPermissions" in opts));
});

test("bypassPermissions sets allowDangerouslySkipPermissions=true", () => {
  // The SDK refuses to enter bypassPermissions mode unless the host
  // explicitly opts in via this flag. Without it the session boots but
  // every tool call still calls back into canUseTool, defeating YOLO.
  const opts = buildSessionOptionsBase({ cwd: "/tmp", permissionMode: "bypassPermissions" }, defaults);
  assert.equal(opts.permissionMode, "bypassPermissions");
  assert.equal(opts.allowDangerouslySkipPermissions, true);
});

test("missing permissionMode falls back to default and stays safe", () => {
  const opts = buildSessionOptionsBase({ cwd: "/tmp" }, defaults);
  assert.equal(opts.permissionMode, "default");
  assert.ok(!("allowDangerouslySkipPermissions" in opts));
});

test("reviewer-read-only maps to bypassPermissions + a write-tool denylist", () => {
  // A read-only reviewer must inspect without prompts (the review loop is
  // non-interactive) but never edit. It runs bypassPermissions (reads + Bash auto-run)
  // with the file-mutation tools and AskUserQuestion removed from its toolset.
  const opts = buildSessionOptionsBase(
    { cwd: "/tmp", permissionMode: "reviewer-read-only" },
    defaults
  );
  assert.equal(opts.permissionMode, "bypassPermissions");
  assert.equal(opts.allowDangerouslySkipPermissions, true);
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "AskUserQuestion"]) {
    assert.ok(opts.disallowedTools.includes(tool), `${tool} must be disallowed`);
  }
  // Reads + Bash are NOT in the denylist (the reviewer needs to inspect).
  for (const tool of ["Read", "Grep", "Glob", "Bash"]) {
    assert.ok(!opts.disallowedTools.includes(tool), `${tool} must stay available`);
  }
});

test("non-reviewer modes carry no disallowedTools", () => {
  const opts = buildSessionOptionsBase({ cwd: "/tmp", permissionMode: "default" }, defaults);
  assert.ok(!("disallowedTools" in opts));
});

test("cwd observation hooks report PostToolUse and CwdChanged without rewriting tool output", async () => {
  const seen = [];
  const reporter = createCwdReporter((cwd) => seen.push(cwd));
  const opts = buildSessionOptionsBase(
    { cwd: "/tmp" },
    { ...defaults, observeCwd: reporter.observeCwd }
  );
  assert.ok(opts.hooks?.CwdChanged, "CwdChanged is the move event");
  assert.ok(opts.hooks?.PostToolUse, "PostToolUse.cwd covers a quiet stretch of reads");
  const cwdChanged = await opts.hooks.CwdChanged[0].hooks[0]({ cwd: "/repo/wt" });
  const postTool = await opts.hooks.PostToolUse[0].hooks[0]({
    cwd: "/repo/wt",
    tool_name: "Read",
  });
  assert.deepEqual(
    seen,
    ["/repo/wt"],
    "CwdChanged reports immediately; PostToolUse waits until the tool result is published"
  );
  reporter.flushPostToolCwd();
  assert.deepEqual(
    seen,
    ["/repo/wt", "/repo/wt"],
    "the same cwd must still be reported: recency has to advance after intervening writes"
  );
  assert.deepEqual(cwdChanged, {}, "observe-only: do not replace tool output");
  assert.deepEqual(postTool, {}, "observe-only: do not replace tool output");
});

test("PostToolUse cwd is held until flushPostToolCwd so it outranks the completed write", async () => {
  const seen = [];
  const reporter = createCwdReporter((cwd) => seen.push(cwd));
  const opts = buildSessionOptionsBase(
    { cwd: "/tmp" },
    { ...defaults, observeCwd: reporter.observeCwd }
  );
  await opts.hooks.PostToolUse[0].hooks[0]({
    cwd: "/repo/a",
    tool_name: "Write",
  });
  assert.deepEqual(
    seen,
    [],
    "PostToolUse runs before the SDK publishes the tool result; do not stamp cwd yet"
  );
  reporter.flushPostToolCwd();
  assert.deepEqual(seen, ["/repo/a"]);
});

test("CwdChanged drops a queued PostToolUse cwd so a real move is not overwritten", async () => {
  const seen = [];
  const reporter = createCwdReporter((cwd) => seen.push(cwd));
  const opts = buildSessionOptionsBase(
    { cwd: "/tmp" },
    { ...defaults, observeCwd: reporter.observeCwd }
  );
  await opts.hooks.PostToolUse[0].hooks[0]({ cwd: "/repo/b", tool_name: "Write" });
  await opts.hooks.CwdChanged[0].hooks[0]({ cwd: "/repo/a" });
  reporter.flushPostToolCwd();
  assert.deepEqual(seen, ["/repo/a"]);
});

test("parallel PostToolUse cwds survive a batch of tool results", async () => {
  const seen = [];
  const reporter = createCwdReporter((cwd) => seen.push(cwd));
  const opts = buildSessionOptionsBase(
    { cwd: "/tmp" },
    { ...defaults, observeCwd: reporter.observeCwd }
  );
  await Promise.all([
    opts.hooks.PostToolUse[0].hooks[0]({
      cwd: "/repo/a",
      tool_name: "Write",
      tool_use_id: "tool-1",
    }),
    opts.hooks.PostToolUse[0].hooks[0]({
      cwd: "/repo/a",
      tool_name: "Write",
      tool_use_id: "tool-2",
    }),
  ]);
  assert.deepEqual(seen, []);
  reporter.flushPostToolCwd("tool-1");
  reporter.flushPostToolCwd("tool-2");
  assert.deepEqual(seen, ["/repo/a", "/repo/a"]);
});

test("cwd observation hooks ignore subagent PostToolUse so the parent stays put", async () => {
  const seen = [];
  const reporter = createCwdReporter((cwd) => seen.push(cwd));
  const opts = buildSessionOptionsBase(
    { cwd: "/tmp" },
    { ...defaults, observeCwd: reporter.observeCwd }
  );
  await opts.hooks.PostToolUse[0].hooks[0]({
    cwd: "/repo/subagent-wt",
    tool_name: "Read",
    agent_id: "agent-sub-1",
  });
  await opts.hooks.CwdChanged[0].hooks[0]({ cwd: "/repo/parent-wt" });
  assert.deepEqual(seen, ["/repo/parent-wt"]);
});

test("model and explicit settingSources flow through", () => {
  const opts = buildSessionOptionsBase(
    {
      cwd: "/tmp",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      settingSources: ["project"],
    },
    defaults
  );
  assert.equal(opts.model, "claude-sonnet-4-6");
  assert.deepEqual(opts.settingSources, ["project"]);
  assert.equal(opts.canUseTool, noopCanUseTool);
});
