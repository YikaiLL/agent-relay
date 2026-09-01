import assert from "node:assert/strict";
import test from "node:test";

import { createStreamController } from "./session/stream.js";
import { createViewOnlyRefreshOps } from "./view-only-refresh-ops.js";

const LIVE_THREAD = "thread-live";
const BG_THREAD = "thread-bg";

function session({ threadActivity = [] } = {}) {
  return {
    active_thread_id: LIVE_THREAD,
    transcript: [],
    transcript_revision: 1,
    thread_activity: threadActivity,
  };
}

function createHarness() {
  const state = {
    session: session(),
    viewThreadId: BG_THREAD,
    viewOnlyThread: null,
    viewOnlyGeneration: 0,
  };
  const loads = [];
  let pendingResolve = null;
  let pendingTerminal = false;

  const ops = createViewOnlyRefreshOps({
    getState: () => state,
    fetchTranscriptPage: async (threadId) => {
      const load = { threadId, terminal: pendingTerminal };
      loads.push(load);
      pendingTerminal = false;
      return new Promise((resolve) => {
        pendingResolve = (page) => {
          pendingResolve = null;
          resolve(
            page ?? {
              thread_id: threadId,
              entries: [{ item_id: "item-1", kind: "agent_text", text: "Hello", status: "done" }],
              prev_cursor: null,
            }
          );
        };
        load.resolve = pendingResolve;
      });
    },
    renderSession: (nextSession) => {
      state.session = nextSession;
      ops.maybeRefreshViewOnly(nextSession);
    },
    logLine: () => {},
    findVisible: () => null,
    reviewSignature: () => null,
    syncWatchedThreads: () => {},
    getOrchestratorWatchIds: () => [],
    isReviewInProgressForThread: () => false,
    isWorkflowInProgressForThread: () => false,
  });
  const loadViewOnlyTranscript = ops.loadViewOnlyTranscript.bind(ops);
  ops.loadViewOnlyTranscript = (threadId, options = {}) => {
    pendingTerminal = options.terminal === true;
    return loadViewOnlyTranscript(threadId, options);
  };

  const stream = createStreamController({
    state,
    ensureConversationTranscript: () => {},
    logLine: () => {},
    seedDefaults: () => {},
    renderSession: (nextSession) => {
      state.session = nextSession;
      ops.maybeRefreshViewOnly(nextSession);
    },
    handleUnauthorized: () => {},
    applySessionSnapshot: () => {},
    cancelSessionPoll: () => {},
    cancelStreamReconnect: () => {},
    scheduleSessionPoll: () => {},
    scheduleStreamReconnect: () => {},
    scheduleRenderFrame: (callback) => callback(),
  });

  return {
    state,
    ops,
    stream,
    loads,
    completePendingFetch(page) {
      assert.ok(pendingResolve, "expected an in-flight view-only fetch");
      pendingResolve(page);
    },
    async flush() {
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test("maybeRefreshViewOnly arms loadViewOnlyTranscript when thread_activity clears", async () => {
  const h = createHarness();
  h.state.viewOnlyThread = {
    threadId: BG_THREAD,
    entries: [{ item_id: "item-1", kind: "agent_text", text: "Hello", status: "running" }],
    wasWorking: true,
    lastRefreshAt: Date.now(),
    loading: false,
  };

  h.ops.maybeRefreshViewOnly(session());
  await h.flush();

  assert.equal(h.loads.length, 1);
  assert.equal(h.loads[0].threadId, BG_THREAD);
});

test("a delta during an initial fetch preserves wasWorking and re-arms terminal refresh", async () => {
  const h = createHarness();

  h.ops.maybeRefreshViewOnly(h.state.session);
  await h.flush();
  assert.equal(h.loads.length, 1, "self-heal must start the first view-only fetch");

  h.stream.applySessionStreamEvent("transcript_entry_delta", {
    thread_id: BG_THREAD,
    item_id: "item-1",
    delta_kind: "agent_text",
    turn_id: "turn-1",
    delta: "Hello world",
    text_offset: 0,
  });
  assert.equal(h.state.viewOnlyThread.wasWorking, true);

  const idleSession = session();
  h.state.session = idleSession;
  h.completePendingFetch();
  await h.flush();

  assert.equal(
    h.loads.length,
    2,
    "maybeRefreshViewOnly must call loadViewOnlyTranscript again after the first fetch completes"
  );
  assert.equal(h.loads[1].threadId, BG_THREAD);
  assert.equal(h.state.viewOnlyThread.wasWorking, true, "the edge must survive until the terminal fetch");
});

test("a refused delta's tailGap triggers immediate loadViewOnlyTranscript", async () => {
  const h = createHarness();
  h.state.viewOnlyThread = {
    threadId: BG_THREAD,
    entries: [{ item_id: "item-1", kind: "agent_text", text: "Hello", status: "running" }],
    lastRefreshAt: Date.now(),
    loading: false,
  };

  h.stream.applySessionStreamEvent("transcript_entry_delta", {
    thread_id: BG_THREAD,
    item_id: "item-1",
    delta: "tail",
    text_offset: 99,
  });
  assert.equal(h.state.viewOnlyThread.tailGap, true);

  h.ops.maybeRefreshViewOnly(h.state.session);
  await h.flush();

  assert.equal(h.loads.length, 1, "needsRepair must fetch immediately");
  assert.equal(h.loads[0].threadId, BG_THREAD);
});

test("tailGap survives fetch start on the loading pin", async () => {
  const h = createHarness();
  h.state.viewOnlyThread = {
    threadId: BG_THREAD,
    entries: [{ item_id: "item-1", kind: "agent_text", text: "Hello", status: "running" }],
    tailGap: true,
    lastRefreshAt: Date.now(),
    loading: false,
  };

  void h.ops.loadViewOnlyTranscript(BG_THREAD);
  await h.flush();

  assert.equal(h.state.viewOnlyThread.loading, true);
  assert.equal(h.state.viewOnlyThread.tailGap, true);
});

test("tailGap raised during an in-flight fetch survives fetch completion", async () => {
  const h = createHarness();
  h.state.viewOnlyThread = {
    threadId: BG_THREAD,
    entries: [{ item_id: "item-1", kind: "agent_text", text: "Hello", status: "running" }],
    lastRefreshAt: Date.now(),
    loading: false,
  };

  void h.ops.loadViewOnlyTranscript(BG_THREAD);
  await h.flush();
  assert.equal(h.state.viewOnlyThread.loading, true);

  h.stream.applySessionStreamEvent("transcript_entry_delta", {
    thread_id: BG_THREAD,
    item_id: "item-1",
    delta: "tail",
    text_offset: 99,
  });
  assert.equal(h.state.viewOnlyThread.tailGap, true);

  h.completePendingFetch();
  await h.flush();

  assert.equal(
    h.state.viewOnlyThread.tailGap,
    true,
    "a stale page must not clear a gap the reducer raised during the fetch"
  );
  assert.ok(h.loads.length >= 1, "the first fetch must settle");
});

test("a delta during a terminal fetch preserves wasWorking for a second idle refresh", async () => {
  const h = createHarness();
  h.state.viewOnlyThread = {
    threadId: BG_THREAD,
    entries: [{ item_id: "item-1", kind: "agent_text", text: "Hello", status: "running" }],
    wasWorking: true,
    lastRefreshAt: Date.now(),
    loading: false,
  };

  void h.ops.loadViewOnlyTranscript(BG_THREAD, { terminal: true });
  await h.flush();
  assert.equal(h.loads.length, 1);
  assert.equal(h.loads[0].terminal, true);

  h.stream.applySessionStreamEvent("transcript_entry_delta", {
    thread_id: BG_THREAD,
    item_id: "item-1",
    delta_kind: "agent_text",
    turn_id: "turn-1",
    delta: " more",
    text_offset: 5,
  });
  assert.equal(h.state.viewOnlyThread.wasWorking, true);
  assert.equal(h.state.viewOnlyThread.deltaDuringFetch, true);

  h.completePendingFetch();
  await h.flush();

  assert.equal(
    h.state.viewOnlyThread.wasWorking,
    true,
    "a delta during the terminal fetch must not be clobbered at completion"
  );

  h.ops.maybeRefreshViewOnly(session());
  await h.flush();

  assert.equal(h.loads.length, 2, "the second idle edge must arm another terminal fetch");
});
