import test from "node:test";
import assert from "node:assert/strict";

import { createTeamsCache } from "./teams-cache.js";

function teamsPayload(revision, ids) {
  return {
    teams_revision: revision,
    teams: ids.map((id) => ({ team_run_id: id, title: id, status: "running" })),
  };
}

test("a team list is fetched once per revision, and again when the revision moves", async () => {
  const cache = createTeamsCache();
  let calls = 0;

  await cache.sync(1, async () => {
    calls += 1;
    return teamsPayload(1, ["team-1"]);
  });
  assert.equal(calls, 1);
  assert.equal(cache.current().teams[0].team_run_id, "team-1");
  assert.equal(cache.hasData(), true);

  // The relay recomputes teams_revision as a content hash, so an unchanged run
  // set produces an unchanged key. Refetching here would mean a request per
  // render for the whole life of a task.
  await cache.sync(1, async () => {
    calls += 1;
    return teamsPayload(1, ["team-1"]);
  });
  assert.equal(calls, 1, "an unchanged revision must not refetch");

  await cache.sync(2, async () => {
    calls += 1;
    return teamsPayload(2, ["team-1", "team-2"]);
  });
  assert.equal(calls, 2);
  assert.equal(cache.current().teams.length, 2);
});

test("a revision is fetched at most once even when the response's own revision lags", async () => {
  // The anti-loop guarantee. Gate on the revision we FETCHED FOR, never on the
  // one the response reports: if the relay moves between the snapshot and our
  // fetch, the response lags, and gating on it would leave this snapshot forever
  // unhandled — refetching on every render until a new snapshot arrives.
  const cache = createTeamsCache();
  let calls = 0;

  const fetcher = async () => {
    calls += 1;
    return teamsPayload(7, ["team-1"]);
  };

  await cache.sync(9, fetcher);
  await cache.sync(9, fetcher);
  assert.equal(calls, 1, "the requested revision is what marks a snapshot handled");
});

test("a payload-less response leaves the revision retryable instead of latching empty", async () => {
  // The broker's plaintext envelope can drop the payload field, so a fetch can
  // resolve to null rather than throw. Accepting it would set hasData() true with
  // an empty list — and since callers read `cache.hasData() ? cache : fallback`,
  // a truthy-but-empty cache permanently shadows the fallback.
  const cache = createTeamsCache();
  let calls = 0;

  await cache.sync(4, async () => {
    calls += 1;
    return null;
  });
  assert.equal(cache.hasData(), false, "a null payload is not an answer");

  await cache.sync(4, async () => {
    calls += 1;
    return teamsPayload(4, ["team-1"]);
  });
  assert.equal(calls, 2, "the same revision must still be retryable after a null");
  assert.equal(cache.current().teams[0].team_run_id, "team-1");
});

test("a failed refetch keeps the cards already on screen", async () => {
  const cache = createTeamsCache();

  await cache.sync(1, async () => teamsPayload(1, ["team-1"]));
  await cache.sync(2, async () => {
    throw new Error("relay went away");
  });

  assert.equal(
    cache.current().teams[0].team_run_id,
    "team-1",
    "a transient failure must not blank a task the user is watching"
  );

  // And the failed revision is still retryable — otherwise the list stays stale
  // until the run changes again, which for a paused task could be never.
  await cache.sync(2, async () => teamsPayload(2, ["team-2"]));
  assert.equal(cache.current().teams[0].team_run_id, "team-2");
});

test("a null revision never reaches the network", async () => {
  // A snapshot with no teams_revision at all (an older relay, or one that has
  // never run a task) must not provoke a fetch.
  const cache = createTeamsCache();
  let calls = 0;
  await cache.sync(null, async () => {
    calls += 1;
    return teamsPayload(0, []);
  });
  await cache.sync(undefined, async () => {
    calls += 1;
    return teamsPayload(0, []);
  });
  assert.equal(calls, 0);
  assert.equal(cache.hasData(), false);
});

test("an explicitly empty list is a real answer, not a failure", async () => {
  // Cancelling the last task, or a relay that pruned its runs, legitimately
  // returns zero teams. That must clear the screen rather than leave the old
  // cards up.
  const cache = createTeamsCache();
  await cache.sync(1, async () => teamsPayload(1, ["team-1"]));
  await cache.sync(2, async () => teamsPayload(2, []));
  assert.deepEqual(cache.current().teams, []);
  assert.equal(cache.hasData(), true);
});

