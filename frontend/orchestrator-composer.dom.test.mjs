// The Orchestrator composer, driven through a real DOM.
//
// It was written standalone rather than on `ConversationComposer`, so every
// keyboard policy the shared composer had already settled — IME, mobile Enter,
// Home/End — was absent here and had to be rediscovered by a user typing
// Chinese into it. These tests pin the behaviour, not the wiring, so the
// composer stays free to be rebuilt on the shared one (which is the point).
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
const { TaskTeamScreen } = await import("./shared/task-team-react.js");

function mount(orchestrator = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const sent = [];
  act(() => {
    root.render(
      React.createElement(TaskTeamScreen, {
        runs: [],
        loading: false,
        locked: false,
        orchestrator: {
          entries: [],
          loading: false,
          composerDisabled: false,
          composerBusy: false,
          composerError: null,
          proposals: [],
          onSend: (text) => sent.push(text),
          ...orchestrator,
        },
      })
    );
  });
  const textarea = host.querySelector("textarea");
  assert.ok(textarea, "the Orchestrator composer must render a textarea");
  return { host, root, sent, textarea };
}

function type(textarea, value) {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLTextAreaElement.prototype,
    "value"
  ).set;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

function pressEnter(textarea, init = {}) {
  act(() => {
    textarea.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...init,
      })
    );
  });
}

// The bug this pins: typing Chinese means pressing Enter to CHOOSE a candidate.
// The composer treated that Enter as Send, so the half-typed pinyin buffer went
// to the Orchestrator and the sentence was never finished. The shared composer
// has bailed on `isComposing` since it was written (composer-keys.js) — this
// one just never asked.
test("Enter that confirms an IME candidate does not send", () => {
  const { sent, textarea } = mount();

  type(textarea, "帮我看一下");
  pressEnter(textarea, { isComposing: true });

  assert.deepEqual(sent, [], "an Enter mid-composition belongs to the IME, not to Send");
});

// Some IMEs/browsers report the composition only as the legacy keyCode.
test("Enter reported as keyCode 229 does not send either", () => {
  const { sent, textarea } = mount();

  type(textarea, "帮我看一下");
  pressEnter(textarea, { keyCode: 229 });

  assert.deepEqual(sent, [], "keyCode 229 is a composition keydown");
});

test("a plain Enter still sends", () => {
  const { sent, textarea } = mount();

  type(textarea, "ship it");
  pressEnter(textarea);

  assert.deepEqual(sent, ["ship it"]);
});

test("Shift+Enter is a newline, not a send", () => {
  const { sent, textarea } = mount();

  type(textarea, "line one");
  pressEnter(textarea, { shiftKey: true });

  assert.deepEqual(sent, []);
});
