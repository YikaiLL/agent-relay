// Live interaction tests for collapsing a sidebar group header, mounted under
// jsdom. Targets ThreadGroupHeader directly rather than ThreadGroupList: the list
// is virtualized, and the virtualizer measures zero-height rows under jsdom, so
// nothing would render.
//
// Two gaps are captured here:
//
//   1. cwd ("folder") headers — the collapsible branch only ever called
//      onToggleGroup, so wiring collapse into a surface that also wants the
//      header to set the active workspace (local Sessions mode) silently DROPPED
//      the workspace selection. Collapse and select have to coexist on one click.
//
//   2. project headers — ThreadGroupHeader short-circuits to a static header as
//      soon as the group carries a projectId AND a rename/delete handler, so the
//      collapse machinery (collapsible/collapsedGroupCwds/onToggleGroup, all
//      already passed by local's Projects mode) was unreachable: no chevron, and
//      onToggleGroup was never called. Selecting the project is what re-points
//      the right-hand tab strip, so toggling must NOT replace it — both fire.
//
// Kept in its own file so the DOM globals below don't leak into the static suite.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ThreadGroupHeader } = await import("./thread-list-react.js");

const h = React.createElement;

const CWD_GROUP = { cwd: "/tmp/work", label: "work" };
const PROJECT_GROUP = {
  key: "proj-1",
  cwd: "",
  projectId: "proj-1",
  label: "Alpha",
  summary: { working: 0, needsInput: 0, total: 2 },
};

