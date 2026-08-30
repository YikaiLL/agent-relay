import test from "node:test";
import assert from "node:assert/strict";

import { summarize } from "./suite-report.mjs";

// The suite runs its scenarios in sequence and they are independent of one another,
// so a failure must not hide the ones behind it. It used to: the runner threw on the
// first non-zero exit, and a suite that had been red for weeks gave up one scenario
// name per CI round (5/26, then 16/26, then 19/26) while the rest stayed unknown.
test("a failing run names every scenario that failed, not just the first", () => {
  const lines = summarize({
    duration: "120.0s",
    failures: [
      { failure: "exit code 1", script: "browser-stick-to-bottom-e2e.mjs" },
      { failure: "exit code 1", script: "browser-local-search-filter-e2e.mjs" },
    ],
    suiteName: "local-core",
    total: 26,
  });

  const report = lines.join("\n");
  assert.match(report, /2 of 26 scenario\(s\) failed/);
  assert.match(report, /browser-stick-to-bottom-e2e\.mjs/);
  assert.match(report, /browser-local-search-filter-e2e\.mjs/);
  assert.doesNotMatch(report, /stopped early/, "a full run must not claim it stopped early");
});

test("a clean run reports the count it actually ran", () => {
  const lines = summarize({
    duration: "90.0s",
    failures: [],
    suiteName: "local-core",
    total: 26,
  });

  assert.deepEqual(lines, ["[browser-suite] local-core passed 26 scenario(s) in 90.0s"]);
});

// --fail-fast is for local work on one known failure. It must say so, because
// "1 of 26 failed" would otherwise read as "the other 25 passed".
test("--fail-fast says the later scenarios never ran", () => {
  const lines = summarize({
    duration: "10.0s",
    failures: [{ failure: "exit code 1", script: "browser-stick-to-bottom-e2e.mjs" }],
    stoppedEarly: true,
    suiteName: "local-core",
    total: 26,
  });

  assert.match(lines.join("\n"), /stopped early .*later scenarios did not run/);
});
