import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { describeStaleBinary, findStaleBinaryReason } from "./binaries.mjs";

// A prebuilt binary that is OLDER than the Rust sources is the failure this
// guard exists for, and it is silent by construction: `E2E_USE_BUILT_BINARIES=1`
// (and `CI=true`) run `target/debug/<bin>` as-is, while `npm run build` only
// builds the frontend. Nothing anywhere rebuilds the crate.
//
// The cost is not a confusing error — it is a CONFIDENT WRONG ANSWER. The suite
// runs green code against a relay that predates the feature under test, so the
// browser observes behaviour the current tree does not have, and the assertion
// that fails is downstream of the real cause. Left alone it reads as a flaky
// scroll test. (That is exactly how it presented: a stale relay ignored a
// scenario's `approval_delay_ms`, fired the approval in the same beat as the
// send, and the stick-to-bottom suite reported an approval card "below the fold"
// against a follower that was behaving correctly.)
async function makeTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "binaries-guard-"));
  const srcDir = path.join(root, "crates", "relay-server", "src");
  await fs.mkdir(srcDir, { recursive: true });
  await fs.mkdir(path.join(root, "target", "debug"), { recursive: true });
  const sourcePath = path.join(srcDir, "lib.rs");
  const binaryPath = path.join(root, "target", "debug", "relay-server");
  await fs.writeFile(sourcePath, "fn main() {}\n", "utf8");
  await fs.writeFile(binaryPath, "binary\n", "utf8");
  return { root, sourcePath, binaryPath };
}

// mtimes are the signal, so set them explicitly rather than relying on write
// order — a same-millisecond filesystem would make the test meaningless.
async function stamp(file, epochMs) {
  const when = new Date(epochMs);
  await fs.utimes(file, when, when);
}

test("a binary newer than every Rust source is not stale", async () => {
  const { root, sourcePath, binaryPath } = await makeTree();
  try {
    await stamp(sourcePath, 1_000_000);
    await stamp(binaryPath, 2_000_000);

    assert.equal(await findStaleBinaryReason(binaryPath, { root }), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a binary older than a Rust source is reported as stale, naming the source", async () => {
  const { root, sourcePath, binaryPath } = await makeTree();
  try {
    await stamp(binaryPath, 1_000_000);
    await stamp(sourcePath, 2_000_000);

    const reason = await findStaleBinaryReason(binaryPath, { root });
    assert.ok(reason, "an older binary must be reported as stale");
    // Naming the newer file is the whole point: it turns "some test failed" into
    // "you did not rebuild after editing this".
    assert.match(reason, /lib\.rs/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Cargo.toml and Cargo.lock count as sources", async () => {
  const { root, sourcePath, binaryPath } = await makeTree();
  try {
    await stamp(sourcePath, 1_000_000);
    await stamp(binaryPath, 2_000_000);
    const lockPath = path.join(root, "Cargo.lock");
    await fs.writeFile(lockPath, "# lock\n", "utf8");
    await stamp(lockPath, 3_000_000);

    const reason = await findStaleBinaryReason(binaryPath, { root });
    assert.ok(reason, "a dependency change must invalidate the binary too");
    assert.match(reason, /Cargo\.lock/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a missing binary is not reported stale — the caller falls back to cargo run", async () => {
  const { root, binaryPath } = await makeTree();
  try {
    await fs.rm(binaryPath);
    assert.equal(await findStaleBinaryReason(binaryPath, { root }), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the refusal message states the remedy, not just the diagnosis", () => {
  const message = describeStaleBinary("relay-server", "some-binary is older than some-source");
  assert.match(message, /refusing to run a stale relay-server/);
  // Whoever hits this is mid-debug on an unrelated symptom; the exact command
  // has to be right there.
  assert.match(message, /cargo build -p relay-server/);
  assert.match(message, /E2E_USE_BUILT_BINARIES/);
});
