import test from "node:test";
import assert from "node:assert/strict";

import { orchestratorCanWrite } from "./orchestrator-write-gate.js";

const DEVICE = "device-a";
const ORCH = "orch-thread-1";

// The regression. The Tasks screen used to borrow `canCurrentDeviceWrite`,
// whose first clause is `if (!session.active_thread_id) return false` — so a
// relay with no conversation open produced a dead composer captioned "Another
// device has control".
test("a relay with no conversation open can still write to the Orchestrator", () => {
  assert.equal(
    orchestratorCanWrite({
      session: { active_thread_id: null, active_controller_device_id: null },
      orchestratorThreadId: ORCH,
      deviceId: DEVICE,
    }),
    true
  );
});

test("another conversation holding the lease says nothing about the Orchestrator", () => {
  assert.equal(
    orchestratorCanWrite({
      session: {
        active_thread_id: "some-other-thread",
        active_controller_device_id: "device-b",
      },
      orchestratorThreadId: ORCH,
      deviceId: DEVICE,
    }),
    true
  );
});

// Not a blanket `true`: once a turn starts on the Orchestrator the relay
// focuses it (`focus_thread_runtime`), and from then on the lease is real.
test("a second device driving the Orchestrator itself is reported honestly", () => {
  assert.equal(
    orchestratorCanWrite({
      session: { active_thread_id: ORCH, active_controller_device_id: "device-b" },
      orchestratorThreadId: ORCH,
      deviceId: DEVICE,
    }),
    false
  );
});

test("this device holding the Orchestrator's own lease may write", () => {
  assert.equal(
    orchestratorCanWrite({
      session: { active_thread_id: ORCH, active_controller_device_id: DEVICE },
      orchestratorThreadId: ORCH,
      deviceId: DEVICE,
    }),
    true
  );
});

test("an unclaimed lease on the focused Orchestrator is writable", () => {
  assert.equal(
    orchestratorCanWrite({
      session: { active_thread_id: ORCH, active_controller_device_id: null },
      orchestratorThreadId: ORCH,
      deviceId: DEVICE,
    }),
    true
  );
});

// `composerDisabled` already covers "still opening". Answering `false` here
// would make that state announce a device conflict instead.
test("an Orchestrator that does not exist yet is not a device conflict", () => {
  assert.equal(
    orchestratorCanWrite({
      session: { active_thread_id: null, active_controller_device_id: null },
      orchestratorThreadId: null,
      deviceId: DEVICE,
    }),
    true
  );
});
