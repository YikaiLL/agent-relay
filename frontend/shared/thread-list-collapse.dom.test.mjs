// Live interaction tests for collapsing a sidebar group header, mounted under
// jsdom. Targets ThreadGroupHeader directly rather than ThreadGroupList: the list
// is virtualized, and the virtualizer measures zero-height rows under jsdom, so
// nothing would render.
//
// THE CONTRACT — one control per intent, no click does two things:
//
//   * the +/− disclosure button  -> fold/unfold, and ONLY that
//   * the label (and the rest of the row) -> select, and ONLY that
//
// This split is the whole point. Folding used to ride along with selection, which
// meant clicking an already-selected project to make it active ALSO folded it —
// hiding the very sessions you were reaching for. Selection is idempotent;
// toggling is not, so they cannot share a click target.
//
// Both header kinds behave identically here. A cwd ("folder") header therefore
// cannot be a <button> anymore — it has to host the disclosure <button>, and
// nesting buttons is invalid — so it is a <div> with a <button> label, exactly
// like a project header already was.
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

function cwdProps(extra = {}) {
  return {
    collapsible: true,
    group: CWD_GROUP,
    isCollapsed: false,
    normalizedCwd: "/tmp/work",
    ...extra,
  };
}

function projectProps(extra = {}) {
  return {
    collapsible: true,
    group: PROJECT_GROUP,
    isCollapsed: false,
    normalizedCwd: "proj-1",
    onDeleteProject: () => {},
    onRenameProject: () => {},
    ...extra,
  };
}

// --- the disclosure control -------------------------------------------------

test("the disclosure shows a plus when collapsed and a minus when expanded", () => {
  const shut = mount(projectProps({ isCollapsed: true, onToggleGroup: () => {} }));
  const collapsed = shut.host.querySelector(".thread-group-disclosure");
  assert.equal(collapsed.getAttribute("aria-expanded"), "false");
  assert.equal(collapsed.dataset.state, "collapsed");
  // A plus is a minus plus one stroke — the vertical bar is what distinguishes them.
  assert.equal(collapsed.querySelectorAll("svg path").length, 2, "collapsed must render '+'");
  shut.cleanup();

  const open = mount(projectProps({ onToggleGroup: () => {} }));
  const expanded = open.host.querySelector(".thread-group-disclosure");
  assert.equal(expanded.getAttribute("aria-expanded"), "true");
  assert.equal(expanded.dataset.state, "expanded");
  assert.equal(expanded.querySelectorAll("svg path").length, 1, "expanded must render '−'");
  open.cleanup();
});

test("a cwd header gets the same disclosure control as a project header", () => {
  const { host, cleanup } = mount(cwdProps({ isCollapsed: true, onToggleGroup: () => {} }));
  const disclosure = host.querySelector(".thread-group-disclosure");
  assert.ok(disclosure, "folder rows need the same +/− affordance as projects");
  assert.equal(disclosure.getAttribute("aria-expanded"), "false");
  assert.equal(disclosure.querySelectorAll("svg path").length, 2);
  cleanup();
});

// Nested <button> is invalid HTML, so the header cannot stay a <button> once it
// hosts the disclosure. Guard the structure, not just the behaviour.
test("a collapsible header is not itself a button", () => {
  const { host, cleanup } = mount(cwdProps({ onToggleGroup: () => {}, onSelectWorkspace: () => {} }));
  assert.equal(host.querySelector(".thread-group-header").tagName, "DIV");
  assert.equal(host.querySelectorAll("button button").length, 0);
  cleanup();
});

// --- toggle is ONLY the disclosure ------------------------------------------

test("the cwd disclosure folds without selecting the workspace", () => {
  const toggled = [];
  const selected = [];
  const { host, cleanup } = mount(
    cwdProps({
      onSelectWorkspace: (cwd) => selected.push(cwd),
      onToggleGroup: (cwd) => toggled.push(cwd),
    })
  );

  click(host.querySelector(".thread-group-disclosure"));

  assert.deepEqual(toggled, ["/tmp/work"]);
  assert.deepEqual(selected, [], "folding is not a selection");
  cleanup();
});

test("the project disclosure folds without selecting the project", () => {
  const toggled = [];
  const picked = [];
  const { host, cleanup } = mount(
    projectProps({
      onSelectProject: (id) => picked.push(id),
      onToggleGroup: (key) => toggled.push(key),
    })
  );

  click(host.querySelector(".thread-group-disclosure"));

  assert.deepEqual(toggled, ["proj-1"]);
  assert.deepEqual(picked, [], "folding must not yank the tab strip over");
  cleanup();
});

// --- select is ONLY the label / row -----------------------------------------

