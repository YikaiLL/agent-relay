# agent-relay

`agent-relay` is a local-first control plane for real coding agents.

The goal is not just "a web wrapper for Codex". The goal is to keep one real
agent session controllable, resumable, and trustworthy across browser, phone,
and later other surfaces.

The product is currently Codex-first. The local machine remains the execution
authority. The relay is the control layer around that execution:

- start and resume a real coding session
- see whether it is running, blocked, or waiting
- handle approvals away from the terminal
- move control between devices without losing the session

## Current focus

- Codex first, via the official `codex app-server` JSON-RPC protocol
- single owner, multiple devices
- approval-first remote workflow
- web first, native mobile later
- local-first runtime with a future remote broker layer

## What exists today

The repository currently includes:

- `crates/relay-server`: Rust API server, Codex bridge, session state, and static web hosting
- `crates/relay-broker`: early Rust broker service for future remote transport
- `web/`: plain JavaScript web client

The current implementation supports:

- starting a Codex session from the browser
- listing saved threads scoped by workspace
- resuming a saved thread
- sending the next user turn from the active device
- streaming session updates over SSE
- handling approval requests from the web UI
- single-owner multi-device control with explicit `take over`
- approval decisions from any owner device
- controller lease and heartbeat handling
- optional API token auth with `RELAY_API_TOKEN`
- local session persistence for refresh and resume
- security mode plumbing for `private` and `managed`

The current web UI is intentionally simple:

- chat-style thread view
- workspace-scoped history in the sidebar
- launch settings behind a details panel
- session details behind a collapsible drawer

## What is not done yet

The project is still early. It does not yet provide:

- a production remote broker setup by default
- full auth, pairing, and E2EE transport for off-network access
- a formal event log with replay, cursor, and idempotency guarantees
- push notifications or native mobile apps
- team roles, org policy, or enterprise audit workflows
- cloud runners or multi-agent orchestration
- multi-provider support beyond the Codex-first path

## Roadmap direction

Near-term work is focused on making the control plane trustworthy:

- formalize the session and event model
- define replay, cursor, and idempotency behavior
- make mobile web approval and resume fast and honest
- strengthen device identity, pairing, and remote broker transport
- clarify `private` versus `managed` security modes

Longer-term, the plan is to grow from local-first control into:

- hosted relay and remote access
- stronger audit and policy controls
- native mobile only where the web hits real limits
- cloud execution targets and team workflows later

The business should look more like paid control infrastructure than another chat
subscription.

## Run

Requirements:

- Rust toolchain
- `codex` CLI installed and logged in

Then run:

```bash
cargo run -p relay-server
```

Open `http://localhost:8787`.

Notes:

- the server binds to `127.0.0.1` by default
- set `RELAY_API_TOKEN` to protect `/api` routes
- set `RELAY_SECURITY_MODE=private` or `RELAY_SECURITY_MODE=managed` to switch visibility mode

## Current API surface

The current server exposes:

- `GET /api/health`
- `GET /api/session`
- `GET /api/stream`
- `GET /api/threads`
- `POST /api/session/start`
- `POST /api/session/resume`
- `POST /api/session/heartbeat`
- `POST /api/session/take-over`
- `POST /api/session/message`
- `POST /api/pairing/start`
- `POST /api/devices/:device_id/revoke`
- `POST /api/approvals/:request_id`

CI currently runs:

- `cargo fmt --all --check`
- `cargo check --workspace`
- `cargo test --workspace`

## License

This project is source-available under the Elastic License 2.0. See
[`LICENSE`](LICENSE).

## Contributions

By submitting a contribution, you agree to the contribution terms in
[`CONTRIBUTING.md`](CONTRIBUTING.md), including a broad license that allows the
maintainer to relicense contributions in the future.
