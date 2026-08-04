import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_THREAD_SEARCH,
  findVisibleThread,
  isThreadSearchActive,
  normalizeThreadSearchQuery,
  selectThreadListView,
} from "./thread-search.js";

function group(cwd, threads) {
  return { key: cwd, cwd, label: cwd.split("/").at(-1), latestUpdatedAt: 0, threads };
}

const RESTING_GROUPS = [
  group("/repos/relay", [{ id: "a", updated_at: 2 }, { id: "b", updated_at: 1 }]),
];

test("whitespace-only input is not a search", () => {
  assert.equal(normalizeThreadSearchQuery("   "), "");
  assert.equal(normalizeThreadSearchQuery(null), "");
  assert.equal(normalizeThreadSearchQuery("  auth "), "auth");
  assert.equal(isThreadSearchActive({ query: "  " }), false);
  assert.equal(isThreadSearchActive(EMPTY_THREAD_SEARCH), false);
  assert.equal(isThreadSearchActive({ query: "auth" }), true);
});

test("not searching → the authoritative groups, untouched", () => {
  const view = selectThreadListView({
    threadGroups: RESTING_GROUPS,
    search: EMPTY_THREAD_SEARCH,
  });
  assert.equal(view.searching, false);
  assert.equal(view.groups, RESTING_GROUPS);
  assert.equal(view.countLabel, "1 folder · 2 sessions");
  assert.equal(view.collapseGroups, true);
});

// The whole point of the feature: results come from the search slice, and the
// authoritative list is not consulted. If this ever falls back to `threadGroups`, a
// search would silently show the page it was already showing.
test("searching → renders the search slice, never the resting groups", () => {
  const hits = [group("/repos/other", [{ id: "z", updated_at: 9 }])];
  const view = selectThreadListView({
    threadGroups: RESTING_GROUPS,
    search: { query: "auth", groups: hits, loading: false, error: null },
  });
  assert.equal(view.searching, true);
  assert.equal(view.groups, hits);
  assert.equal(view.countLabel, "1 result");
});

test("result count is the thread total across groups, not the group count", () => {
  const hits = [
    group("/repos/one", [{ id: "a" }, { id: "b" }]),
    group("/repos/two", [{ id: "c" }]),
  ];
  const view = selectThreadListView({
    search: { query: "auth", groups: hits, loading: false, error: null },
  });
  assert.equal(view.countLabel, "3 results");
});

// Collapse is a resting-state preference. Honouring it mid-search would fold away the
// row the user just asked for, behind a header whose reason for being folded is
// invisible.
test("searching never honours collapsed groups", () => {
  const view = selectThreadListView({
    search: { query: "auth", groups: [], loading: false, error: null },
  });
  assert.equal(view.collapseGroups, false);
});

test("no matches → names the query, so a typo is visible", () => {
  const view = selectThreadListView({
    threadGroups: RESTING_GROUPS,
    search: { query: "nothing here", groups: [], loading: false, error: null },
  });
  assert.equal(view.groups.length, 0);
  assert.equal(view.countLabel, "0 results");
  assert.match(view.emptyMessage, /nothing here/);
});

// Typing is one fetch per keystroke-burst. Blanking between them makes the sidebar
// strobe, so an in-flight query keeps the last results on screen.
test("a query in flight keeps the previous results visible", () => {
  const previous = [group("/repos/relay", [{ id: "a" }])];
  const view = selectThreadListView({
    search: { query: "auth g", groups: previous, loading: true, error: null },
  });
  assert.equal(view.groups, previous);
  assert.equal(view.countLabel, "Searching…");
});

test("a failed search says so instead of looking like zero matches", () => {
  const view = selectThreadListView({
    threadGroups: RESTING_GROUPS,
    search: { query: "auth", groups: [], loading: false, error: "relay offline" },
  });
  assert.equal(view.groups.length, 0);
  assert.equal(view.countLabel, "Search failed");
  assert.match(view.emptyMessage, /relay offline/);
});

// A provider we could not list is dropped from the merge and the request still
// succeeds. Reporting that as "no matches" is a positive claim of absence about
// sessions nobody looked at.
test("an unreachable provider is never reported as 'no matches'", () => {
  const view = selectThreadListView({
    search: {
      query: "auth",
      groups: [],
      loading: false,
      error: null,
      unavailableProviders: ["codex"],
    },
  });
  assert.equal(view.incomplete, true);
  assert.doesNotMatch(view.emptyMessage, /No sessions match/);
  assert.match(view.emptyMessage, /codex/);
  assert.match(view.countLabel, /partial/);
});

test("partial results are still shown, and flagged as partial", () => {
  const hits = [group("/repos/one", [{ id: "a" }])];
  const view = selectThreadListView({
    search: {
      query: "auth",
      groups: hits,
      loading: false,
      error: null,
      unavailableProviders: ["claude_code"],
    },
  });
  assert.equal(view.groups, hits);
  assert.equal(view.countLabel, "1 result · partial");
  assert.equal(view.incomplete, true);
});

// The bug this guards: search exists to surface threads from BEYOND the authoritative
// page, so a result is routinely absent from `state.threads`. Every lookup that asks
// "does this thread exist / what is its title" must see it, or right-click closes
// instantly, tabs fall back to a short id, and rename/fork/archive/delete act on
// nothing — i.e. every action on the rows the feature was built to find.
test("a search-only thread is visible to lookups", () => {
  const authoritative = [{ id: "a", name: "Loaded" }];
  const search = {
    query: "auth",
    groups: [group("/repos/old", [{ id: "z", name: "Buried session" }])],
    loading: false,
    error: null,
  };

  assert.equal(findVisibleThread({ threads: authoritative, search }, "z").name, "Buried session");
  assert.equal(findVisibleThread({ threads: authoritative, search }, "a").name, "Loaded");
  assert.equal(findVisibleThread({ threads: authoritative, search }, "missing"), null);
  assert.equal(findVisibleThread({ threads: authoritative, search }, null), null);
  assert.equal(findVisibleThread({ threads: [], search: null }, "z"), null);
});

// The poll rewrites the authoritative row every 12s; a search result is a snapshot from
// whenever the query ran. A rename landing between the two must not be undone by a
// stale search hit.
test("the authoritative row wins over a stale search copy", () => {
  const view = findVisibleThread(
    {
      threads: [{ id: "a", name: "Renamed just now" }],
      search: { query: "x", groups: [group("/r", [{ id: "a", name: "Old title" }])] },
    },
    "a"
  );
  assert.equal(view.name, "Renamed just now");
});
