import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_WORKSPACE_SUBTITLE,
  buildProjectPickerRows,
  projectSubtitle,
} from "./project-picker-model.js";
import { formatRelativeTime } from "../remote/utils.js";

// The second line answers "which of these is alive right now", derived entirely
// from data the surfaces already hold.

const NOW = 1_700_000_000;
const minutesAgo = (n) => NOW - n * 60;
const daysAgo = (n) => NOW - n * 86_400;

function thread(id, updatedAt) {
  return { id, updated_at: updatedAt };
}

test("a project with running sessions reports both counts", () => {
  const subtitle = projectSubtitle({
    agents: [thread("a", NOW), thread("b", NOW), thread("c", NOW), thread("d", NOW)],
    threadActivity: new Map([
      ["a", { tool: "bash" }],
      ["b", { tool: "edit" }],
    ]),
    now: NOW,
  });

  assert.equal(subtitle, "4 sessions · 2 running");
});

test("a project with sessions but none running reports only the count", () => {
  const subtitle = projectSubtitle({
    agents: [thread("a", NOW), thread("b", NOW), thread("c", NOW)],
    now: NOW,
  });

  assert.equal(subtitle, "3 sessions");
});

test("one session is singular", () => {
  assert.equal(projectSubtitle({ agents: [thread("a", NOW)], now: NOW }), "1 session");
});

test("an empty project reports how long it has been quiet", () => {
  // A project with no live sessions still has a history. Naming its age is more
  // useful than "0 sessions", which reads as broken rather than as idle.
  const subtitle = projectSubtitle({ agents: [], lastActiveAt: daysAgo(3), now: NOW });

  assert.equal(subtitle, "idle · 3d");
});

test("an empty project with no history at all has no subtitle", () => {
  // Better to render nothing than to invent "idle · now" for a project created
  // ten seconds ago that has never held a session.
  assert.equal(projectSubtitle({ agents: [], now: NOW }), null);
});

test("idle age comes from the most recent session, not the oldest", () => {
  // The agents list is recency-sorted by selectProjectAgents, but this must not
  // depend on that — a caller passing them in any order gets the same answer.
  const subtitle = projectSubtitle({
    agents: [],
    lastActiveAt: Math.max(daysAgo(14), daysAgo(2)),
    now: NOW,
  });

  assert.equal(subtitle, "idle · 2d");
});

test("needs-input sessions count as running", () => {
  // A session waiting on an approval is blocked ON YOU, never quiet.
  const subtitle = projectSubtitle({
    agents: [thread("a", NOW), thread("b", NOW)],
    threadAttention: new Map([["a", "needs_input"]]),
    now: NOW,
  });

  assert.equal(subtitle, "2 sessions · 1 running");
});

test("rows put the default workspace first and mark the active project", () => {
  const rows = buildProjectPickerRows({
    projects: [
      { id: "p1", name: "Small improvement" },
      { id: "p2", name: "UI Redesign" },
    ],
    threads: [thread("t1", NOW), thread("t2", NOW), thread("t3", NOW)],
    threadProjectId: { t1: "p1", t2: "p1", t3: "p2" },
    activeProjectId: "p1",
    now: NOW,
  });

  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => [row.id, row.label, row.active]),
    [
      [null, "Default Workspace", false],
      ["p1", "Small improvement", true],
      ["p2", "UI Redesign", false],
    ]
  );
  assert.equal(rows[0].subtitle, DEFAULT_WORKSPACE_SUBTITLE);
  assert.equal(rows[1].subtitle, "2 sessions");
  assert.equal(rows[2].subtitle, "1 session");
});

test("the default workspace row is active when no project is selected", () => {
  const rows = buildProjectPickerRows({ projects: [], activeProjectId: null, now: NOW });

  assert.equal(rows[0].id, null);
  assert.equal(rows[0].active, true);
});

test("an active id whose project is gone falls back to the default row", () => {
  // Fail-open like the switcher: a project deleted elsewhere must not leave every
  // row unmarked.
  const rows = buildProjectPickerRows({
    projects: [{ id: "p1", name: "Small improvement" }],
    activeProjectId: "p-deleted",
    now: NOW,
  });

  assert.equal(rows[0].active, true, "the default row takes the mark");
  assert.equal(rows[1].active, false);
});

test("a project row's idle age uses its own newest session", () => {
  const rows = buildProjectPickerRows({
    projects: [{ id: "p1", name: "RN" }],
    threads: [thread("t1", daysAgo(9)), thread("t2", daysAgo(3))],
    threadProjectId: { t1: "p1", t2: "p1" },
    // Neither is live, so the row reports the count rather than an age...
    now: NOW,
  });

  assert.equal(rows[1].subtitle, "2 sessions");
});

test("a nameless project falls back to its id rather than rendering blank", () => {
  const rows = buildProjectPickerRows({
    projects: [{ id: "proj_00ff", name: "" }],
    now: NOW,
  });

  assert.equal(rows[1].label, "proj_00ff");
});

test("minutes-old activity still reads as a live session count", () => {
  const rows = buildProjectPickerRows({
    projects: [{ id: "p1", name: "Operation" }],
    threads: [thread("t1", minutesAgo(4))],
    threadProjectId: { t1: "p1" },
    threadActivity: new Map([["t1", { tool: "bash" }]]),
    now: NOW,
  });

  assert.equal(rows[1].subtitle, "1 session · 1 running");
});

test("the relative-time formatter still uses the real clock when no clock is injected", () => {
  // Number(null) is 0, so a finiteness check made "no clock" mean the epoch and
  // every remote timestamp read as "now".
  const anHourAgo = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(formatRelativeTime(anHourAgo), "1h");
  assert.equal(formatRelativeTime(anHourAgo, null), "1h");
  assert.equal(formatRelativeTime(1_000_000, 1_000_000 + 7200), "2h");
});
