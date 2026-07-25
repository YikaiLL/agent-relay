import test from "node:test";
import assert from "node:assert/strict";

import { createDevicesCache } from "./devices-cache.js";
import { createWorkflowsCache } from "./workflows-cache.js";

test("devices cache fetches once per snapshot revision and keeps prior data on failure", async () => {
  const cache = createDevicesCache();
  let calls = 0;
  const fetchDevices = async () => {
    calls += 1;
    return {
      devices_revision: 1,
      device_records: [{ device_id: "phone-1" }],
      paired_devices: [{ device_id: "phone-1" }],
      pending_pairing_requests: [],
    };
  };

  await cache.sync(1, fetchDevices);
  await cache.sync(1, fetchDevices);
  assert.equal(calls, 1);
  assert.equal(cache.current().device_records[0].device_id, "phone-1");

  await cache.sync(2, async () => {
    throw new Error("offline");
  });
  assert.equal(cache.current().paired_devices.length, 1);
});

test("workflows cache rejects payload-less responses and refreshes on revision changes", async () => {
  const cache = createWorkflowsCache();
  let calls = 0;

  await cache.sync(3, async () => {
    calls += 1;
    return null;
  });
  assert.equal(cache.hasData(), false);

  await cache.sync(3, async () => {
    calls += 1;
    return {
      workflows_revision: 3,
      workflow_runs: [{ id: "workflow-1", status: "running" }],
    };
  });
  assert.equal(calls, 2, "a null response must leave the revision retryable");
  assert.equal(cache.current().workflow_runs[0].id, "workflow-1");

  await cache.sync(4, async () => ({
    workflows_revision: 4,
    workflow_runs: [],
  }));
  assert.deepEqual(cache.current().workflow_runs, []);
});
