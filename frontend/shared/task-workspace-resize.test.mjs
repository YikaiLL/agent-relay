// Guards for the Tasks Orchestrator resize panel — must never collapse to 0
// (there is no reopen toggle), and must opt into createPanelControl's
// non-collapsible mode.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(new URL("./task-workspace-resize.js", import.meta.url));
const source = readFileSync(sourcePath, "utf8");

test("Tasks Orchestrator panel opts out of collapse-to-zero", () => {
  assert.match(
    source,
    /collapsible:\s*false/,
    "task-workspace-resize must pass collapsible:false — there is no reopen control"
  );
});

test("Tasks Orchestrator panel resolves max width from the workspace container", () => {
  assert.match(
    source,
    /resolveMaxOpenWidth/,
    "half-workspace cap must live in the controller, not a CSS min() that desyncs drag"
  );
  assert.match(source, /0\.5|50\s*%|\*\s*0\.5/);
  assert.match(
    source,
    /reclampToContainer/,
    "container sync must reclamp from the preferred width without persisting"
  );
  assert.doesNotMatch(
    source,
    /setWidth\(control\.getWidth\(\)\)/,
    "sync must not commit getWidth() — that permanently shrinks a saved desktop preference"
  );
});
