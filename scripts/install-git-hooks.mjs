import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isCheckout = spawnSync("git", ["rev-parse", "--git-dir"], {
  cwd: repoRoot,
  stdio: "ignore",
});

// npm also runs `prepare` while packing/installing the published package, where
// there may be no Git checkout to configure. That is not an error.
if (isCheckout.status !== 0) {
  process.exit(0);
}

const hooksPath = path.join(repoRoot, ".githooks");
const configured = spawnSync("git", ["config", "core.hooksPath", hooksPath], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (configured.status !== 0) {
  throw new Error(configured.stderr || "failed to configure the repository's Git hooks");
}

console.log(`git hooks: ${hooksPath}`);
