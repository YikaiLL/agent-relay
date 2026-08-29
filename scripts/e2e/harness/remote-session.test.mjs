import test from "node:test";
import assert from "node:assert/strict";

import { remoteStatusBlocksMessageInput } from "./remote-session.mjs";

test("remote message input readiness only blocks on transport/repair statuses", () => {
  for (const status of ["Offline", "Re-pair", "Re-pair required"]) {
    assert.equal(remoteStatusBlocksMessageInput(status), true, status);
  }

  for (const status of [
    "",
    "Approval",
    "Approval pending",
    "Review blocked",
    "Code Flow blocked",
    "Failed",
  ]) {
    assert.equal(remoteStatusBlocksMessageInput(status), false, status);
  }
});
