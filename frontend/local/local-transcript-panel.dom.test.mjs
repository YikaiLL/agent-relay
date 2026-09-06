// LocalTranscriptPanel owns the six branches renderTranscript used to pick
// imperatively (render-session.js) plus the transcript history loader's
// attach/sync/detach lifecycle. This drives the REAL component through jsdom
// (not a source-text slice) so the branch dispatch, the layout-effect order,
// and the loader's real IntersectionObserver wiring are all exercised as they
// actually run.
//
// Kept in its own file so the DOM globals below don't leak into the static
// suite (mirrors use-transcript-scroll-bookkeeping.dom.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

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
const { LocalTranscriptPanel } = await import("./local-transcript-panel.js");

const h = React.createElement;

// Counts construct/disconnect so "exactly one live observer" can be asserted
// against the real attachTranscriptHistoryLoader path, not a mock of it.
// Also keeps each instance (with its captured callback) so a test can fire a
// real intersection and drive the loader's own state machine instead of
// calling attachTranscriptHistoryLoader's internals directly.
function installFakeIntersectionObserver() {
  const counts = { constructs: 0, disconnects: 0 };
  const instances = [];
  class FakeIntersectionObserver {
    constructor(callback) {
      counts.constructs += 1;
      this.callback = callback;
      instances.push(this);
    }
    observe() {}
    disconnect() {
      counts.disconnects += 1;
    }
    unobserve() {}
  }
  global.IntersectionObserver = FakeIntersectionObserver;
  return { counts, instances };
}

// createTranscriptHistoryLoader's promise chain (scheduleBurst -> runPrefetchBurst
// -> await onLoad()) is a handful of microtask hops deep; chaining .then()s (rather
// than a single await) waits out all of them without depending on their exact count.
function flushMicrotasks(times = 30) {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    chain = chain.then(() => {});
  }
  return chain;
}

function entriesFor(count) {
  return Array.from({ length: count }, (_, index) => ({
    item_id: `item-${index}`,
    kind: index === 0 ? "user_text" : "assistant_text",
    text: `line ${index}`,
  }));
}

function baseProps(overrides = {}) {
  return {
    activeThreadId: null,
    activeThreadLabel: "",
    approval: null,
    entries: [],
    entriesCanWrite: true,
    getStandbyEmptyContent: () => h("div", { className: "standby-empty-marker" }, "Standby"),
    getTranscriptOptions: () => ({}),
    hydrationLoading: false,
    onAfterTranscriptCommit: () => {},
    onLoadOlderTranscript: () => {},
    readyCopy: "The agent is connected.",
    requestedSessionLabel: "",
    scrollElement: null,
    session: { active_thread_id: null },
    shortId: (value) => (value ? String(value).slice(0, 8) : "unknown"),
    standbyCanWrite: true,
    viewOnly: false,
    viewOnlyReviewView: false,
    viewedThreadLocked: false,
    viewedThreadWorkflowLocked: false,
    viewingConversation: true,
    viewingDifferentThread: false,
    ...overrides,
  };
}

