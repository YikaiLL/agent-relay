import test from "node:test";
import assert from "node:assert/strict";

import { createOrchestratorChatActions } from "./orchestrator-chat.js";

function harness(overrides = {}) {
  const calls = { send: [], propose: [], confirm: [], openTask: [], invalidate: 0 };
  const state = { session: { orchestrator_proposals: [] } };
  const actions = createOrchestratorChatActions({
    state,
    sendMessage: async (text, threadId) => {
      calls.send.push([text, threadId]);
      return true;
    },
    proposeOrchestratorTask: async (body) => {
      calls.propose.push(body);
      return { proposal: { id: "prop-1", title: body.title } };
    },
    confirmOrchestratorProposal: async (id) => {
      calls.confirm.push(id);
      return { team_run_id: "run-1" };
    },
    teamsCache: {
      invalidate: () => {
        calls.invalidate += 1;
      },
    },
    onOpenTask: (id) => calls.openTask.push(id),
    ...overrides,
  });
  return { actions, calls, state };
}

// The bug this pins: every Send proposed *and* confirmed, so saying "hello" to
// the Orchestrator spawned a whole planner/dev/reviewer team. Chat is chat.
test("chatting with the Orchestrator never starts a task", async () => {
  const { actions, calls } = harness();

  await actions.send("hello", "orch-1");

  assert.deepEqual(calls.send, [["hello", "orch-1"]]);
  assert.deepEqual(calls.propose, [], "a greeting must not be proposed as a task");
  assert.deepEqual(calls.confirm, [], "a greeting must not start a run");
  assert.deepEqual(calls.openTask, [], "chatting must not navigate into a task");
});

test("even a task-shaped message is still only chat", async () => {
  const { actions, calls, state } = harness();

  await actions.send("Add a parser to the CLI\n\nKeep the tests green.", "orch-1");

  assert.equal(calls.send.length, 1);
  assert.deepEqual(calls.propose, []);
  assert.deepEqual(calls.confirm, []);
  assert.deepEqual(state.session.orchestrator_proposals, []);
});

test("a refused message surfaces the error and still starts nothing", async () => {
  const { actions, calls, state } = harness({ sendMessage: async () => false });

  assert.equal(state.orchestratorSendError, undefined);
  await actions.send("hello", "orch-1");

  assert.ok(state.orchestratorSendError, "a refused send must say so");
  assert.deepEqual(calls.propose, []);
  assert.deepEqual(calls.confirm, []);
});

// The bug this pins: the relay says exactly why ("that thread is busy with a
// turn", "thread '…' was not found on any provider"), `sendMessage` files that
// sentence against the thread, and the pane painted "Message was not accepted"
// over it. That line is unactionable — it cannot tell a stuck turn from a dead
// pin, so the only move left is guessing. See shared/composer-errors.js: the
// relay's `error.message` is stored verbatim precisely so it is not paraphrased.
test("a refused message shows the relay's reason, not a placeholder", async () => {
  const reason = "that thread is busy with a turn; wait for it to finish";
  const asked = [];
  const { actions, state } = harness({
    sendMessage: async () => false,
    readSendError: (threadId) => {
      asked.push(threadId);
      return reason;
    },
  });

  await actions.send("hello", "orch-1");

  assert.equal(state.orchestratorSendError, reason);
  assert.deepEqual(asked, ["orch-1"], "the reason is read for the thread that refused");
});

// Only when the relay left nothing behind does the generic line get to stand.
test("a refused message falls back to a generic line when there is no reason", async () => {
  const { actions, state } = harness({
    sendMessage: async () => false,
    readSendError: () => "",
  });

  await actions.send("hello", "orch-1");

  assert.equal(state.orchestratorSendError, "Message was not accepted");
});

test("Propose as task stages a card without starting it", async () => {
  const { actions, calls, state } = harness();

  await actions.propose("Add a parser\n\nTouch the CLI.");

  assert.deepEqual(calls.propose, [{ title: "Add a parser", context: "Touch the CLI." }]);
  assert.deepEqual(calls.confirm, [], "the user applies the card; propose must not");
  assert.deepEqual(
    state.session.orchestrator_proposals.map((entry) => entry.id),
    ["prop-1"]
  );
});

test("a title-less draft is refused before any request goes out", async () => {
  const { actions, calls, state } = harness();

  await actions.propose("   ");

  assert.deepEqual(calls.propose, []);
  assert.match(state.orchestratorSendError, /title/i);
});

test("confirming a card is the step that starts the run", async () => {
  const { actions, calls, state } = harness();
  await actions.propose("Add a parser");

  const receipt = await actions.confirm("prop-1");

  assert.deepEqual(calls.confirm, ["prop-1"]);
  assert.equal(receipt.team_run_id, "run-1");
  assert.deepEqual(calls.openTask, ["run-1"], "confirming opens the run it started");
  assert.equal(calls.invalidate, 1, "the teams cache must refetch after a run starts");
  assert.deepEqual(state.session.orchestrator_proposals, [], "the applied card is cleared");
});

test("send forwards attached images, and an image alone is enough to send", async () => {
  const calls = [];
  const state = { session: { orchestrator_proposals: [] } };
  const actions = createOrchestratorChatActions({
    state,
    sendMessage: async (text, threadId, images) => {
      calls.push({ text, threadId, images });
      return true;
    },
  });

  await actions.send("look at this", "orch-1", [{ data_url: "data:image/png;base64,AAA" }]);
  await actions.send("", "orch-1", [{ data_url: "data:image/png;base64,BBB" }]);
  await actions.send("", "orch-1", []);

  assert.equal(calls.length, 2, "empty text AND no image is the only nothing");
  assert.deepEqual(calls[0].images, [{ data_url: "data:image/png;base64,AAA" }]);
  assert.equal(calls[1].text, "");
  assert.deepEqual(calls[1].images, [{ data_url: "data:image/png;base64,BBB" }]);
});
