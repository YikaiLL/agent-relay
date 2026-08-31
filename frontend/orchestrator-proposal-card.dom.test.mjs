// What the confirm button actually authorises.
//
// The backend resolves a provider/model/effort per seat, stores it on the
// proposal, and starts exactly that on confirm. The card showed only the team
// name, title and why — so a proposal could put every seat on `max` effort, or
// move one to another provider, and the user clicking "Start task" had nothing
// on screen to object to. These pin that the choice is visible before the click.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { OrchestratorPane } = await import("./shared/task-team-react.js");

function renderPane(proposals) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      React.createElement(OrchestratorPane, {
        runs: [],
        proposals,
        onStartTask: () => {},
        onOpenThread: () => {},
      }),
    );
  });
  return host;
}

const PROPOSAL = {
  id: "orch_prop_1",
  kind: "start_task",
  title: "Add a parser",
  team_name: "Default",
  agents: {
    tl: { provider: "codex", model: "gpt-5.6-codex" },
    dev: { provider: "codex", model: "gpt-5.6-codex" },
    reviewer: { provider: "claude_code", model: "claude-opus-5", effort: "max" },
  },
};

test("the card names the agent each seat will run on", () => {
  const host = renderPane([PROPOSAL]);
  const text = host.textContent;
  assert.match(text, /claude-opus-5/, "the reviewer's model must be visible before Start");
  assert.match(text, /max/, "an expensive effort must be visible before Start");
  assert.match(text, /gpt-5\.6-codex/, "the other seats' model too");
  assert.match(text, /Reviewer/, "each choice must say which seat it belongs to");
});

test("a proposal that pins nothing adds no agent row", () => {
  // Absent must not render as "default": the relay's default can move, and the
  // card would be claiming a guarantee the proposal does not carry.
  const host = renderPane([{ ...PROPOSAL, agents: {} }]);
  assert.equal(host.querySelectorAll(".task-orch-proposal-agent").length, 0);
});

test("a seat that pins only an effort shows just that", () => {
  const host = renderPane([
    { ...PROPOSAL, agents: { reviewer: { effort: "max" } } },
  ]);
  const rows = [...host.querySelectorAll(".task-orch-proposal-agent")];
  assert.equal(rows.length, 1, "only the seat that named something");
  assert.match(rows[0].textContent, /Reviewer/);
  assert.match(rows[0].textContent, /max/);
});
