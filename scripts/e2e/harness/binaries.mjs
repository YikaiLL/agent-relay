import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

// Files whose mtime invalidates a prebuilt binary: every Rust source and
// manifest in the workspace, plus the lock (a dependency bump changes behaviour
// without touching a single .rs file).
//
// Workspace-wide rather than per-crate on purpose. Resolving which crates a
// binary actually depends on means parsing the manifests, and being wrong there
// fails OPEN — the exact outcome this guard exists to prevent. Over-reporting
// costs a no-op `cargo build`; under-reporting costs a green run of stale code.
const SOURCE_FILE_PATTERN = /\.rs$/;
const SOURCE_MANIFESTS = new Set(["Cargo.toml", "Cargo.lock"]);

export function resolveRelayServerCommand() {
  return resolveCargoBinaryCommand("relay-server");
}

export function resolveRelayBrokerCommand() {
  return resolveCargoBinaryCommand("relay-broker");
}

function resolveCargoBinaryCommand(binaryName) {
  const binaryPath = path.join(
    ROOT,
    "target",
    "debug",
    process.platform === "win32" ? `${binaryName}.exe` : binaryName
  );
  if (shouldUseBuiltBinary() && fs.existsSync(binaryPath)) {
    // Refuse to run a binary that predates the tree. Silently using one does not
    // produce a confusing failure — it produces a CONFIDENT WRONG ANSWER: the
    // suite exercises current frontend code against a relay that predates the
    // feature under test, and the assertion that blows up is somewhere
    // downstream of the real cause. That is not hypothetical; it is how this
    // guard came to exist. A relay built before `approval_delay_ms` existed
    // ignored the scenario knob, fired the approval in the same beat as the
    // send, and the stick-to-bottom suite reported an approval card "below the
    // fold" — deterministically, with identical pixel geometry every run —
    // against a follower that was doing its job correctly.
    //
    // Nothing rebuilds this for you: `npm run build` is `vite build` (frontend
    // only), and the scripts that opt in via `E2E_USE_BUILT_BINARIES=1` just
    // exec whatever is sitting in target/debug.
    const staleReason = findStaleBinaryReason(binaryPath);
    if (staleReason) {
      throw new Error(describeStaleBinary(binaryName, staleReason));
    }
    return {
      command: binaryPath,
      args: [],
    };
  }

  return {
    command: "cargo",
    args: ["run", "-p", binaryName],
  };
}

/**
 * The refusal message: why the binary is untrusted, and how to fix it. Kept
 * separate from the detection so the remedy is stated in exactly one place.
 *
 * @param {string} binaryName
 * @param {string} reason  from `findStaleBinaryReason`
 * @returns {string}
 */
export function describeStaleBinary(binaryName, reason) {
  return (
    `refusing to run a stale ${binaryName}: ${reason}\n`
    + `  Rebuild it first:  cargo build -p ${binaryName}\n`
    + `  (or unset E2E_USE_BUILT_BINARIES to fall back to \`cargo run\`)`
  );
}

/**
 * Human-readable reason a prebuilt binary must not be trusted, or null when it
 * is at least as new as every Rust source in the tree.
 *
 * A MISSING binary is not stale — the caller falls back to `cargo run`, which
 * compiles what is actually there.
 *
 * @param {string} binaryPath
 * @param {{ root?: string }} [options]
 * @returns {string | null}
 */
export function findStaleBinaryReason(binaryPath, { root = ROOT } = {}) {
  let binaryMtimeMs;
  try {
    binaryMtimeMs = fs.statSync(binaryPath).mtimeMs;
  } catch {
    return null;
  }

  const newest = findNewerSource(root, binaryMtimeMs);
  if (!newest) {
    return null;
  }
  const relative = path.relative(root, newest.filePath) || newest.filePath;
  return (
    `${path.relative(root, binaryPath) || binaryPath} was built `
    + `${describeGap(newest.mtimeMs - binaryMtimeMs)} before ${relative} was last changed`
  );
}

// How far behind the binary is, in whatever unit reads naturally. Sub-minute
// drift is still real (an edit-then-run loop), so it must not round to "0".
function describeGap(gapMs) {
  const minutes = Math.round(gapMs / 60000);
  if (minutes >= 1) {
    return `${minutes} minute(s)`;
  }
  return `${Math.max(1, Math.round(gapMs / 1000))} second(s)`;
}

// First source found that is newer than the binary. Returns early — we only need
// to know THAT one exists and which, not to rank them all.
function findNewerSource(root, binaryMtimeMs) {
  for (const manifest of SOURCE_MANIFESTS) {
    const manifestPath = path.join(root, manifest);
    const hit = newerThan(manifestPath, binaryMtimeMs);
    if (hit) {
      return hit;
    }
  }
  return walkForNewerSource(path.join(root, "crates"), binaryMtimeMs);
}

function walkForNewerSource(dir, binaryMtimeMs) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // `target` holds build OUTPUT, which is newer than the binary by
      // definition and would make every check report stale.
      if (entry.name === "target" || entry.name === ".git") {
        continue;
      }
      const hit = walkForNewerSource(entryPath, binaryMtimeMs);
      if (hit) {
        return hit;
      }
      continue;
    }
    if (!SOURCE_FILE_PATTERN.test(entry.name) && !SOURCE_MANIFESTS.has(entry.name)) {
      continue;
    }
    const hit = newerThan(entryPath, binaryMtimeMs);
    if (hit) {
      return hit;
    }
  }
  return null;
}

function newerThan(filePath, binaryMtimeMs) {
  try {
    const { mtimeMs } = fs.statSync(filePath);
    return mtimeMs > binaryMtimeMs ? { filePath, mtimeMs } : null;
  } catch {
    return null;
  }
}

function shouldUseBuiltBinary() {
  return process.env.CI === "true" || process.env.E2E_USE_BUILT_BINARIES === "1";
}
