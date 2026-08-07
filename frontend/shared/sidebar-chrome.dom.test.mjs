// Focus behaviour for the shared search field, under jsdom.
//
// The static suite next door cannot see any of this: focus is not markup. And focus is
// exactly where migrating local's imperative field to a shared component lost behaviour —
// the old code called `focus()` and `select()` unconditionally from `setSearchOpen`, while
// React can only autofocus on MOUNT. Two regressions hid in that gap:
//
//   1. ⌘F with the field already open moved no caret, so the shortcut looked dead;
//   2. the clear button left focus on itself, so the next keystroke went nowhere.
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
const { SidebarSearchField } = await import("./sidebar-chrome.js");

const h = React.createElement;

function mount(props) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const view = {
    render(next) {
      act(() => {
        root.render(h(SidebarSearchField, next));
      });
    },
    get input() {
      return host.querySelector(".sidebar-search-input");
    },
    get clear() {
      return host.querySelector(".sidebar-search-clear");
    },
    // A SHORT label for whatever holds focus, never the element itself. `assert.equal` on
    // two jsdom nodes tries to stringify entire DOM subtrees to build its diff: it takes
    // ~45s and buries the real message. Same trap as the nav's reuse test.
    get focused() {
      const el = dom.window.document.activeElement;
      if (!el || el === dom.window.document.body) return "body";
      return el.getAttribute("class") || el.tagName;
    },
  };
  view.render(props);
  return view;
}

// A place to move focus AWAY to, so "the field has focus" is a real observation rather
// than a restatement of "nothing else does".
const INPUT = "sidebar-search-input";
const CLEAR = "sidebar-search-clear";
const COMPOSER = "TEXTAREA";

function elsewhere() {
  const composer = dom.window.document.createElement("textarea");
  dom.window.document.body.appendChild(composer);
  composer.focus();
  return composer;
}

test("the field takes focus on open when the surface asks for it", () => {
  const view = mount({ open: true, query: "", focusOnOpen: true, focusSignal: 1 });
  assert.equal(view.focused, INPUT, "local reveals the field from ⌘F, so focusing IS the point");
});

// Remote deliberately does not: on a phone, focusing pops the on-screen keyboard over the
// very list the user just asked to search.
test("the field does NOT take focus when the surface does not ask", () => {
  elsewhere();
  const view = mount({ open: true, query: "", focusSignal: 1 });
  assert.equal(view.focused, COMPOSER, "no focusOnOpen, no stolen caret");
});

// THE ⌘F REGRESSION. The field is already open and the caret is somewhere else, so `open`
// does not change and React has no mount to autofocus on. Only the bumped signal can carry
// the request.
test("a repeat focus request re-focuses an already-open field", () => {
  const view = mount({ open: true, query: "par", focusOnOpen: true, focusSignal: 1 });
  elsewhere();
  assert.equal(view.focused, COMPOSER, "positive control: focus really did leave the field");

  view.render({ open: true, query: "par", focusOnOpen: true, focusSignal: 2 });

  assert.equal(view.focused, INPUT, "⌘F on an open field must still put the caret in it");
});

// Re-rendering for any OTHER reason must not yank the caret back — that would fight the
// user every time the list refreshed underneath them.
test("a re-render with an unchanged signal leaves focus alone", () => {
  const view = mount({ open: true, query: "p", focusOnOpen: true, focusSignal: 1 });
  elsewhere();

  view.render({ open: true, query: "pa", focusOnOpen: true, focusSignal: 1 });

  assert.equal(view.focused, COMPOSER, "typing elsewhere, or a list refresh, must not steal focus");
});

// Selecting on focus is what made the old field replaceable in one keystroke. Closing
// clears the draft, so a freshly opened field is empty and there is nothing to select —
// but a repeat ⌘F onto a field with a term in it should offer to replace it.
test("focusing an open field with a term selects it, so the next keystroke replaces", () => {
  const view = mount({ open: true, query: "parser", focusOnOpen: true, focusSignal: 1 });
  elsewhere();

  view.render({ open: true, query: "parser", focusOnOpen: true, focusSignal: 2 });

  assert.equal(view.focused, INPUT);
  assert.equal(view.input.selectionStart, 0);
  assert.equal(view.input.selectionEnd, "parser".length, "the whole term is selected");
});

// THE CLEAR-BUTTON REGRESSION. Clicking a button focuses the button, so without an
// explicit hand-back the user's next keystroke lands nowhere. The old local code called
// `sidebarSearchInput.focus()` here; the comment claiming the field stays focused was
// carried over while the call was not.
test("clearing hands focus back to the input, not the clear button", () => {
  const cleared = [];
  const view = mount({
    open: true,
    query: "parser",
    focusOnOpen: true,
    focusSignal: 1,
    onInput: (value) => cleared.push(value),
  });

  // Focus the button the way a real click does before dispatching.
  view.clear.focus();
  assert.equal(view.focused, CLEAR, "positive control: the button really took focus");
  act(() => {
    view.clear.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

  assert.deepEqual(cleared, [""], "it still clears the query");
  assert.equal(view.focused, INPUT, "the user is still searching — give the caret back");
});

// The clear case above uses a pure collector for `onInput`, which is NOT local's shape.
// Local's `onSearchInput` writes the draft to the store and then calls
// `renderSidebarChrome()`, which re-renders this component through `flushSync` — so on the
// real path the tree is rebuilt SYNCHRONOUSLY inside the click handler, before the
// `inputRef.current?.focus()` line runs.
//
// That only works because React reconciles the input in place and keeps the ref pointing at
// the live node. If `renderReactContent` ever became something that recreates nodes (a new
// root per call, a keyed remount), the ref would be stale or null and focus would land
// nowhere — silently, with the collector-based test above still passing.
test("clearing still returns focus when onInput re-renders synchronously first", () => {
  const seen = [];
  let view;
  const onInput = (value) => {
    seen.push(value);
    // Local's flushSync repaint, mid-handler.
    view.render({ open: true, query: value, focusOnOpen: true, focusSignal: 1, onInput });
  };
  view = mount({ open: true, query: "parser", focusOnOpen: true, focusSignal: 1, onInput });

  view.clear.focus();
  assert.equal(view.focused, CLEAR, "positive control: the button held focus first");
  act(() => {
    view.clear.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

  assert.deepEqual(seen, [""], "the clear still reached the caller");
  assert.equal(view.input.value, "", "and the re-render applied it");
  assert.equal(
    view.focused,
    INPUT,
    "a synchronous re-render between the click and the focus() must not orphan the ref"
  );
});
