/// The browser suite's end-of-run report.
///
/// Its own module because `run-browser-suite.mjs` runs the suite at import time —
/// importing that to test the wording would spawn browsers.
///
/// A failing run must name EVERY scenario that failed. The suite runs 26 independent
/// specs in sequence, and stopping at the first failure meant each CI round taught us
/// exactly one name while the rest stayed invisible behind it.
export function summarize({ duration, failures, stoppedEarly = false, suiteName, total }) {
  if (!failures.length) {
    return [`[browser-suite] ${suiteName} passed ${total} scenario(s) in ${duration}`];
  }
  const lines = [
    `[browser-suite] ${suiteName}: ${failures.length} of ${total} scenario(s) failed in ${duration}`,
  ];
  for (const { failure, script } of failures) {
    lines.push(`[browser-suite]   ${script} (${failure})`);
  }
  if (stoppedEarly) {
    lines.push("[browser-suite]   ...stopped early (--fail-fast); later scenarios did not run");
  }
  return lines;
}