test("onUpdate fires only when data actually landed", async () => {
  const cache = createTeamsCache();
  let updates = 0;
  const bump = () => {
    updates += 1;
  };

  await cache.sync(1, async () => null, bump);
  assert.equal(updates, 0, "a null payload must not trigger a re-render");

  await cache.sync(1, async () => teamsPayload(1, ["team-1"]), bump);
  assert.equal(updates, 1);

  await cache.sync(1, async () => teamsPayload(1, ["team-1"]), bump);
  assert.equal(updates, 1, "a deduped sync must not trigger a re-render either");
});

test("the cache says when a fetch is in flight", async () => {
  // Starting a task navigates to its detail before the new run can possibly be in
  // the cache. Without a way to ask "am I mid-refresh?", the screen sees data,
  // sees no matching run, and tells the user the task they just made is gone.
  const cache = createTeamsCache();
  assert.equal(cache.isSyncing(), false);

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = cache.sync(1, async () => {
    await gate;
    return teamsPayload(1, ["team-1"]);
  });
  assert.equal(cache.isSyncing(), true, "a fetch is in flight");

  release();
  await pending;
  assert.equal(cache.isSyncing(), false);
});

test("invalidate forces exactly one refetch without blanking what is on screen", async () => {
  const cache = createTeamsCache();
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return teamsPayload(1, ["team-1"]);
  };

  await cache.sync(1, fetcher);
  await cache.sync(1, fetcher);
  assert.equal(calls, 1);

  cache.invalidate();
  // The old list must survive: a task the user is reading should not blank just
  // because a newer one was created.
  assert.equal(cache.hasData(), true);
  assert.equal(cache.current().teams.length, 1);

  await cache.sync(1, async () => {
    calls += 1;
    return teamsPayload(1, ["team-1", "team-2"]);
  });
  assert.equal(calls, 2, "the same revision is fetched again after invalidate");
  assert.equal(cache.current().teams.length, 2);
});

test("a fetch failure is reported rather than swallowed", async () => {
  // Errors were only ever caught and dropped, so a relay that answers 500 forever
  // looked exactly like a slow one: "Loading tasks…" and a request per frame.
  const cache = createTeamsCache();
  const seen = [];

  await cache.sync(1, async () => {
    throw new Error("relay went away");
  }, null, (error) => seen.push(String(error)));
  assert.equal(seen.length, 1);
  assert.match(seen[0], /relay went away/);

  // And a success clears it, so a recovered relay does not leave a stale error up.
  let cleared = false;
  await cache.sync(1, async () => teamsPayload(1, ["team-1"]), null, (error) => {
    cleared = error === null;
  });
  assert.equal(cleared, true);
});

test("a persistently failing revision stops re-firing every frame", async () => {
  // `sync` runs on every render. Without a stop, a dead endpoint means a request
  // per frame forever — and the user still just sees "Loading tasks…".
  const cache = createTeamsCache();
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error("nope");
  };

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await cache.sync(5, failing);
  }
  assert.ok(calls <= 4, `gave up after a bounded number of attempts, made ${calls}`);

  // A NEW revision is a new fact about the world — it must be tried again.
  await cache.sync(6, async () => teamsPayload(6, ["team-1"]));
  assert.equal(cache.current().teams[0].team_run_id, "team-1");
});

test("a payload-less response is also budgeted, and is also reported", async () => {
  // The null path returns from inside `try` without touching the attempt counter
  // or the error callback — so an `ok:true` envelope with a missing `data` field
  // refetches once per render forever and surfaces nothing. That is the exact
  // case MAX_ATTEMPTS_PER_REVISION exists for.
  const cache = createTeamsCache();
  let calls = 0;
  const seen = [];

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await cache.sync(
      3,
      async () => {
        calls += 1;
        return null;
      },
      null,
      (error) => {
        if (error) seen.push(String(error));
      }
    );
  }
  assert.ok(calls <= 4, `bounded, made ${calls}`);
  assert.ok(seen.length > 0, "a payload-less response must be reported, not silent");
  assert.equal(cache.hasData(), false);

  // A new revision is a new fact — fresh budget.
  await cache.sync(4, async () => teamsPayload(4, ["team-1"]));
  assert.equal(cache.current().teams[0].team_run_id, "team-1");
});
