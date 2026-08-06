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
