// The New session dialog's behaviour contract.
//
// Replaces start-session-dialog.test.mjs, which asserted on the previous
// markup — a `<datalist>`, four native `<select>`s, and the unprefixed element
// ids local's submit path used to read. All three are gone by design: the
// workspace is a combobox (a `<datalist>` option cannot carry a git chip), the
// settings are pills (an `<option>` cannot carry a "default" tag or a provider
// heading), and local no longer reads the DOM at submit time.
//
// The invariants that survived the redesign are re-pinned here, plus the ones
// the redesign introduced. jsdom rather than SSR because the menus are now
// interactive: their contents do not exist until opened.
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
const { StartSessionDialog } = await import("./shared/start-session-dialog.js");

const PROVIDERS = ["claude_code", "codex"];
const PROVIDER_MODELS = {
  claude_code: [
    { model: "claude-opus-4-6", display_name: "Opus 4.6", is_default: true },
    { model: "claude-sonnet-4-5", display_name: "Sonnet 4.5" },
  ],
  codex: [{ model: "gpt-5.5", display_name: "GPT-5.5", is_default: true }],
};
const APPROVALS = [
  { value: "untrusted", label: "Ask first" },
  { value: "never", label: "Full access", tag: "YOLO" },
];
const EFFORTS = [
  { value: "medium", label: "Medium" },
  { value: "xhigh", label: "Extra high" },
];

function baseFields(overrides = {}) {
  return {
    approvalPolicy: "never",
    cwd: "/Users/luchi/git/agent-relay",
    effort: "xhigh",
    initialPrompt: "",
    model: "claude-opus-4-6",
    projectId: null,
    provider: "claude_code",
    ...overrides,
  };
}

