# agent-relay

Rust-first relay for remote Codex control.

This repository starts with a simple shape:

- `crates/relay-server`: Rust backend for API endpoints and static web hosting
- `web/`: mobile-friendly web client written in plain JavaScript

## Why this shape

Instead of tying the whole product to one CLI's terminal UI, the relay now talks
to the official `codex app-server` JSON-RPC protocol and exposes a lighter web API
for the browser:

- start a Codex thread from the browser
- list saved Codex threads
- resume a saved thread
- send the next user turn
- forward approval requests back to the browser

That keeps the first version focused on Codex while leaving room for Claude or
other providers later.

## Run

Requirements:

- Rust toolchain
- `codex` CLI installed and logged in

Then run:

```bash
cargo run -p relay-server
```

Open `http://localhost:8787`.

## Current status

The backend currently exposes:

- `GET /api/health`
- `GET /api/session`
- `GET /api/stream`
- `GET /api/threads`
- `POST /api/session/start`
- `POST /api/session/resume`
- `POST /api/session/message`
- `POST /api/approvals/:request_id`

The web client is intentionally plain JavaScript. No TypeScript and no frontend
framework are required for this first pass.

## License

This project is source-available under the Elastic License 2.0. See
[`LICENSE`](LICENSE).

## Contributions

By submitting a contribution, you agree to the contribution terms in
[`CONTRIBUTING.md`](CONTRIBUTING.md), including a broad license that allows the
maintainer to relicense contributions in the future.
