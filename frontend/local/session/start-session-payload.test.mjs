import test from "node:test";
import assert from "node:assert/strict";

// CHARACTERIZATION TESTS for the local "New session" submit path.
//
// These do not describe a bug. They pin the behavior that exists TODAY, before
// the start dialog is redesigned and moved off its uncontrolled-DOM submit onto
// a store-driven one like remote's. Every assertion here must still hold after
// that migration — that is the whole point of writing them first.
//
// These were written BEFORE the migration, against the DOM-reading version, and
// every assertion about the request body below is unchanged from that run. That
// is the "identical behaviour" contract in mechanical form: the dialog was
// rebuilt and local's submit moved from reading eight live elements by id onto
// the session draft, and the bytes reaching `/api/session/start` still had to
// match, key for key.
//
// ONE key was added on purpose — `project_id` — because filing a session into a
// project at creation is the feature this work exists for. It is called out at
// the assertion rather than quietly folded in.
//
// lifecycle.js transitively imports dom.js, which queries the document at
// import time. Same stub shape as send-error.test.mjs — a stable node per
// selector — so the module can be imported at all.
const nodes = new Map();
function fakeNode(selector) {
  if (!nodes.has(selector)) {
    nodes.set(selector, {
      selector,
      value: "",
      disabled: false,
      hidden: true,
      textContent: "",
      dataset: {},
      style: {},
      classList: { add() {}, contains: () => false, remove() {}, toggle() {} },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      removeAttribute() {},
      appendChild() {},
      focus() {
        this.focused = true;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
    });
  }
  return nodes.get(selector);
}

globalThis.document = {
  querySelector: fakeNode,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  createElement: () => fakeNode("created"),
  get body() {
    return fakeNode("body");
  },
};
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  navigator: { userAgent: "node" },
  location: { origin: "http://localhost", href: "http://localhost/", search: "" },
};

const { createLifecycleController } = await import("./lifecycle.js");

// The launch draft a filled-in dialog would hold. This replaces the map of
// element ids the earlier revision used — same values, read from the store the
// dialog writes to instead of from the markup it renders.
function defaultDraft() {
  return {
    approvalPolicy: "never",
    cwd: "/Users/luchi/git/agent-relay",
    effort: "xhigh",
    initialPrompt: "ship the thing",
    model: "claude-opus-4-6",
    projectId: null,
    provider: "claude_code",
    // No longer offered in the UI — the file-access dropdown was collapsed into
    // the permission level — but still carried so the start protocol is
    // unchanged.
    sandbox: "workspace-write",
  };
}

function buildController({ draft = defaultDraft(), respond } = {}) {
  const requests = [];
  const requestedIds = [];
  const logged = [];
  const selectedCwds = [];
  const focused = [];

  // `startSession` ends with a `loadThreads("post-start refresh")`, so the state
  // needs enough of the thread-list plumbing for the success path to run to
  // completion. Without it the refresh throws, the shared catch swallows it, and
  // the function returns null — which looks exactly like a failed start.
  const state = {
    deviceId: "device-1",
    session: null,
    threads: [],
    threadGroups: [],
    threadListStore: {
      getState: () => ({
        startRefresh() {},
        finishRefresh() {},
        failRefresh() {},
        search: EMPTY_SEARCH,
      }),
      subscribe: () => () => {},
    },
  };
  const controller = createLifecycleController({
    state,
    apiFetch: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      requests.push({ url, options, body });
      if (url.startsWith("/api/threads")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { threads: [] } }) };
      }
      return respond ? respond(url, options) : rejection();
    },
    logLine: (line) => logged.push(line),
    // Still supplied, and still recorded — so a regression that goes BACK to
    // reading the DOM shows up as a failure rather than as a silent tie.
    liveElement: (id) => {
      requestedIds.push(id);
      return null;
    },
    readSessionDraft: () => draft,
    focusWorkspaceField: () => focused.push("workspace"),
    setSelectedCwd: (cwd) => selectedCwds.push(cwd),
    canCurrentDeviceWrite: () => false,
    seedDefaults: () => {},
    setThreadRoute: () => {},
    renderSession: () => {},
    renderOverviewState: () => {},
    renderSessionUnavailable: () => {},
    renderThreadListMessage: () => {},
    renderThreads: () => {},
    renderAuthRequiredState: () => {},
    // Seam: the real one runs the DOM-swap callback. Skipping it keeps these
    // tests on the request contract instead of dragging in the whole snapshot
    // apply path, which has its own tests.
    runViewTransition: async () => {},
    setStartControlsBusy: () => {},
    isViewingConversation: () => true,
    queryClient: null,
    // Called through `ctx.` rather than destructured, so they must exist or the
    // post-start refresh throws past the success return.
    scheduleThreadsPoll: () => {},
    scheduleSessionPoll: () => {},
    cancelControllerHeartbeat: () => {},
    cancelControllerLeaseRefresh: () => {},
    resetTranscriptHydrationState: () => {},
  });

  // The post-start thread refresh issues its own request; the assertions below
  // are about the START call, so name it explicitly rather than relying on
  // ordering or on the refresh happening to fail.
  const startRequests = () => requests.filter((entry) => entry.url === "/api/session/start");

  return {
    controller,
    requests,
    startRequests,
    requestedIds,
    logged,
    selectedCwds,
    focused,
    draft,
    state,
  };
}