function mount() {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    render(overrides = {}) {
      act(() => root.render(h(LocalTranscriptPanel, baseProps({ scrollElement: host, ...overrides }))));
    },
    unmount() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test("branch 1: a review or Code Flow lock on the viewed thread shows its own copy", () => {
  const view = mount();
  try {
    view.render({ viewingConversation: false, viewedThreadLocked: true });
    assert.match(view.host.textContent, /Review in progress/);
    assert.match(view.host.textContent, /Another agent is reviewing this conversation/);

    view.render({
      viewingConversation: false,
      viewedThreadLocked: true,
      viewedThreadWorkflowLocked: true,
    });
    assert.match(view.host.textContent, /Code Flow in progress/);
  } finally {
    view.unmount();
  }
});

test("branch 2: viewing a different, not-yet-active thread shows Loading session with its label", () => {
  const view = mount();
  try {
    view.render({
      viewingConversation: false,
      viewingDifferentThread: true,
      requestedSessionLabel: "thread-abc",
    });
    assert.match(view.host.textContent, /Loading session/);
    assert.match(view.host.textContent, /Requested session: thread-abc/);
  } finally {
    view.unmount();
  }
});

test("branch 3: a live session running elsewhere shows Relay console home with its label", () => {
  const view = mount();
  try {
    view.render({
      viewingConversation: false,
      activeThreadId: "thread-live",
      activeThreadLabel: "Live Thread",
    });
    assert.match(view.host.textContent, /Relay console home/);
    assert.match(view.host.textContent, /Current session: Live Thread/);
  } finally {
    view.unmount();
  }
});

test("branch 4: a not-yet-loaded view-only thread shows a read-only or review placeholder", () => {
  const view = mount();
  try {
    view.render({ entries: [], viewOnly: true, viewOnlyReviewView: false });
    assert.match(view.host.textContent, /Read-only view/);

    view.render({ entries: [], viewOnly: true, viewOnlyReviewView: true });
    assert.match(view.host.textContent, /Review in progress/);
    assert.match(view.host.textContent, /Loading this session's conversation/);
  } finally {
    view.unmount();
  }
});

test("branch 5: empty + no approval renders the standby thunk only when there is no active thread", () => {
  const view = mount();
  let standbyCalls = 0;
  try {
    view.render({
      entries: [],
      approval: null,
      activeThreadId: null,
      getStandbyEmptyContent: () => {
        standbyCalls += 1;
        return h("div", { className: "standby-empty-marker" }, "Standby");
      },
    });
    assert.match(view.host.textContent, /Standby/);
    assert.equal(standbyCalls, 1);

    // With an active thread, branch 5 shows the ready/waiting copy instead,
    // and must NOT call the standby thunk.
    view.render({
      entries: [],
      approval: null,
      activeThreadId: "thread-1",
      readyCopy: "Ready copy marker",
      standbyCanWrite: true,
      getStandbyEmptyContent: () => {
        standbyCalls += 1;
        return h("div", null, "should not render");
      },
    });
    assert.match(view.host.textContent, /Ready copy marker/);
    assert.equal(standbyCalls, 1, "the standby thunk must not be called once there is an active thread");
  } finally {
    view.unmount();
  }
});

test("branch 6: entries render through TranscriptPane and call the transcript-options thunk", () => {
  const view = mount();
  let optionsCalls = 0;
  try {
    view.render({
      entries: entriesFor(2),
      getTranscriptOptions: () => {
        optionsCalls += 1;
        return {};
      },
    });
    assert.match(view.host.textContent, /line 0/);
    assert.match(view.host.textContent, /line 1/);
    assert.equal(optionsCalls, 1);
    assert.ok(
      view.host.querySelector("[data-transcript-history-sentinel]"),
      "the entries branch renders the real history sentinel"
    );
  } finally {
    view.unmount();
  }
});

test("branch 5 falls through to branch 6 when approval is truthy with zero entries", () => {
  const view = mount();
  try {
    view.render({ entries: [], approval: { summary: "Needs approval" } });
    assert.ok(
      view.host.querySelector("[data-transcript-history-sentinel]"),
      "an approval with zero entries must render through the entries path (with its sentinel), not the ready/standby state"
    );
  } finally {
    view.unmount();
  }
});

test("onAfterTranscriptCommit fires once per commit on branches 5/6, and never on branches 1-4", () => {
  const view = mount();
  const commits = [];
  const onAfterTranscriptCommit = (scrollElement) => commits.push(scrollElement);
  try {
    view.render({ viewingConversation: false, viewedThreadLocked: true, onAfterTranscriptCommit });
    assert.equal(commits.length, 0, "branch 1 must not run scroll bookkeeping");

    view.render({
      viewingConversation: false,
      viewingDifferentThread: true,
      onAfterTranscriptCommit,
    });
    assert.equal(commits.length, 0, "branch 2 must not run scroll bookkeeping");

    view.render({
      viewingConversation: false,
      activeThreadId: "thread-live",
      onAfterTranscriptCommit,
    });
    assert.equal(commits.length, 0, "branch 3 must not run scroll bookkeeping");

    view.render({ entries: [], viewOnly: true, onAfterTranscriptCommit });
    assert.equal(commits.length, 0, "branch 4 must not run scroll bookkeeping");

    view.render({ entries: [], approval: null, onAfterTranscriptCommit });
    assert.equal(commits.length, 1, "branch 5 must run scroll bookkeeping exactly once for this commit");
    assert.equal(commits[0], view.host);

    view.render({ entries: entriesFor(1), onAfterTranscriptCommit });
    assert.equal(commits.length, 2, "branch 6 must run scroll bookkeeping exactly once for this commit");

    view.render({ entries: entriesFor(2), onAfterTranscriptCommit });
    assert.equal(
      commits.length,
      3,
      "a re-render that stays on branch 6 still counts as its own commit"
    );
  } finally {
    view.unmount();
  }
});

test("the history loader syncs to whichever sentinel is live, with exactly one observer alive across a branch swap, and detaches on unmount", () => {
  const { counts } = installFakeIntersectionObserver();
  const view = mount();
  try {
    view.render({ entries: entriesFor(2) });
    assert.equal(counts.constructs, 1, "the entries branch attaches one observer");
    assert.equal(counts.constructs - counts.disconnects, 1, "exactly one live observer");

    view.render({ viewingConversation: false, viewedThreadLocked: true });
    assert.equal(counts.disconnects, 1, "losing the sentinel must disconnect the old observer");
    assert.equal(counts.constructs - counts.disconnects, 0, "no observer is left live without a sentinel");

    view.render({ entries: entriesFor(3) });
    assert.equal(counts.constructs, 2, "the sentinel reappearing attaches a fresh observer");
    assert.equal(counts.constructs - counts.disconnects, 1, "still exactly one live observer, never two");
  } finally {
    view.unmount();
    delete global.IntersectionObserver;
  }
  assert.equal(counts.disconnects, 2, "unmounting the panel detaches the loader");
});

test("sync() resumes a loader that backed off awaiting an external poke, on a same-branch re-render with no sentinel change", async () => {
  // The bug this guards: sync() only rebuilds the loader when the sentinel node
  // ITSELF changes. A commit that stays on branch 6 (same sentinel) still runs
  // sync() every time, but earlier coverage only ever exercised that call on an
  // unchanged, already-satisfied loader — never on one sitting in the real
  // "attach-transcript-history-loader.js" backoff state, so a `sync()` that quietly
  // stopped poking it would not have been caught.
  const { instances } = installFakeIntersectionObserver();
  const view = mount();
  const onLoadCalls = [];
  // Always "not definitive" (neither true nor false): the exact shape that makes
  // the real loader set awaitingExternalPoke and stop rescheduling itself.
  const onLoadOlderTranscript = () => {
    onLoadCalls.push(true);
    return Promise.resolve(undefined);
  };
  try {
    view.render({ entries: entriesFor(2), onLoadOlderTranscript });
    assert.equal(instances.length, 1, "the entries branch attaches one observer");

    // Drive the REAL loader's state machine: an intersection starts a burst.
    instances[0].callback([{ isIntersecting: true }]);
    await flushMicrotasks();
    assert.equal(onLoadCalls.length, 1, "the intersection triggers exactly one load attempt");

    // The loader is now backed off and will not fire again on its own. A
    // re-render that stays on branch 6 (same entries shape, same sentinel node)
    // must still call sync() — and sync()'s poke() must resume it.
    view.render({ entries: entriesFor(2), onLoadOlderTranscript });
    assert.equal(instances.length, 1, "the sentinel is unchanged, so sync() must not rebuild the observer");
    await flushMicrotasks();
    assert.equal(
      onLoadCalls.length,
      2,
      "sync() after a same-branch, same-sentinel commit must poke the backed-off loader back into loading"
    );
  } finally {
    view.unmount();
    delete global.IntersectionObserver;
  }
});
