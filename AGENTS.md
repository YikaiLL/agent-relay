# AGENTS.md

sealwire: a relay that bridges coding-agent providers (codex / claude_code /
fake) to web/mobile frontends. Rust workspace + Node worker + Vite frontend.

## Code map
- `crates/relay-server/` — core. Relay state machine and provider bridges:
  `codex.rs` (native multi-session), `claude.rs` (via the Node worker),
  `fake_provider.rs` (for tests). State/routing live in `src/state/`
  (`relay.rs`, `relay/background.rs`).
- `claude-worker/` — Node worker wrapping `@anthropic-ai/claude-agent-sdk`,
  speaking an NDJSON protocol with Rust over stdin/stdout. `worker.mjs` is the
  main loop.
- `crates/relay-broker | relay-http | relay-util` — public broker / HTTP / utils.
- `frontend/`, `web/` — UI.
- Architecture docs live in `markdown/`: `SESSION_MODEL.md`,
  `PROTOCOL_AND_STORAGE_OVERVIEW.md`, `thread-switch-background-buffer.md`,
  `streaming-delta-plan.md`. Read these before touching the core.
  **`markdown/` is gitignored on purpose** — it is the maintainer's working
  notes, not shipped with the repo. If you cloned this and the directory is
  missing, that is expected: nothing in it is required to build, test, or
  contribute. Some code comments cite these files by path (e.g.
  `markdown/transcript-perf-freeze-analysis.md`); treat those as maintainer
  context you may not be able to read, not as missing files. Do **not** add
  links into `markdown/` from `README.md` or any other tracked doc — they render
  as dead links on GitHub.

## Commands (run after changes)
- Rust: `cargo fmt --check` · `cargo check -p relay-server` · `cargo test -p relay-server`
- Worker: `node --check claude-worker/worker.mjs` · `node --test claude-worker/*.test.mjs`
- Frontend / full: `npm test` (includes vite build, heavier)
- Browser e2e (`npm run test:browser:*`) is slow and needs playwright — **don't
  run by default, only when needed**.

## Committing

**Use `scripts/commit.sh` instead of `git commit`.** It takes the same
arguments (`scripts/commit.sh -m "…"`) and forwards them.

Why: while `npm run dev:full` is running, `crates/sealwire-private/` holds the
real private sources, and the commit hook refuses every commit — correctly, and
often at a moment when stopping the relay is not an option. `scripts/commit.sh`
puts the public stub back for the length of one commit, runs `git commit` with
the hook **active and unmodified**, and restores the private sources from a
snapshot afterwards. Its only lasting effect is the commit. On an unswapped tree
it is a straight pass-through, so it is always the right thing to reach for.

**Never `git commit --no-verify`.** It commits the index with no check at all,
and committing the private sources is the one mistake here that a revert does
not undo.

Two things that are easy to get wrong even when being careful:

- **Edits inside `crates/sealwire-private/` are destroyed** when the dev server
  stops — the swap is a one-way copy in, and it restores the stub on exit. That
  crate's source of truth is the separate private checkout; edit there.
- **The commit hook only inspects the working tree**, so it cannot see a private
  source that was `git add`ed. `scripts/commit.sh` covers that gap by comparing
  each staged blob under the crate against the private checkout; a byte-identical
  match is refused. A public placeholder at the same path is allowed, because
  every new public seam needs one committed.