const EMPTY_SEARCH = { query: "", normalized: "", active: false };

const rejection = () => ({
  ok: false,
  status: 400,
  json: async () => ({ ok: false, error: { code: "bad_request", message: "nope" } }),
});

const acceptance = (data = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    data: { active_thread_id: "thread-new", current_cwd: "/Users/luchi/git/agent-relay", ...data },
  }),
});

test("the start request carries exactly the fields the dialog collects", async () => {
  const { controller, startRequests } = buildController({ respond: () => acceptance() });

  await controller.startSession();

  assert.equal(startRequests().length, 1, "one POST to start a session");
  assert.equal(startRequests()[0].options.method, "POST");
  // The exact body, key for key. A redesign is free to change how these values
  // are COLLECTED; it is not free to change what reaches the relay.
  assert.deepEqual(startRequests()[0].body, {
    cwd: "/Users/luchi/git/agent-relay",
    initial_prompt: "ship the thing",
    model: "claude-opus-4-6",
    approval_policy: "never",
    sandbox: "workspace-write",
    effort: "xhigh",
    device_id: "device-1",
    provider: "claude_code",
    // The one intentional addition since this test was first written against the
    // DOM-reading implementation. Everything above is byte-for-byte what the old
    // path sent.
    project_id: null,
    images: [],
  });
});

test("submit reads the draft, never the DOM", async () => {
  // The inverse of what this file originally asserted, and deliberately so. The
  // old test pinned that submit read seven element ids, which was the right
  // guard WHILE the values lived in the markup. Now that the dialog is
  // controlled, reading the DOM at submit time is the bug: it would resurrect a
  // second source of truth that can disagree with what the user sees.
  const { controller, requestedIds, startRequests } = buildController({
    respond: () => acceptance(),
  });

  await controller.startSession();

  assert.deepEqual(requestedIds, [], "no element is looked up to build the request");
  assert.equal(startRequests()[0].body.model, "claude-opus-4-6", "the draft supplied it");
});

test("a project chosen in the dialog is filed as part of the start", async () => {
  // Local used to do this as a second step — start, read the new thread id off
  // the response, then POST a project `assign`. Remote structurally could not
  // copy that (its start returns no thread id), and a failed follow-up silently
  // left the session unfiled.
  const { controller, startRequests } = buildController({
    draft: { ...defaultDraft(), projectId: "proj_00ff" },
    respond: () => acceptance(),
  });

  await controller.startSession();

  assert.equal(startRequests()[0].body.project_id, "proj_00ff");
});

test("blank optional text fields are sent as null, not empty string", async () => {
  // `initial_prompt` and `model` are the two the relay treats as "resolve a
  // default for me". Sending "" instead of null makes the relay honour an empty
  // prompt/model, which is not the same request.
  const { controller, startRequests } = buildController({
    draft: { ...defaultDraft(), initialPrompt: "   ", model: "" },
    respond: () => acceptance(),
  });

  await controller.startSession();

  assert.equal(startRequests()[0].body.initial_prompt, null);
  assert.equal(startRequests()[0].body.model, null);
});

test("a missing provider sends null rather than omitting the key", async () => {
  const { controller, startRequests } = buildController({
    draft: { ...defaultDraft(), provider: "" },
    respond: () => acceptance(),
  });

  await controller.startSession();

  assert.ok("provider" in startRequests()[0].body, "the provider key must still be present");
  assert.equal(startRequests()[0].body.provider, null);
});

test("the workspace is trimmed, and pinned as selected before the request goes out", async () => {
  const { controller, startRequests, selectedCwds } = buildController({
    draft: { ...defaultDraft(), cwd: "  /Users/luchi/git/agent-relay  " },
    respond: () => acceptance(),
  });

  await controller.startSession();

  assert.equal(startRequests()[0].body.cwd, "/Users/luchi/git/agent-relay");
  assert.equal(
    selectedCwds[0],
    "/Users/luchi/git/agent-relay",
    "the trimmed cwd becomes the selected workspace before the POST"
  );
});

test("an empty workspace refuses to submit and focuses the field instead", async () => {
  const { controller, startRequests, focused } = buildController({
    draft: { ...defaultDraft(), cwd: "   " },
  });

  const result = await controller.startSession();

  assert.equal(result, null, "no session is started");
  assert.equal(startRequests().length, 0, "nothing is sent to the relay");
  assert.deepEqual(
    focused,
    ["workspace"],
    "the workspace field takes focus so the user can fix it"
  );
});

test("a successful start returns the new thread id", async () => {
  // Still load-bearing, though for a smaller reason than when this was written:
  // the pending-project two-step that consumed it is gone (the relay files the
  // session now), but app.js still uses the id to clear the image attachments
  // that were actually sent.
  const { controller } = buildController({ respond: () => acceptance() });

  assert.equal(await controller.startSession(), "thread-new");
});

test("a rejected start returns null and does not throw", async () => {
  const { controller, logged } = buildController({ respond: rejection });

  assert.equal(await controller.startSession(), null);
  assert.ok(
    logged.some((line) => /Session start failed/.test(line)),
    "the failure is reported to the client log"
  );
});
