import test from "node:test";
import assert from "node:assert/strict";

import {
  assignThreadToProject,
  createProject,
  deleteProject,
  fetchProjectsPayload,
  renameProject,
  unassignThread,
} from "./project-actions.js";

function recordingApiFetch(data = { message: "ok" }) {
  const calls = [];
  const apiFetch = async (path, init) => {
    calls.push({ path, init, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: true, json: async () => ({ ok: true, data }) };
  };
  return { apiFetch, calls };
}

test("each mutation POSTs /api/projects with the right internally-tagged body", async () => {
  const { apiFetch, calls } = recordingApiFetch({ projects: [], thread_project_id: {}, message: "ok" });

  await createProject(apiFetch, "Sealwire");
  await renameProject(apiFetch, "proj_x", "Renamed");
  await deleteProject(apiFetch, "proj_x");
  await assignThreadToProject(apiFetch, "t1", "proj_x");
  await unassignThread(apiFetch, "t1");

  assert.deepEqual(
    calls.map((call) => call.body),
    [
      { action: "create", name: "Sealwire" },
      { action: "rename", project_id: "proj_x", name: "Renamed" },
      { action: "delete", project_id: "proj_x" },
      { action: "assign", thread_id: "t1", project_id: "proj_x" },
      { action: "unassign", thread_id: "t1" },
    ]
  );
  assert.ok(calls.every((call) => call.path === "/api/projects" && call.init.method === "POST"));
});

test("fetchProjectsPayload GETs /api/projects and returns the payload", async () => {
  const data = { projects_revision: 3, projects: [{ id: "p", name: "P" }], thread_project_id: { t1: "p" } };
  const { apiFetch, calls } = recordingApiFetch(data);
  const payload = await fetchProjectsPayload(apiFetch);
  assert.equal(calls[0].path, "/api/projects");
  assert.equal(calls[0].init.method, "GET");
  assert.deepEqual(payload, data);
});

test("a non-ok response rejects with the server message", async () => {
  const apiFetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ ok: false, error: { message: "project name must not be empty" } }),
  });
  await assert.rejects(() => createProject(apiFetch, ""), /must not be empty/);
});
