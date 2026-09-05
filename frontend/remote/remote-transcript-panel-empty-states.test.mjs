// P1 regression: RemoteTranscriptPanel is deliberately rendered with
// sessionView === null for the no-session and relay-home empty states (see
// react-app.js:614, `sessionView = session ? ... : null`). Hoisting
// transcriptOptions construction out of the active-session branch (for
// stableTranscriptOptions, the React memo/identity sub-task) made it read
// `sessionView.canWrite` unconditionally, on every render — including these
// null-sessionView renders — so the empty states crash instead of drawing.
//
// react-app.js cannot be imported as a plain ES module under `node --test`:
// it transitively pulls in shared/build-badge.js, which reads
// import.meta.env.BASE_URL — a Vite-only global Node's loader never
// populates. Confirmed no other test in this repo imports it directly for
// exactly that reason (see transcript-options-identity.test.mjs). Rather
// than duplicate/stub the whole component's dependency graph the way that
// file's `new Function` extraction does for two pure helpers, this file
// registers a minimal module loader that redirects build-badge.js to an
// inert stub — letting the REAL react-app.js load with every other real
// dependency intact, so RemoteTranscriptPanel itself (exported for exactly
// this purpose) can be mounted and actually rendered under jsdom.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { JSDOM } from "jsdom";

register(
  `data:text/javascript,
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.endsWith("/shared/build-badge.js")) {
        return { url: "build-badge-stub:main", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
    export async function load(url, context, nextLoad) {
      if (url === "build-badge-stub:main") {
        return {
          format: "module",
          shortCircuit: true,
          source: "export async function fetchBuildInfo() { return { label: '', title: '' }; }\\nexport async function mountBuildBadge() {}",
        };
      }
      return nextLoad(url, context);
    }
  `,
  import.meta.url
);

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.CustomEvent = dom.window.CustomEvent;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RemoteTranscriptPanel } = await import("./react-app.js");

const h = React.createElement;

function baseProps(overrides = {}) {
  return {
    currentState: {},
    emptyStateModel: { showRelayHome: false, showServerDisconnected: false },
    onApplyFileChange: () => {},
    onForkFromMessage: () => {},
    onSelectRelay: () => {},
    onToggleExpandableBlock: () => {},
    onSubmitDecision: () => {},
    onSubmitAskUserAnswers: () => {},
    onToggleTranscriptItem: () => {},
    onEnsureFileChangeDetail: () => {},
    pendingAskUserQuestions: [],
    session: null,
    sessionView: null,
    transcriptDetailEntries: new Map(),
    askUserDetailErrors: new Map(),
    askUserDetailLoadingRequestIds: new Set(),
    uiState: {
      transcriptExpandedItemIds: new Set(),
      transcriptLoadingItemIds: new Set(),
      askUserSubmittingRequestId: "",
      askUserErrors: new Map(),
    },
    ...overrides,
  };
}

function mount(props) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let caught = null;
  act(() => {
    try {
      root.render(h(RemoteTranscriptPanel, props));
    } catch (error) {
      caught = error;
    }
  });
  return { caught, host, root };
}

test("the no-session empty state renders with sessionView === null instead of crashing on sessionView.canWrite", () => {
  const { caught, host, root } = mount(
    baseProps({
      emptyStateModel: {
        showRelayHome: false,
        showServerDisconnected: false,
      },
    })
  );

  assert.equal(caught, null, `must not throw: ${caught?.message}`);
  assert.match(host.textContent, /No remote session yet/);

  act(() => root.unmount());
  host.remove();
});

test("the relay-home empty state renders with sessionView === null instead of crashing on sessionView.canWrite", () => {
  const { caught, host, root } = mount(
    baseProps({
      emptyStateModel: {
        showRelayHome: true,
        clientAuth: {},
        relayDirectory: [],
      },
    })
  );

  assert.equal(caught, null, `must not throw: ${caught?.message}`);

  act(() => root.unmount());
  host.remove();
});

test("the server-disconnected empty state renders with sessionView === null instead of crashing on sessionView.canWrite", () => {
  const { caught, host, root } = mount(
    baseProps({
      emptyStateModel: {
        showServerDisconnected: true,
        serverDisconnectedCopy: "The server disconnected.",
      },
    })
  );

  assert.equal(caught, null, `must not throw: ${caught?.message}`);
  assert.match(host.textContent, /The server disconnected\./);

  act(() => root.unmount());
  host.remove();
});

test("an active session still renders the transcript pane (sessionView non-null path unaffected)", () => {
  const { caught, host, root } = mount(
    baseProps({
      session: {
        active_thread_id: "thread-1",
        transcript: [],
        provider: "claude",
      },
      sessionView: {
        approval: null,
        canCompose: true,
        canWrite: true,
      },
    })
  );

  assert.equal(caught, null, `must not throw: ${caught?.message}`);

  act(() => root.unmount());
  host.remove();
});
