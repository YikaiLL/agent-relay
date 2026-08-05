# Handover — the Project switcher (done: local, remote, and the toggle)

| | |
|---|---|
| **Repo** | `/Users/luchi/git/agent-relay`, branch `main` (the user commits straight to main) |
| **Range** | `bc0d906` → `d3e7c82`, 7 commits on top of `21e78d1` |
| **Pushed?** | No. **Never push, never offer to.** Commit only when the user says so. |
| **State** | `npm test` 1889/1889 · lint clean · `cargo fmt --check` clean (no Rust changed) · 6 browser e2es pass |

Supersedes the "Next" section of `HANDOVER_SEARCH_AND_BELL.md`.

---

## The design, in the user's own words

**A project is NOT bound to a cwd.** *"workspace 就是 project 换个名字而已啦,cwd 跟他
无关"* — a project groups whatever the user wants grouped.

**Selecting a project PINS it, it does not filter.** *"显示全部 session,只是该 project
置顶/高亮"*. Everything follows from this: **the list is the full list in every state.**
Picking the wrong project can never hide a session.

**On a phone, switching projects is a LOW-FREQUENCY act.** *"project 切换在手机属于低频
操作…所以显示默认 session,然后 project 切换器隐藏起来。要让他弱化"*. This arrived after
three rounds of rendered mockups and is why remote looks nothing like local.

---

## What exists now

**Local** — the switcher IS the chat header's `<h1>`. Selecting a project pins its group
to the top of the sidebar list.

**Remote (phone)** — the switcher is **one icon** in `.sidebar-top-actions`, beside search
and the bell, marked `is-active` while a project is pinned. The pinned project is named
by a **chip** above the list (`Sealwire 主线  [1 working]  ×`) and by nothing else; the
pinned group renders **no header row**. On the default workspace the chip does not exist.

**Neither surface has a Sessions/Projects toggle**, and `viewMode` is gone from the shared
store — deleted rather than defaulted, so nothing can reintroduce a second source of truth.

**Rename/delete live in the switcher menu**, last, behind a divider, delete in `--err-fg`.

### Why remote's switcher is not the page title

Measured, not argued: at 390px the chat header already carries a status badge, a model
badge and an info button, and a trigger placed there gets **58px of label width for a
144px label** — "Defa…". With a cwd chip beside it, 33px. `.chat-subtitle` is
`display: none` under 960px and a tooltip is unreachable by touch, so the cwd would have
vanished rather than degraded.

### Why the chip exists

Without it the lifted sessions sit at the top with no group header and nothing saying
why, while every other group has one. They read as a rendering fault rather than a
selection. Hiding the control is fine; hiding the *explanation* is not.

---

## ⚠️ Two recorded decisions were REVERSED. Do not "restore" them.

