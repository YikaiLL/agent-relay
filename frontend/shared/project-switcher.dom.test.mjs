// The Project switcher's behaviour contract.
//
// The switcher is navigation, not filtering: every selection leaves the session
// list complete, so the default workspace is a real destination rather than a way
// out of a narrowed state. These tests pin the parts that are easy to get subtly wrong —
// a stale selection, and Escape.
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
const { ProjectSwitcher } = await import("./project-switcher.js");
const { DEFAULT_WORKSPACE_LABEL } = await import("./project-labels.js");

const PROJECTS = [
  { id: "proj_pay", name: "Payments rework" },
  { id: "proj_docs", name: "Docs" },
];

function mount(props = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(React.createElement(ProjectSwitcher, { projects: PROJECTS, ...props }));
  });
  return {
    host,
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
    rerender(next) {
      act(() => {
        root.render(
          React.createElement(ProjectSwitcher, { projects: PROJECTS, ...props, ...next })
        );
      });
    },
  };
}

function trigger(host) {
  return host.querySelector(".project-switcher-trigger");
}

function options(host) {
  return [...host.querySelectorAll(".project-switcher-option")].map((node) => node.textContent);
}

function clickOption(host, label) {
  const node = [...host.querySelectorAll(".project-switcher-option")].find(
    (candidate) => candidate.textContent === label
  );
  assert.ok(node, `no option labelled "${label}"`);
  act(() => {
    node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

function open(host) {
  act(() => {
    trigger(host).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

test("with nothing selected it reads as the default workspace", () => {
  const view = mount({ activeProjectId: null });
  assert.equal(trigger(view.host).textContent, DEFAULT_WORKSPACE_LABEL);
  view.cleanup();
});

test("with a project selected it names the project", () => {
  const view = mount({ activeProjectId: "proj_pay" });
  assert.equal(trigger(view.host).textContent, "Payments rework");
  view.cleanup();
});

// A project can be deleted from another device while it is the selected one. The
// grouper independently falls back to plain cwd grouping for an id it cannot
// resolve, so the control has to reach the same answer or the header would name a
// project the list is no longer showing.
test("a selection whose project is gone falls back to the default workspace, not a dangling name", () => {
  const view = mount({ activeProjectId: "proj_deleted" });
  assert.equal(trigger(view.host).textContent, DEFAULT_WORKSPACE_LABEL);
  view.cleanup();
});

test("the menu lists the default workspace, every project, and the create action", () => {
  const view = mount({ activeProjectId: null, onCreateProject() {} });
  open(view.host);
  assert.deepEqual(options(view.host), [
    DEFAULT_WORKSPACE_LABEL,
    "Payments rework",
    "Docs",
    "New project",
  ]);
  view.cleanup();
});

test("without a create handler the create action is absent rather than inert", () => {
  const view = mount({ activeProjectId: null });
  open(view.host);
  assert.equal(options(view.host).includes("New project"), false);
  view.cleanup();
});

test("choosing a project reports its id and closes the menu", () => {
  const chosen = [];
  const view = mount({ activeProjectId: null, onSelectProject: (id) => chosen.push(id) });
  open(view.host);
  clickOption(view.host, "Docs");

  assert.deepEqual(chosen, ["proj_docs"]);
  assert.equal(view.host.querySelector(".project-switcher-menu"), null);
  view.cleanup();
});

// Null, not the string "sessions" or an empty string: the caller maps it to the
// sessions context, and a falsy-but-not-null id would read as "some project" to a
// truthiness check downstream.
test("choosing the default workspace reports null", () => {
  const chosen = [];
  const view = mount({ activeProjectId: "proj_pay", onSelectProject: (id) => chosen.push(id) });
  open(view.host);
  clickOption(view.host, DEFAULT_WORKSPACE_LABEL);

  assert.deepEqual(chosen, [null]);
  view.cleanup();
});

test("the current selection is marked so the menu says where you already are", () => {
  const view = mount({ activeProjectId: "proj_docs" });
  open(view.host);
  const active = view.host.querySelector(".project-switcher-option.is-active");
  assert.equal(active?.textContent, "Docs");
  view.cleanup();
});

test("clicking outside closes the menu", () => {
  const view = mount({ activeProjectId: null });
  open(view.host);
  assert.ok(view.host.querySelector(".project-switcher-menu"));

  act(() => {
    document.body.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
  });
  assert.equal(view.host.querySelector(".project-switcher-menu"), null);
  view.cleanup();
});

// The sidebar search reads a bare Escape as "close AND clear the query". If this
// menu let Escape through, dismissing it would silently wipe a search the user
// never touched — the exact trap that wrecked two verification runs on the search
// work.
test("Escape closes the menu without letting the key reach the surface behind it", () => {
  const seenByDocument = [];
  const listener = (event) => seenByDocument.push(event.key);
  document.addEventListener("keydown", listener);

  const view = mount({ activeProjectId: null });
  open(view.host);
  act(() => {
    document.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
  });

  assert.equal(view.host.querySelector(".project-switcher-menu"), null, "menu should close");
  assert.deepEqual(seenByDocument, [], "Escape must not reach a bubble-phase listener");

  document.removeEventListener("keydown", listener);
  view.cleanup();
});

test("an empty project list still offers the default workspace and creating one", () => {
  const view = mount({ activeProjectId: null, onCreateProject() {}, projects: [] });
  open(view.host);
  assert.deepEqual(options(view.host), [DEFAULT_WORKSPACE_LABEL, "New project"]);
  view.cleanup();
});
