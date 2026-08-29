// Public entry point for the proprietary task-team E2E suite.
//
// The scenarios, prompt matchers, and workflow assertions live with the private
// engine. A public checkout skips loudly; a private-enabled checkout is swapped
// into crates/sealwire-private by scripts/with-private.sh before this runs.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const privateCrate = path.join(root, "crates", "sealwire-private");
if (existsSync(path.join(privateCrate, "STUB"))) {
  console.log(
    "task-team-e2e: SKIPPED — this checkout has the stub private crate.\n" +
      "  Run scripts/with-private.sh npm run test:task-team against the private crate."
  );
  process.exit(0);
}

const suite = path.join(privateCrate, "e2e", "task-team-e2e.mjs");
if (!existsSync(suite)) {
  throw new Error(`private task-team E2E suite is missing at ${suite}`);
}
const result = spawnSync(process.execPath, [suite], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
