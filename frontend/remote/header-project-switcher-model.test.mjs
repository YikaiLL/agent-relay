import test from "node:test";
import assert from "node:assert/strict";

import { selectRemoteHeaderProjectSwitcherModel } from "./header-project-switcher-model.js";

const HEADER = {
  title: "agent-relay",
  titleTitle: "/Users/luchi/git/agent-relay",
};

test("remote header switcher names a resolved project", () => {
  assert.deepEqual(
    selectRemoteHeaderProjectSwitcherModel({
      activeProjectId: "proj-ui",
      headerModel: HEADER,
      projects: [{ id: "proj-ui", name: "UI Redesign" }],
      projectsLoaded: true,
    }),
    {
      label: "UI Redesign",
      labelTooltip: "UI Redesign",
    }
  );
});

test("remote header switcher lets the shared switcher derive the default workspace", () => {
  assert.deepEqual(
    selectRemoteHeaderProjectSwitcherModel({
      activeProjectId: null,
      headerModel: HEADER,
      projects: [],
      projectsLoaded: true,
    }),
    {
      label: "",
      labelTooltip: "/Users/luchi/git/agent-relay",
    }
  );
});

test("remote header switcher uses the folder title only while project lookup is pending", () => {
  assert.deepEqual(
    selectRemoteHeaderProjectSwitcherModel({
      activeProjectId: "proj-ui",
      headerModel: HEADER,
      projects: [],
      projectsLoaded: false,
      projectsError: null,
    }),
    {
      label: "agent-relay",
      labelTooltip: "/Users/luchi/git/agent-relay",
    }
  );
});

test("remote header switcher falls through on project fetch errors", () => {
  assert.deepEqual(
    selectRemoteHeaderProjectSwitcherModel({
      activeProjectId: "proj-ui",
      headerModel: HEADER,
      projects: [],
      projectsLoaded: false,
      projectsError: "boom",
    }),
    {
      label: "",
      labelTooltip: "/Users/luchi/git/agent-relay",
    }
  );
});