function mount(props) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(h(ThreadGroupHeader, props));
  });
  return {
    host,
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function click(element) {
  assert.ok(element, "expected the element under test to exist");
  act(() => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

// --- cwd / "folder" headers -------------------------------------------------

test("a collapsible cwd header toggles collapse AND still selects the workspace", () => {
  const toggled = [];
  const selected = [];
  const { host, cleanup } = mount({
    collapsible: true,
    group: CWD_GROUP,
    isCollapsed: false,
    normalizedCwd: "/tmp/work",
    onSelectWorkspace: (cwd) => selected.push(cwd),
    onToggleGroup: (cwd) => toggled.push(cwd),
  });

  click(host.querySelector(".thread-group-header"));

  // Collapse is the new behaviour...
  assert.deepEqual(toggled, ["/tmp/work"]);
  // ...but the header is also what points new sessions at this workspace. Losing
  // that is the regression this test exists to prevent.
  assert.deepEqual(selected, ["/tmp/work"]);
  cleanup();
});

test("a collapsible cwd header reports its state through aria-expanded", () => {
  const open = mount({
    collapsible: true,
    group: CWD_GROUP,
    isCollapsed: false,
    normalizedCwd: "/tmp/work",
    onToggleGroup: () => {},
  });
  assert.equal(open.host.querySelector(".thread-group-header").getAttribute("aria-expanded"), "true");
  open.cleanup();

  const shut = mount({
    collapsible: true,
    group: CWD_GROUP,
    isCollapsed: true,
    normalizedCwd: "/tmp/work",
    onToggleGroup: () => {},
  });
  assert.equal(shut.host.querySelector(".thread-group-header").getAttribute("aria-expanded"), "false");
  shut.cleanup();
});

// The Unknown-workspace key is a display sentinel, never a real directory — it
// must not reach onSelectWorkspace even now that collapse shares the click.
test("the unknown-workspace header collapses without leaking the sentinel as a cwd", () => {
  const toggled = [];
  const selected = [];
  const { host, cleanup } = mount({
    collapsible: true,
    group: { cwd: "__unknown_workspace__", label: "Unknown workspace" },
    isCollapsed: false,
    normalizedCwd: "__unknown_workspace__",
    onSelectWorkspace: (cwd) => selected.push(cwd),
    onToggleGroup: (cwd) => toggled.push(cwd),
  });

  click(host.querySelector(".thread-group-header"));

  assert.deepEqual(toggled, ["__unknown_workspace__"]);
  assert.deepEqual(selected, [], "the sentinel must never be handed out as a workspace path");
  cleanup();
});

// --- project headers --------------------------------------------------------

test("a project header renders a collapse chevron", () => {
  const { host, cleanup } = mount({
    collapsible: true,
    group: PROJECT_GROUP,
    isCollapsed: false,
    normalizedCwd: "proj-1",
    onDeleteProject: () => {},
    onRenameProject: () => {},
    onToggleGroup: () => {},
  });

  assert.ok(
    host.querySelector(".thread-group-header-project .thread-group-chevron"),
    "the project header must show the same collapse affordance as a cwd header"
  );
  cleanup();
});

test("clicking a project header toggles collapse", () => {
  const toggled = [];
  const { host, cleanup } = mount({
    collapsible: true,
    group: PROJECT_GROUP,
    isCollapsed: false,
    normalizedCwd: "proj-1",
    onDeleteProject: () => {},
    onRenameProject: () => {},
    onToggleGroup: (key) => toggled.push(key),
  });

  click(host.querySelector(".thread-group-header-project"));

  assert.deepEqual(toggled, ["proj-1"]);
  cleanup();
});

// The whole row is the click target a user aims at — the name is a few characters
// wide, and everything either side of it is the same row. Selecting the project
// (which re-points the right-hand tab strip) must therefore hang off the ROW, not
// only off the name; otherwise the tab strip only follows a pixel-perfect click.
test("clicking anywhere on a project row selects the project, not just toggles it", () => {
  const toggled = [];
  const picked = [];
  const { host, cleanup } = mount({
    collapsible: true,
    group: PROJECT_GROUP,
    isCollapsed: false,
    normalizedCwd: "proj-1",
    onDeleteProject: () => {},
    onRenameProject: () => {},
    onSelectProject: (id) => picked.push(id),
    onToggleGroup: (key) => toggled.push(key),
  });

  click(host.querySelector(".thread-group-header-project"));

  assert.deepEqual(picked, ["proj-1"], "the row click must re-point the tab strip");
  assert.deepEqual(toggled, ["proj-1"]);
  cleanup();
});

// The chevron is the one control that means ONLY "fold this away" — it must not
// also yank the tab strip over to this project.
test("the project chevron toggles without selecting the project", () => {
  const toggled = [];
  const picked = [];
  const { host, cleanup } = mount({
    collapsible: true,
    group: PROJECT_GROUP,
    isCollapsed: false,
    normalizedCwd: "proj-1",
    onDeleteProject: () => {},
    onRenameProject: () => {},
    onSelectProject: (id) => picked.push(id),
    onToggleGroup: (key) => toggled.push(key),
  });

  click(host.querySelector(".thread-group-chevron-button"));

  assert.deepEqual(toggled, ["proj-1"]);
  assert.deepEqual(picked, []);
  cleanup();
});

// The nested session rows ARE the count — restating it as "2 sessions" is noise
// that also crowds the collapse chevron off the right edge.
test("a project header shows no raw session-count badge", () => {
  const { host, cleanup } = mount({
    collapsible: true,
    group: PROJECT_GROUP,
    isCollapsed: false,
    normalizedCwd: "proj-1",
    onDeleteProject: () => {},
    onRenameProject: () => {},
    onToggleGroup: () => {},
  });

  assert.doesNotMatch(host.innerHTML, /\bsessions?\b/i);
  cleanup();
});

// Working / needs-input are not counts-for-counting's-sake — they are the reason
// to look at a collapsed project at all, so they stay.
test("a project header keeps its working / needs-input badges", () => {
  const { host, cleanup } = mount({
    collapsible: true,
    group: { ...PROJECT_GROUP, summary: { working: 2, needsInput: 1, total: 5 } },
    isCollapsed: false,
    normalizedCwd: "proj-1",
    onDeleteProject: () => {},
    onRenameProject: () => {},
    onToggleGroup: () => {},
  });

  assert.match(host.innerHTML, /2 working/);
  assert.match(host.innerHTML, /1 needs input/);
  cleanup();
});

test("clicking the project NAME still selects the project and also toggles collapse", () => {
  const toggled = [];
  const picked = [];
  const { host, cleanup } = mount({
    collapsible: true,
    group: PROJECT_GROUP,
    isCollapsed: false,
    normalizedCwd: "proj-1",
    onDeleteProject: () => {},
    onRenameProject: () => {},
    onSelectProject: (id) => picked.push(id),
    onToggleGroup: (key) => toggled.push(key),
  });

  click(host.querySelector(".thread-group-name-button"));

  // Selecting a project is what re-points the right-hand tab strip at that
  // project's workspace. Collapse is additive — it must not displace it.
  assert.deepEqual(picked, ["proj-1"]);
  // Exactly once: the name button sits inside the header, so a bubbling click
  // plus the button's own handler would double-toggle back to where it started.
  assert.deepEqual(toggled, ["proj-1"]);
  cleanup();
});

test("project rename/delete buttons do not toggle collapse", () => {
  const toggled = [];
  const renamed = [];
  const deleted = [];
  const { host, cleanup } = mount({
    collapsible: true,
    group: PROJECT_GROUP,
    isCollapsed: false,
    normalizedCwd: "proj-1",
    onDeleteProject: (id) => deleted.push(id),
    onRenameProject: (id) => renamed.push(id),
    onToggleGroup: (key) => toggled.push(key),
  });

  const actions = host.querySelectorAll(".thread-group-action");
  click(actions[0]);
  click(actions[1]);

  assert.deepEqual(renamed, ["proj-1"]);
  assert.deepEqual(deleted, ["proj-1"]);
  assert.deepEqual(toggled, [], "acting on a project must not fold its sessions away");
  cleanup();
});

// Unlike a cwd header (itself a <button>), a project header is a <div> — it hosts
// the rename/delete <button>s, which cannot legally nest inside a button. So the
// chevron is the ARIA disclosure control and carries aria-expanded.
test("a project header reports its state through aria-expanded on the chevron", () => {
  const shut = mount({
    collapsible: true,
    group: PROJECT_GROUP,
    isCollapsed: true,
    normalizedCwd: "proj-1",
    onDeleteProject: () => {},
    onRenameProject: () => {},
    onToggleGroup: () => {},
  });
  assert.equal(
    shut.host.querySelector(".thread-group-chevron-button").getAttribute("aria-expanded"),
    "false"
  );
  shut.cleanup();
});

test("the project chevron toggles collapse exactly once (no double-fire from the row)", () => {
  const toggled = [];
  const { host, cleanup } = mount({
    collapsible: true,
    group: PROJECT_GROUP,
    isCollapsed: false,
    normalizedCwd: "proj-1",
    onDeleteProject: () => {},
    onRenameProject: () => {},
    onToggleGroup: (key) => toggled.push(key),
  });

  click(host.querySelector(".thread-group-chevron-button"));

  assert.deepEqual(toggled, ["proj-1"]);
  cleanup();
});

// Not every surface wires collapse (the header also renders in read-only spots).
// Without onToggleGroup the header must stay inert rather than growing a chevron
// that does nothing.
test("a project header without a toggle handler shows no chevron", () => {
  const { host, cleanup } = mount({
    collapsible: false,
    group: PROJECT_GROUP,
    isCollapsed: false,
    normalizedCwd: "proj-1",
    onDeleteProject: () => {},
    onRenameProject: () => {},
  });

  assert.equal(host.querySelector(".thread-group-chevron"), null);
  cleanup();
});