// The regression this whole split exists for: selecting an already-active
// project must leave it open, or you hide the sessions you were reaching for.
test("clicking a project label selects it and does NOT fold it", () => {
  const toggled = [];
  const picked = [];
  const { host, cleanup } = mount(
    projectProps({
      onSelectProject: (id) => picked.push(id),
      onToggleGroup: (key) => toggled.push(key),
    })
  );

  click(host.querySelector(".thread-group-name-button"));

  assert.deepEqual(picked, ["proj-1"]);
  assert.deepEqual(toggled, [], "selecting must never fold");
  cleanup();
});

test("clicking a project row's empty space selects it and does NOT fold it", () => {
  const toggled = [];
  const picked = [];
  const { host, cleanup } = mount(
    projectProps({
      onSelectProject: (id) => picked.push(id),
      onToggleGroup: (key) => toggled.push(key),
    })
  );

  click(host.querySelector(".thread-group-header-project"));

  assert.deepEqual(picked, ["proj-1"]);
  assert.deepEqual(toggled, []);
  cleanup();
});

test("clicking a cwd label selects the workspace and does NOT fold it", () => {
  const toggled = [];
  const selected = [];
  const { host, cleanup } = mount(
    cwdProps({
      onSelectWorkspace: (cwd) => selected.push(cwd),
      onToggleGroup: (cwd) => toggled.push(cwd),
    })
  );

  click(host.querySelector(".thread-group-name-button"));

  assert.deepEqual(selected, ["/tmp/work"]);
  assert.deepEqual(toggled, []);
  cleanup();
});

// The Unknown-workspace key is a display sentinel, never a real directory — it
// would be sent to the relay as a path. It must stay foldable but unselectable.
test("the unknown-workspace header folds but never leaks the sentinel as a cwd", () => {
  const toggled = [];
  const selected = [];
  const { host, cleanup } = mount(
    cwdProps({
      group: { cwd: "__unknown_workspace__", label: "Unknown workspace" },
      normalizedCwd: "__unknown_workspace__",
      onSelectWorkspace: (cwd) => selected.push(cwd),
      onToggleGroup: (cwd) => toggled.push(cwd),
    })
  );

  click(host.querySelector(".thread-group-disclosure"));
  const label = host.querySelector(".thread-group-name-button");
  if (label) {
    click(label);
  }

  assert.deepEqual(toggled, ["__unknown_workspace__"]);
  assert.deepEqual(selected, [], "the sentinel must never be handed out as a workspace path");
  cleanup();
});

// --- project actions stay inert ---------------------------------------------

test("project rename/delete buttons neither fold nor select", () => {
  const toggled = [];
  const picked = [];
  const renamed = [];
  const deleted = [];
  const { host, cleanup } = mount(
    projectProps({
      onDeleteProject: (id) => deleted.push(id),
      onRenameProject: (id) => renamed.push(id),
      onSelectProject: (id) => picked.push(id),
      onToggleGroup: (key) => toggled.push(key),
    })
  );

  const actions = host.querySelectorAll(".thread-group-action");
  click(actions[0]);
  click(actions[1]);

  assert.deepEqual(renamed, ["proj-1"]);
  assert.deepEqual(deleted, ["proj-1"]);
  assert.deepEqual(toggled, [], "acting on a project must not fold its sessions away");
  assert.deepEqual(picked, []);
  cleanup();
});

// --- badges -----------------------------------------------------------------

// The nested session rows ARE the count — restating it as "2 sessions" is noise
// that also crowds the disclosure off the right edge.
test("a project header shows no raw session-count badge", () => {
  const { host, cleanup } = mount(projectProps({ onToggleGroup: () => {} }));
  assert.doesNotMatch(host.innerHTML, /\bsessions?\b/i);
  cleanup();
});

// Working / needs-input are not counts-for-counting's-sake — they are the reason
// to look at a folded project at all, so they stay.
test("a project header keeps its working / needs-input badges", () => {
  const { host, cleanup } = mount(
    projectProps({
      group: { ...PROJECT_GROUP, summary: { working: 2, needsInput: 1, total: 5 } },
      onToggleGroup: () => {},
    })
  );

  assert.match(host.innerHTML, /2 working/);
  assert.match(host.innerHTML, /1 needs input/);
  cleanup();
});

// --- surfaces that never wired collapse -------------------------------------

test("a project header without a toggle handler shows no disclosure", () => {
  const { host, cleanup } = mount(projectProps({ collapsible: false }));
  assert.equal(host.querySelector(".thread-group-disclosure"), null);
  cleanup();
});

test("a cwd header without a toggle handler still selects its workspace", () => {
  const selected = [];
  const { host, cleanup } = mount(
    cwdProps({ collapsible: false, onSelectWorkspace: (cwd) => selected.push(cwd) })
  );

  assert.equal(host.querySelector(".thread-group-disclosure"), null);
  click(host.querySelector(".thread-group-header"));
  assert.deepEqual(selected, ["/tmp/work"]);
  cleanup();
});