function mount(props = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes = [];
  const modelSelections = [];
  const render = (extra = {}) => {
    act(() => {
      root.render(
        React.createElement(StartSessionDialog, {
          approvalOptions: APPROVALS,
          effortOptions: EFFORTS,
          fields: baseFields(),
          id: "test-dialog",
          onFieldChange: (field, value) => changes.push([field, value]),
          onSelectModel: (selection) => modelSelections.push(selection),
          providerModels: PROVIDER_MODELS,
          providers: PROVIDERS,
          ...props,
          ...extra,
        })
      );
    });
  };
  render();
  return {
    changes,
    modelSelections,
    host,
    render,
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const click = (node) =>
  act(() => {
    node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

// React stores the last value it wrote on the DOM node and compares against it
// to decide whether an input event is a real change. Assigning `.value` directly
// updates the node but not React's record, so the event is swallowed and the
// component never sees the edit. Writing through the prototype's setter is the
// supported way to simulate typing.
function type(node, value) {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value"
  ).set;
  act(() => {
    setter.call(node, value);
    node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

const pill = (host, name) => host.querySelector(`#test-dialog-${name}`);
const openPill = (host, name) => click(pill(host, name));
const pillOptions = (host) =>
  [...host.querySelectorAll(".setting-pill-option")].map(
    (node) => node.querySelector(".setting-pill-option-label").textContent
  );

test("the model pill names provider and model together", () => {
  const view = mount();
  assert.match(pill(view.host, "model").textContent, /Claude · Opus 4\.6/);
  view.cleanup();
});

test("the model menu groups every provider's models under a heading", () => {
  // The merged control's whole justification: one menu, two levels, so choosing
  // a model is one act instead of two.
  const view = mount();
  openPill(view.host, "model");

  assert.deepEqual(
    [...view.host.querySelectorAll(".setting-pill-section-heading")].map(
      (node) => node.textContent
    ),
    ["Claude", "Codex"]
  );
  assert.deepEqual(pillOptions(view.host), ["Opus 4.6", "Sonnet 4.5", "GPT-5.5"]);
  view.cleanup();
});

test("choosing a model reports the provider WITH it, in one selection", () => {
  // The invariant that replaces the old provider→model cascade, and the reason
  // this is its own callback rather than two onFieldChange calls: effort levels
  // are per-model, so the host has to resolve provider, model and effort
  // together. Two sequential field changes cannot be — the second reads
  // catalogues from the render before the first.
  const view = mount();
  openPill(view.host, "model");
  click(
    [...view.host.querySelectorAll(".setting-pill-option")].find(
      (node) => node.querySelector(".setting-pill-option-label").textContent === "GPT-5.5"
    )
  );

  assert.deepEqual(view.modelSelections, [{ model: "gpt-5.5", provider: "codex" }]);
  assert.deepEqual(view.changes, [], "and NOT as loose field changes");
  view.cleanup();
});

test("a same-provider model still names its provider, so the pair is never partial", () => {
  const view = mount();
  openPill(view.host, "model");
  click(
    [...view.host.querySelectorAll(".setting-pill-option")].find(
      (node) => node.querySelector(".setting-pill-option-label").textContent === "Sonnet 4.5"
    )
  );

  assert.deepEqual(view.modelSelections, [
    { model: "claude-sonnet-4-5", provider: "claude_code" },
  ]);
  view.cleanup();
});

test("the permissions pill carries the selected option's tag", () => {
  const view = mount();
  assert.match(pill(view.host, "approval").textContent, /Full access/);
  assert.match(pill(view.host, "approval").textContent, /YOLO/);
  view.cleanup();
});

test("the workspace chip shows the path, abbreviated, and the git state", () => {
  const view = mount({ gitContext: { is_repo: true, branch: "main", dirty: false } });
  const trigger = view.host.querySelector(".workspace-picker-trigger");

  assert.match(trigger.textContent, /~\/git\/agent-relay/);
  assert.match(trigger.textContent, /main · clean/);
  view.cleanup();
});

test("a workspace that is not a repo shows no git chip rather than an empty one", () => {
  const view = mount({ gitContext: { is_repo: false } });
  assert.equal(view.host.querySelector(".workspace-picker-git"), null);
  view.cleanup();
});

test("a typed workspace path is reported on Enter", () => {
  // The combobox exists precisely so a directory the relay has never seen can
  // still be launched into. Losing free text would be a capability regression
  // over the `<datalist>` it replaced.
  const view = mount();
  click(view.host.querySelector(".workspace-picker-trigger"));
  const input = view.host.querySelector(".workspace-picker-input");
  type(input, "/tmp/brand-new");
  act(() => {
    input.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })
    );
  });

  assert.deepEqual(view.changes, [["cwd", "/tmp/brand-new"]]);
  view.cleanup();
});

test("the project chip defaults to the project the dialog was given", () => {
  const view = mount({
    fields: baseFields({ projectId: "proj_1" }),
    projects: [{ id: "proj_1", name: "Small improvement" }],
  });

  assert.match(view.host.querySelector(".project-picker-trigger").textContent, /Small improvement/);
  view.cleanup();
});

test("choosing a project reports it as a field, like every other setting", () => {
  const view = mount({ projects: [{ id: "proj_1", name: "Small improvement" }] });
  click(view.host.querySelector(".project-picker-trigger"));
  click(
    [...view.host.querySelectorAll(".project-switcher-option")].find(
      (node) =>
        node.querySelector(".project-switcher-option-label")?.textContent ===
        "Small improvement"
    )
  );

  assert.deepEqual(view.changes, [["projectId", "proj_1"]]);
  view.cleanup();
});

test("requireInitialPrompt gates Claude, and both hosts opt out of it", () => {
  // The relay supports DEFERRED start: a Claude session with no initial prompt is
  // promoted on the first composer message. Both surfaces therefore pass
  // requireInitialPrompt: false, and local not doing so was a regression that
  // disabled Start for an empty Claude prompt on one surface only.
  const optedOut = mount({ requireInitialPrompt: false });
  assert.equal(
    optedOut.host.querySelector("#test-dialog-start").disabled,
    false,
    "an idle Claude session is startable when the host opts out"
  );
  optedOut.cleanup();

  const view = mount({ requireInitialPrompt: true });
  assert.equal(view.host.querySelector("#test-dialog-start").disabled, true);

  view.render({ fields: baseFields({ initialPrompt: "ship it" }) });
  assert.equal(view.host.querySelector("#test-dialog-start").disabled, false);

  view.render({ fields: baseFields({ provider: "codex", model: "gpt-5.5" }) });
  assert.equal(
    view.host.querySelector("#test-dialog-start").disabled,
    false,
    "codex starts idle happily"
  );
  view.cleanup();
});

test("an empty workspace blocks the start", () => {
  const view = mount({ fields: baseFields({ cwd: "   ", initialPrompt: "go" }) });
  assert.equal(view.host.querySelector("#test-dialog-start").disabled, true);
  view.cleanup();
});

test("Start closes the dialog BEFORE invoking onStart", () => {
  // Survives from the old suite. The host's start is async and re-renders the
  // surface underneath; closing afterwards left the dialog visibly hanging over
  // a session that had already begun.
  const order = [];
  const view = mount({
    fields: baseFields({ initialPrompt: "go" }),
    onStart: () => order.push("onStart"),
  });
  const dialog = view.host.querySelector("dialog");
  dialog.close = () => order.push("close");

  click(view.host.querySelector("#test-dialog-start"));

  assert.deepEqual(order, ["close", "onStart"]);
  view.cleanup();
});

test("Cmd+Enter in the prompt submits, plain Enter does not", () => {
  // The footer advertises ⌘↵, so it has to work from where the user is typing.
  // Plain Enter must stay a newline: these are multi-line task descriptions.
  const started = [];
  const view = mount({
    fields: baseFields({ initialPrompt: "go" }),
    onStart: () => started.push(true),
  });
  const prompt = view.host.querySelector("#test-dialog-start-prompt");
  view.host.querySelector("dialog").close = () => {};

  act(() => {
    prompt.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })
    );
  });
  assert.deepEqual(started, [], "plain Enter is a newline");

  act(() => {
    prompt.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        metaKey: true,
      })
    );
  });
  assert.deepEqual(started, [true]);
  view.cleanup();
});

test("the attachment mount is opt-in, so remote does not advertise pasting it cannot do", () => {
  // Survives from the old suite: a paired device cannot send image bytes at all,
  // so the placeholder must not invite a paste there.
  const withMount = mount({ initialPromptAttachmentsId: "start-prompt-attachments" });
  assert.ok(withMount.host.querySelector("#start-prompt-attachments"));
  assert.match(
    withMount.host.querySelector("#test-dialog-start-prompt").placeholder,
    /Paste an image/
  );
  withMount.cleanup();

  const without = mount();
  assert.equal(without.host.querySelector("#start-prompt-attachments"), null);
  assert.doesNotMatch(
    without.host.querySelector("#test-dialog-start-prompt").placeholder,
    /Paste an image/
  );
  without.cleanup();
});

test("the footer names the directory the session will actually run in", () => {
  // Not "a fresh worktree": start_session runs in the given cwd and provisions
  // nothing. Only Task-team runs get a worktree.
  const view = mount();
  assert.match(
    view.host.querySelector(".session-dialog-hint").textContent,
    /Runs in ~\/git\/agent-relay/
  );
  view.cleanup();
});
