import test from "node:test";
import assert from "node:assert/strict";

import {
  TEAM_RUN_HAND_BACK_UNAVAILABLE,
  canHandBackLineComment,
  lineCommentHandBackButtonState,
  lineCommentHandBackDisabledReason,
} from "./line-comment-actions.js";

test("team_run scope cannot hand back even when status is open", () => {
  assert.equal(canHandBackLineComment("team_run:run-1"), false);
  const state = lineCommentHandBackButtonState("team_run:run-1", { status: "open" });
  assert.equal(state.show, true);
  assert.equal(state.disabled, true);
  assert.equal(state.reason, TEAM_RUN_HAND_BACK_UNAVAILABLE);
});

test("thread scope can hand back open comments", () => {
  assert.equal(canHandBackLineComment("thread:t-1"), true);
  const state = lineCommentHandBackButtonState("thread:t-1", { status: "open" });
  assert.equal(state.show, true);
  assert.equal(state.disabled, false);
  assert.equal(state.reason, null);
});

test("resolved comments hide the hand-back control", () => {
  const state = lineCommentHandBackButtonState("thread:t-1", { status: "resolved" });
  assert.equal(state.show, false);
});

test("list API fields override scope inference", () => {
  assert.equal(
    canHandBackLineComment("team_run:run-1", { canHandBack: false }),
    false
  );
  assert.equal(
    lineCommentHandBackDisabledReason("team_run:run-1", {
      handBackUnavailableReason: "server says no",
    }),
    "server says no"
  );
});

test("a clickable-looking control never appears without a disabled reason when blocked", () => {
  const state = lineCommentHandBackButtonState("team_run:run-1");
  assert.notEqual(state.disabled, false, "must not look enabled on team_run");
  assert.ok(state.reason, "disabled control must explain why");
});
