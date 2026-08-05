// The relay-switch reset, tested directly.
//
// It used to be three lines inside a `useEffect`, reachable only by rendering the whole
// remote app — so the reviewer could confirm the Project-switcher half only by reading
// it. That is the same gap that let three guards ship green against the bugs they
// claimed to prevent this session: something that can only be inspected is something
// nobody re-checks after the next edit.
import test from "node:test";
import assert from "node:assert/strict";

import { resetRelayScopedState } from "./relay-scoped-state.js";
import { createThreadListStore, readActiveProjectId } from "../shared/thread-list-store.js";

function fakeRemoteUiStore() {
  const calls = [];
  return {
    calls,
    getState: () => ({
      setThreadFilterRetained(next) {
        calls.push(next);
      },
    }),
  };
}

test("switching relays forgets the pinned project", () => {
  const threadListStore = createThreadListStore();
  threadListStore.getState().setActiveProject("proj_from_relay_a");
  // Positive control: without this, "the id is null afterwards" is also true of a store
  // that never held one.
  assert.equal(readActiveProjectId(threadListStore), "proj_from_relay_a");

  resetRelayScopedState({ remoteUiStore: fakeRemoteUiStore(), threadListStore });

  assert.equal(
    readActiveProjectId(threadListStore),
    null,
    "a project id from one relay must not survive into another"
  );
});

test("switching relays forgets the bell's retained states", () => {
  const remoteUiStore = fakeRemoteUiStore();

  resetRelayScopedState({ remoteUiStore, threadListStore: createThreadListStore() });

  assert.equal(remoteUiStore.calls.length, 1, "the retention map is replaced");
  assert.equal(remoteUiStore.calls[0] instanceof Map, true);
  assert.equal(remoteUiStore.calls[0].size, 0, "and replaced with an EMPTY one");
});

// Called from an effect whose deps include stores that are null on the first renders of
// a surface with no relay yet. Throwing there would take the whole app down at exactly
// the moment there is nothing to reset.
test("it tolerates being called before either store exists", () => {
  assert.doesNotThrow(() => resetRelayScopedState());
  assert.doesNotThrow(() => resetRelayScopedState({}));
  assert.doesNotThrow(() => resetRelayScopedState({ threadListStore: createThreadListStore() }));
});
