// The decision helper is unit-tested next to the key it keys on; this covers the wiring
// that reads it — that a first snapshot really reaches `store.refresh()`.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;

const { getRemoteWorkspaceDiffStore, notifyRemoteSessionUpdated } = await import(
  "./workspace-diff-host.js"
);

const SESSION = { current_cwd: "/repo", thread_workspaces_revision: 1, transcript: [] };

// `lastRemoteWorkspaceKey` is module state with no reset, so the three steps are ONE
// test: split up, each would silently depend on the previous one having run.
test("a remote snapshot refreshes on the first look and on every change, not in between", () => {
  const store = getRemoteWorkspaceDiffStore();
  // `refresh()` announces itself by moving the panel into `loading` before it fetches,
  // so a recorded status proves the snapshot reached the store — no network needed.
  const seen = [];
  const stop = store.subscribe((next) => seen.push(next.workspaceStatus));

  notifyRemoteSessionUpdated(SESSION);
  assert.ok(seen.length > 0, "a first snapshot that refetches nothing leaves the panel blank");

  seen.length = 0;
  notifyRemoteSessionUpdated(SESSION);
  assert.equal(seen.length, 0, "the poll must not turn into a fetch loop");

  seen.length = 0;
  notifyRemoteSessionUpdated({ ...SESSION, current_cwd: "/other" });
  assert.ok(seen.length > 0, "moving to another tree must re-resolve");

  stop();
});
