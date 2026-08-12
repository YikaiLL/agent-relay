// A group header's icon has to say WHICH KIND of group it heads.
//
// Both kinds shipped the same glyph: one CSS-drawn folder, emitted by all four
// branches of ThreadGroupHeader. So "UI Redesign" (a project) and "agent-relay"
// (a working directory) were indistinguishable in the sidebar — and the folder
// was the wrong metaphor for exactly one of them, because a project is
// deliberately NOT bound to a cwd (see the doc comment on `ProjectView` in
// crates/relay-server/src/protocol.rs).
//
// The discriminator is `group.projectId`, read ONCE at the top of the component
// rather than inferred from which branch the group lands in. That distinction is
// the point of the second test below: a pinned project group carries a
// projectId but no rename/delete handlers, so it falls through to the generic
// collapsible branch. Anything keyed on the branch — a CSS rule on
// `.thread-group-header-project`, say — gets that case wrong, and that case is
// the one on screen: the pinned project sits at the top of the tree in cwd mode,
// which is the only mode either surface ships today.
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

// The glyph's geometry, as the shape actually painted. Compared rather than the
// element's class or a data attribute: the bug was two headers agreeing on every
// attribute and differing in nothing a user could see, so the assertion has to
// reach the drawing itself.
function mark(host) {
  const slot = host.querySelector(".thread-group-icon");
  assert.ok(slot, "every header keeps its icon slot");
  const svg = slot.querySelector("svg");
  assert.ok(
    svg,
    "the icon slot must contain a real <svg> — a CSS-drawn glyph cannot differ per kind "
      + "without a per-kind hook, and the kinds are told apart in JS"
  );
  return [...svg.querySelectorAll("path, circle, rect")]
    .map((node) => node.getAttribute("d") ?? `circle:${node.getAttribute("cx")},${node.getAttribute("cy")}`)
    .join("|");
}

function render(group, extra = {}) {
  return mount({
    collapsible: true,
    group,
    isCollapsed: false,
    normalizedCwd: group.cwd || group.key,
    ...extra,
  });
}

const CWD_GROUP = { key: "/repos/relay", cwd: "/repos/relay", label: "relay", threads: [] };
const PROJECT_GROUP = {
  key: "proj_00000000000000ab",
  cwd: "",
  projectId: "proj_00000000000000ab",
  label: "UI Redesign",
  summary: { working: 0, needsInput: 0, total: 2 },
};

test("a project and a working directory do not render the same mark", () => {
  const project = render(PROJECT_GROUP, {
    onRenameProject: () => {},
    onDeleteProject: () => {},
  });
  const workspace = render(CWD_GROUP, { onSelectWorkspace: () => {} });

  try {
    assert.notEqual(
      mark(project.host),
      mark(workspace.host),
      "the sidebar shows both kinds side by side; one glyph for both makes them "
        + "indistinguishable, which is the whole defect"
    );
  } finally {
    project.cleanup();
    workspace.cleanup();
  }
});

// The reachable case, and the one a branch-keyed fix silently misses.
test("a pinned project keeps the project mark even without rename/delete handlers", () => {
  const pinned = render(
    { ...PROJECT_GROUP, pinned: true },
    { onSelectWorkspace: () => {} }
  );
  const project = render(PROJECT_GROUP, {
    onRenameProject: () => {},
    onDeleteProject: () => {},
  });

  try {
    assert.equal(
      mark(pinned.host),
      mark(project.host),
      "a project without action handlers falls through to the generic branch — it is "
        + "still a project, so the mark is chosen from group.projectId, not from the branch"
    );
  } finally {
    pinned.cleanup();
    project.cleanup();
  }
});

// The Unassigned bucket is `projectId: null` — it heads the threads that are in
// NO project, so it must not claim to be one.
test("the Unassigned bucket does not wear the project mark", () => {
  const unassigned = render(
    { key: "__unassigned__", cwd: "", projectId: null, label: "Unassigned", threads: [] },
    { onSelectWorkspace: () => {} }
  );
  const project = render(PROJECT_GROUP, {
    onRenameProject: () => {},
    onDeleteProject: () => {},
  });

  try {
    assert.notEqual(
      mark(unassigned.host),
      mark(project.host),
      "`projectId: null` is the absence of a project, not a project"
    );
  } finally {
    unassigned.cleanup();
    project.cleanup();
  }
});

// ThreadGroupHeader has FOUR render branches, and the mark has to survive all of
// them. The two non-collapsible ones are easy to forget: both shipped surfaces
// pass `collapsible: true`, so nothing on screen exercises them — but
// `ThreadGroupList` defaults the prop to false, and the Unknown-workspace group
// reaches the static branch through `thread-groups-unknown-workspace.test.mjs`.
//
// Forgetting one is not a no-op, it is a HOLE: the old glyph was drawn by CSS on
// the empty span, so a branch that still emitted the bare span kept its folder.
// The mark is a child element now, so the same branch renders 16px of nothing.
// That is exactly how this regressed the first time — a replace-all keyed on an
// indentation that three of the four branches happened to share.
test("every header branch renders the mark, collapsible or not", () => {
  const reference = render(CWD_GROUP, { onSelectWorkspace: () => {} });
  const expected = mark(reference.host);

  // Not collapsible, but selectable: the <button> branch.
  const selectable = render(CWD_GROUP, {
    collapsible: false,
    onSelectWorkspace: () => {},
    onToggleGroup: null,
  });
  // Not collapsible and not selectable: the static fallback. The Unknown-workspace
  // sentinel lands here even WITH an onSelectWorkspace handler, because its key is
  // a display sentinel rather than a path and must not become a workspace button.
  const staticFallback = render(
    { key: "__unknown_workspace__", cwd: "__unknown_workspace__", label: "Unknown workspace" },
    { collapsible: false, onSelectWorkspace: () => {}, onToggleGroup: null }
  );

  try {
    assert.equal(mark(selectable.host), expected, "the non-collapsible selectable branch");
    assert.equal(mark(staticFallback.host), expected, "the static fallback branch");
  } finally {
    reference.cleanup();
    selectable.cleanup();
    staticFallback.cleanup();
  }
});

// The state buckets ("Needs input") are not containers at all and drop the glyph
// via CSS. That contract predates this change and has to survive it.
test("a state bucket still declares its kind so CSS can drop the glyph", () => {
  const view = render(
    { key: "__state__needs_input", cwd: "", label: "Needs input", state: "needs_input", threads: [] },
    {}
  );
  try {
    assert.equal(view.host.querySelector(".thread-group-header")?.dataset.groupKind, "state");
  } finally {
    view.cleanup();
  }
});
