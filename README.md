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
- `frontend/`: Vite-based web client source
- `web/`: generated static build output for Rust to serve locally

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
- broker-served remote PWA shell with installable manifest and service worker

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

Frontend workflow:

```bash
npm install
npm test
```

The default `npm test` target runs the production Vite build, which is what CI
uses to catch frontend regressions.

Browser pairing e2e:

```bash
npm run test:browser:pairing
```

Remote broker smoke test:

```bash
npm run smoke:pairing
```

Then run:

```bash
cargo run -p relay-server
```

Open `http://localhost:8787`.

Notes:

- the server binds to `127.0.0.1` by default
- `web/` is generated and gitignored, so build the frontend before running the Rust web servers
- set `BIND_HOST=0.0.0.0` only when you intentionally want network reachability
- set `RELAY_API_TOKEN` to protect `/api` routes
- set `RELAY_SECURITY_MODE=private` or `RELAY_SECURITY_MODE=managed` to switch visibility mode
- use `npm run dev` when iterating on the web UI, then `npm run build` to refresh the
  Rust-served assets under `web/`

## Remote broker deploy

The broker is the easiest piece to deploy first because it does not run Codex
or touch your workspace directly.

Build and run it with Docker Compose:

```bash
docker compose up --build relay-broker
```

Or directly with Docker:

```bash
docker build -f docker/broker.Dockerfile -t agent-relay-broker .
docker run --rm -p 8788:8788 -e BIND_HOST=0.0.0.0 agent-relay-broker
```

Then point your local relay-server at that broker:

```bash
RELAY_BROKER_URL=ws://127.0.0.1:8788 \
RELAY_BROKER_PUBLIC_URL=ws://192.168.1.105:8788 \
RELAY_BROKER_CHANNEL_ID=dev-room \
RELAY_BROKER_PEER_ID=local-relay \
RELAY_BROKER_TICKET_SECRET=change-me \
cargo run -p relay-server
```

Notes:

- `RELAY_BROKER_AUTH_MODE` defaults to `self_hosted`. That mode is the current
  shared-secret join-ticket model for self-hosted or dedicated brokers.
- `public` broker auth now runs as a hosted auth plane inside the broker
  service itself. In that mode, the broker issues short-lived websocket access
  tokens over HTTP and verifies them itself; the relay no longer signs broker
  join tickets directly.
- `relay-server` still expects local Codex access and a real workspace, so it is
  usually better to run it on the workstation, VM, or jump host that already
  owns the repo and CLI session.
- when the broker is only locally reachable from the relay host, set
  `RELAY_BROKER_PUBLIC_URL` to the LAN or public `ws://` / `wss://` address that
  remote phones and browsers should use for pairing
- `RELAY_BROKER_URL` and `RELAY_BROKER_PUBLIC_URL` should still point at the same
  broker instance; they only differ in how the relay host versus remote devices
  reach that broker
- `RELAY_BROKER_TICKET_SECRET` must be set to the same value on both the broker
  and the relay-server in `self_hosted` mode, otherwise all websocket joins are
  rejected
- `RELAY_BROKER_DEVICE_JOIN_TTL_SECS` is optional in `self_hosted` mode. If it
  is unset, paired-device broker join tickets stay valid until revoke; if it is
  set, saved remote access expires after that many seconds and requires re-pairing.
- `public` mode uses a hosted control-plane API on the broker itself:
  - broker env:
    - `RELAY_BROKER_AUTH_MODE=public`
    - `RELAY_BROKER_PUBLIC_ISSUER_SECRET`
    - `RELAY_BROKER_PUBLIC_RELAYS_JSON`
    - `RELAY_BROKER_PUBLIC_STATE_PATH` in production or any non-loopback bind
    - optional `RELAY_BROKER_PUBLIC_STATE_PATH` for localhost-only development
    - optional `RELAY_BROKER_PUBLIC_RELAY_WS_TTL_SECS`
    - optional `RELAY_BROKER_PUBLIC_DEVICE_WS_TTL_SECS`
    - optional hardening env:
      - `RELAY_BROKER_PUBLIC_API_RATE_LIMIT_PER_MINUTE`
      - `RELAY_BROKER_JOIN_RATE_LIMIT_PER_MINUTE`
      - `RELAY_BROKER_PUBLISH_RATE_LIMIT_PER_MINUTE`
      - `RELAY_BROKER_MAX_TEXT_FRAME_BYTES`
      - `RELAY_BROKER_IDLE_TIMEOUT_SECS`
  - relay-server env:
    - `RELAY_BROKER_AUTH_MODE=public`
    - `RELAY_BROKER_RELAY_ID`
    - `RELAY_BROKER_RELAY_REFRESH_TOKEN`
    - optional `RELAY_BROKER_CONTROL_URL`
  - the broker still uses `RELAY_BROKER_CHANNEL_ID` on the relay side as the
    room id, but the hosted control-plane validates that it matches the relay's
    registered room
- `RELAY_BROKER_PUBLIC_RELAYS_JSON` is a minimal bootstrap registry, not a full
  hosted account system yet. A single entry looks like:

```json
[{"relay_id":"relay-1","broker_room_id":"demo-room","refresh_token":"change-me"}]
```

- in `public` mode, approved devices now receive:
  - a short-lived broker websocket token
  - a long-lived `device_refresh_token`
  - the remote web surface uses that refresh token to rotate broker access
    instead of forcing re-pairing on every ws token expiry
- public-mode device refresh grants are persisted via
  `RELAY_BROKER_PUBLIC_STATE_PATH`; when the broker binds to a non-loopback
  host, startup now requires that path so refresh survives restart and revoke
  remains effective
- The broker remote surface is now installable as a PWA. Open the broker root,
  then use your browser's install action to pin it on a phone or desktop.
- pairing and encrypted broker traffic now work on plain LAN `http://` pages, but
  service worker registration still only works on `https://` origins or `localhost`.

Public mode example:

```bash
RELAY_BROKER_AUTH_MODE=public \
RELAY_BROKER_PUBLIC_ISSUER_SECRET=change-me \
RELAY_BROKER_PUBLIC_RELAYS_JSON='[{"relay_id":"relay-1","broker_room_id":"demo-room","refresh_token":"relay-refresh-1"}]' \
docker compose up --build relay-broker
```

```bash
RELAY_BROKER_URL=wss://broker.example.com \
RELAY_BROKER_PUBLIC_URL=wss://broker.example.com \
RELAY_BROKER_AUTH_MODE=public \
RELAY_BROKER_CHANNEL_ID=demo-room \
RELAY_BROKER_PEER_ID=local-relay \
RELAY_BROKER_RELAY_ID=relay-1 \
RELAY_BROKER_RELAY_REFRESH_TOKEN=relay-refresh-1 \
cargo run -p relay-server
```

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
- `POST /api/devices/:device_id/revoke-others`
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
