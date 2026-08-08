// The ordering rule for changing which relay this surface is.
//
// It exists as a named helper rather than a habit at each call site because the failure
// is invisible: the two store patches both succeed, and only something that reads the
// relay id AND the session in the window between them can tell. That is precisely what
// per-relay client state does — the session tab set would persist the departing relay's
// thread ids into the arriving relay's database.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { replaceRemoteIdentity } from "./identity-change.js";

test("the surface is cleared before the identity moves", () => {
  const order = [];
  replaceRemoteIdentity({
    resetSurface: () => order.push("reset"),
    moveIdentity: () => order.push("move"),
  });
  assert.deepEqual(order, ["reset", "move"]);
});

test("a failed reset does not move the identity", () => {
  let moved = false;
  assert.throws(() =>
    replaceRemoteIdentity({
      resetSurface: () => {
        throw new Error("reset failed");
      },
      moveIdentity: () => {
        moved = true;
      },
    })
  );
  assert.equal(moved, false, "moving after a failed reset is the hazard, not the recovery");
});

test("it tolerates either half being absent", () => {
  assert.doesNotThrow(() => replaceRemoteIdentity({}));
  assert.doesNotThrow(() => replaceRemoteIdentity());
});

// The rule is only worth having if every site follows it. These are the three places the
// surface changes which relay it is; a fourth added without the helper is the bug.
test("every identity-change site goes through the helper", async () => {
  const sites = [
    ["./remote-runtime.js", "switchRemoteRelay"],
    ["./remote-runtime.js", "returnToRelayHome"],
    ["./pairing.js", "forgetCurrentDevice"],
  ];
  for (const [file, fn] of sites) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const start = source.indexOf(`function ${fn}(`);
    assert.notEqual(start, -1, `${file} no longer defines ${fn}`);
    // Up to the next top-level declaration.
    const rest = source.slice(start);
    const end = rest.search(/\n(export )?(async )?function /);
    const body = end === -1 ? rest : rest.slice(0, end);
    assert.ok(
      body.includes("replaceRemoteIdentity"),
      `${fn} changes the surface's relay identity without replaceRemoteIdentity, so the `
        + "session can still be read against the new relay id"
    );
  }
});