**1. Rename/delete ARE in the switcher menu.** The old rule ("two places to keep in step,
and a destructive action one keystroke from a navigation action") assumed the pinned
group's header offered them. On touch it never did: `.thread-group-actions` is
`opacity: 0` behind `:hover`, `onContextProject` was only ever wired on local, and iOS
dispatches no `contextmenu` from a long press. They rendered 50px wide and invisible.
The header is now gone entirely, so the menu is the only place left; the concern is
answered with layout instead. `project-switcher.js`'s header comment records this too.

**2. `projects-home` is gone.** It meant "in Projects mode, with no project selected" —
reachable only via a toggle that could put you in a mode without a selection. It
normalizes to the sessions context (what the switcher calls Default Workspace), and the
tab workspace it used to key is dropped on restore.

---

## Invariants

1. **Every session appears exactly once, and the list is always complete.**
2. **The pin fails OPEN.** An unresolvable project id degrades to plain cwd grouping.
   Covered end-to-end: the bell e2e makes the project vanish from the payload
   (`window.__setProjectsGone`), asserts the whole list survives, and asserts the pin
   **recovers by itself** when it comes back — the selection was never destroyed, only
   unresolvable.
3. **The pin stands down while search or the bell is active.** The bell re-buckets the
   list rather than narrowing it, so a pinned group cannot survive it.
   `selectPinnedProjectId` is that policy.
4. **One resolved id.** `resolvedProjectId` feeds the highlight, `data-active-project-id`
   and the menu's tick. They used to read the raw prop while only the label failed open.
5. **Relay-scoped state is forgotten on a relay switch** (`relay-scoped-state.js`). The
   rule: *is it keyed by something only one relay issues?*
6. **A headerless group cannot be folded** — the disclosure lives on the header and the
   collapsed set is persisted.
7. **Deleting a project decides where to leave you from the COMMITTED context, drained.**
   See below; this one took three attempts.

---

## The delete-landing race, three times over

Worth reading in full before touching `deleteProjectFromHeader`. Each fix exposed the
next problem, and each was found by review rather than by the suite.

**Attempt 1 — the survivor fallback.** The handler read the delete receipt and navigated
to `receipt.projects[0]`. Meanwhile `dropStaleProjectSelection` cleared the same
selection. Two mechanisms, opposite answers; the clearing one happened to win, so the
screen was right while the code said the opposite. **Correct by accident.**

**Attempt 2 — the confirm-time snapshot.** Deciding before the await made the decision
outlive the request: delete A, pick B while it is in flight, and the response yanks you
out of B.

**Attempt 3 — the uncommitted read.** Reading `getState()` after the await only covers
navigation that has already COMMITTED. `performDispatch` assigns `state` after its
IndexedDB transaction resolves, so a click on B that is still persisting reports as
"you are in A". Both reconciliation paths now `await sessionViewController.whenIdle()`
first — its loop matters, because a dispatch arriving mid-wait must be waited for too.

The decision itself is `selectContextAfterProjectDelete` (session-view-state.js). It
takes **no survivor list**: there is no receipt shape that changes the answer, so there
is none to get wrong. It returns null when the deletion does not concern you — deleting
someone else's project must not yank you out of your own.

---

## Method — earned the hard way this session

**A test that is green before the feature exists is not a test.** This happened **six
times**, and every instance was caught by mutation or by review, never by the suite:

- Four of six render-model tests passed against an *unimplemented* `pinnedProjectId`
  (falling through to cwd grouping satisfies completeness, fail-open, no-blanking and
  the folder count). Fixed with an `assertPinIsInEffect` precondition.
- "Nothing to rename or delete with no project selected" passed the same way.
- **No test passed `create`, `rename` and `delete` together** — which is what production
  does — so their render order was never asserted, and it was wrong.
- The import-resolution scanner passed cleanly over the very defect it was written for
  (it stripped string literals before deciding whether an import was real — but an import
  path IS a string literal).
- Both controller-ordering tests: one read in the same synchronous turn as the dispatch,
  the other awaited the thing it was meant to race.

**Mutate every guard individually**, and never report a mutation result for a rule you
did not mutate.

**End-state assertions cannot distinguish a race.** Every end-state check — routed
context, active menu option, absence of a project header — passed IDENTICALLY under both
delete behaviours, because the race resolved to the same place. What differs is the
transit, so the e2e records `pushState`/`replaceState` for the duration of the delete.

**Some invariants can only be pinned below the browser.** The e2e for attempt 3 has to
wait for B's header before releasing the delete — which is waiting for exactly the commit
that closes the window. Removing the drain leaves it green. That one lives in a
controller test with a gated persistence.

**Do not add a source-level CSS guard for a layout or cascade question.** The stylesheet
guard was green through all three CSS traps below.

**Show, don't describe.** Every design decision here was settled by rendering the real
surface at 390px and letting the user look. Three reversed what the prose argued for.

---

## Traps

1. **A source-level CSS guard is not a cascade engine.** The chip matched
   `.thread-group-name`'s declarations exactly and still painted a size smaller: a
   `@media (max-width: 960px)` step-up moved one and not the other. Fixed by making them
   **the same rule**; the guard now asserts every rule typing the group header also names
   the chip.
2. **A flex item's `min-width: auto` overrides `max-width: 100%`.** A long name grew the
   chip to 420px inside a 309px column and pushed its own × off screen. Same fact explains
   why `display: inline-flex` computed as `flex` — flex items are blockified.
3. **Anchoring a menu to its trigger cannot work in a drawer.** 272px drawer at 320px vs a
   220px minimum: left-anchored it ran off the right, **right-anchored off the left
   (-51px)**. Only spanning the top bar works. Check both widths.
4. **`assert.deepEqual` with a jsdom node OOMs the test process** (exit 137, no message).
   Assert counts and strings, never elements.
5. **`waitForFunction`'s third argument is options.** Passing `{timeout}` second makes it
   the predicate's ARGUMENT and silently uses the default — one step burned 30s a run.
6. **`button { justify-content: center }` is global** — `text-align: left` alone is a no-op.
7. **An undefined CSS token silently takes its fallback.** Prefer a bare `var(--x)`.
8. **`dom.js` resolves ~115 `querySelector`s at IMPORT time**, before the React sub-roots
   render.
9. **Never blind-toggle a control in a test** — read `aria-expanded` first.
10. **Escape inside the switcher menu must not bubble** — the sidebar search reads a bare
    Escape as "close and clear".
11. **`| head` on a leftover-reference sweep hides work.** It truncated a grep at 10 lines
    and cost a whole e2e file's worth of missed references.

---

## Coverage — what is verified where

| Claim | Where |
|---|---|
| Grouping, fail-open, counts | `frontend/remote/view-model-projects.test.mjs` |
| Menu contents, order, stale marking, icon trigger | `frontend/shared/project-switcher.dom.test.mjs` |
| Headerless pinned group: collapse, empty, >10 sessions | `frontend/thread-groups.test.mjs` |
| Where a delete leaves you | `frontend/local/session-view-state.test.mjs` |
| Pending-persistence ordering, `whenIdle`'s loop | `frontend/local/session-view-controller.test.mjs` |
| Relay-scoped reset | `frontend/remote/relay-scoped-state.test.mjs` |
| Named imports resolve to real exports | `frontend/import-resolution.test.mjs` |
| Divider, danger colour, menu anchoring, chip typography | `frontend/project-switcher-style-guard.test.mjs` |
| **Menu inside the drawer at 320px and 390px** | bell e2e |
| **Chip typography identical to group headers (computed)** | bell e2e |
| **Long name clips, × stays inside** | bell e2e |
| **Deleting the pinned project; project vanishing externally** | bell e2e |
| **No transit through another project on delete** | shell-redesign e2e |
| **A delete resolving late vs a navigation made meanwhile** | shell-redesign e2e |

Light theme checked visually (`local-scratch-scripts/shots-wired/W5,W6`); the danger
colour resolves in both themes by test.

---

## Next

Nothing is blocked. Loose ends, in rough order of value:

- **`ProjectOverview` is retired from view, not deleted** (`render-session.js`,
  `showProjectOverview = false`). Its pin/order prefs still back the sidebar rows, which
  is why it stays. If it is never coming back, that is a deliberate deletion someone
  should make on purpose — component, model, prefs and tests together.
- **`findLatestThread`** in `thread-groups.js` still has no callers and four tests.
- **`.project-sidebar-list`** and neighbours may be dead now that the sidebar lists no
  project rows; check before deleting, the classes are shared.
- The **projects e2e** (`browser-local-projects-e2e.mjs`) is the slowest at ~57s and still
  carries the pre-existing flake noted at `5d77d11` (step 11 waiting for a virtualized row
  to become visible on the projects-failure page). **Not papered over** — loosening the
  wait would hide a real render regression.

---

## Commands

```bash
npm test          # 1889/1889, includes vite build
npm run lint
cargo fmt --check                            # no Rust changed this session

npm run build     # e2es drive web/; a stale build means driving old JS
cargo build -p relay-server
node scripts/browser-remote-mobile-bell-e2e.mjs                     # static server, no relay
E2E_USE_BUILT_BINARIES=1 AGENT_PROVIDERS=fake node scripts/browser-local-shell-redesign-e2e.mjs
E2E_USE_BUILT_BINARIES=1 AGENT_PROVIDERS=fake node scripts/browser-local-projects-e2e.mjs
E2E_USE_BUILT_BINARIES=1 AGENT_PROVIDERS=fake node scripts/browser-local-session-tabs-e2e.mjs
E2E_USE_BUILT_BINARIES=1 AGENT_PROVIDERS=fake node scripts/browser-local-search-filter-e2e.mjs
```

Scratch scripts (gitignored, `local-scratch-scripts/`): `verify-project-switcher-mobile.mjs`
boots the real phone surface and measures the chip; `weaken-switcher-examples.mjs` renders
the de-emphasis mockups the user chose V4 from.

## Working rules

- **Never push. Never offer to.** Commit only when told; commit straight to `main`.
- **Bugs are red→green**, then revert the fix to prove the test catches it.
- **Mutate every guard individually.**
- The user works in Chinese, spots UI problems by eye that the suite cannot, and pushes
  back hard on unverified claims. Check the code before asserting — three review rounds
  here were right, and each time the evidence was one `grep` away.
