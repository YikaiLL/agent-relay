# sealwire

**Trust your agent to run on its own for a long time — and stay in control from
anywhere.**

sealwire runs a long-lived **Codex** or **Claude Code** session on your own
machine and turns it into something you can walk away from: point two agents at
each other for a review, kick off a multi-step workflow that loops until it's
done, then watch and steer the whole thing from any browser or phone — over LAN
or the public internet — without losing the session.

**The headline features:**

- 🔍 **Request a review** — ask a *second* agent to review the current work.
  Claude Code can review Codex, Codex can review Claude, in its own session, and
  the findings land right back in your thread. Optionally loop reviewer ↔ author
  for several rounds until the reviewer approves. [More ↓](#request-a-review)
- 🔁 **Workflows** — run a saved pipeline of agent steps (execute → review →
  revise) that **loops until a reviewer approves**. It's a long-lived, persisted,
  backgroundable task: it keeps going while you're away, streams progress to your
  phone, and survives a relay restart. [More ↓](#workflows)
- 📱 **Control from everywhere** — one operator, many surfaces. Move between
  browser, laptop, and phone without losing the session; approve, take over, or
  redirect from wherever you are.

The rest still holds: the local machine stays the source of truth, the relay is
just the control layer around it, and remote devices pair through the **hosted
public broker** (`wss://agent-relay.up.railway.app`) with no infrastructure to
deploy. Default `private` mode keeps the broker as blind transport — it relays
encrypted traffic, it doesn't read your prompts, approvals, or code.

**Rust** backend (`relay-server` + `relay-broker`), Node-based Claude Code
worker, Vite web UI — install with `npx sealwire` on macOS, or run from source
([Quick start ↓](#quick-start)).

---

## The vision

The bottleneck with coding agents isn't raw capability anymore — it's *trust*
and *presence*. You can't fully trust a single agent to run unattended for long,
and you have to be sitting at the terminal to catch it when it stalls or asks for
an approval.

sealwire attacks both:

- **Trust comes from a second agent, not blind faith.** A single model marking
  its own homework is weak. `sealwire` makes cross-agent review and
  review/revise loops first-class, so work gets checked by a *different* agent
  before it reaches you — and can iterate on its own until it's actually good.
- **Presence comes from the network, not the terminal.** Long-running work is
  persisted and backgroundable; approvals, takeover, and progress follow you to
  whatever device you're holding. The session doesn't die when you close the
  laptop.

The local machine stays the execution authority the whole time. The relay is the
control layer around it — and the broker never has to become the place where your
code, prompts, and approvals live in plaintext.

`sealwire` supports both Codex and Claude Code today. The relay lets you:

- start and resume a coding session against Codex or Claude Code
- ask a second agent to review the work, or run a full review/revise workflow
- see whether it is running, blocked, or waiting
- handle approvals away from the terminal
- move control between devices without losing the session

## Quick start

```bash
npx sealwire
```

That starts a **localhost-only** relay at <http://localhost:8787> and opens the
web UI as soon as it is ready. The commands you'll actually use:

```bash
sealwire cloud       # attach to the hosted public broker so a phone can pair
sealwire local       # stay offline: never attach to a broker
sealwire --port 8788 --host 127.0.0.1   # bind address / port
sealwire --no-open   # don't open a browser
```

You need agent auth for whichever provider you use:

- **Codex** — the [`codex`](https://github.com/openai/codex) CLI installed and
  logged in
- **Claude Code** — Claude auth only: an `ANTHROPIC_API_KEY`, or an existing
  Claude Code login. The Claude worker (and its bundled Claude Code CLI) ships
  inside the package, so the `claude` command does **not** need to be on your
  PATH

sealwire treats the directory you launched it from as the default workspace for
new sessions; its own state (sessions, projects, paired devices) lives in
`~/.agent-relay/` — one set per machine, so `cd`-ing elsewhere doesn't fork
your history.

> **Linux / Windows:** prebuilt binaries are temporarily disabled while those
> platforms are untested. `npx sealwire` still works there, but it falls back to
> building `relay-server` from source, which needs the Rust toolchain.

A macOS **desktop app** (Tauri) is also in preview: it supervises the same
`relay-server` as a sidecar and keeps the local and remote surfaces as separate
native windows, with a control window for workspace selection, broker mode, and
relay logs.

Running from source, the full flag list, env vars, and the self-hosted broker
option live in [`DEPLOYMENT.md`](DEPLOYMENT.md); tests and CI in
[`TESTING.md`](TESTING.md).

## Current status

`sealwire` is now usable as a single-owner self-hosted MVP with a
privacy-first default.

The recommended deployment shape today is:

- keep `relay-server` on the workstation, VM, or jump host that already has the
  local workspace and a logged-in `codex` CLI and/or Claude auth
- use the hosted public broker at <https://agent-relay.up.railway.app/> to pair
  phones and remote browsers without running broker infrastructure yourself, or
  self-host `relay-broker` if you prefer to keep that hop under your control
- treat the current product as a trustworthy control plane for one operator and
  multiple devices, not as a multi-tenant hosted service

## Use cases

`sealwire` is built for cases where one coding session already exists
and the problem is control, continuity, and trust rather than raw execution.

Good fits today:

- you want a **second agent to review** the first one's work — cross-provider,
  in its own session — instead of trusting a single model to grade itself
- you want to **start a review/revise workflow and walk away**, watching it loop
  toward approval from your phone rather than babysitting the terminal
- you want to start or resume a Codex or Claude Code session from a browser
  without moving the workspace off the machine that already owns it
- you want to review approval requests or take over a session from your phone
  while away from the terminal
- you want one long-lived agent session to survive device switches instead of
  creating a fresh session on every surface
- you want to self-host the control plane and keep the execution authority near
  your repo, secrets, and logged-in CLI, while still reaching it remotely
  through a hosted public broker
- you care about privacy and want the default model to treat the broker as
  transport, not as the place that gets to read everything

Not the current target:

- multi-user hosted collaboration
- untrusted tenants sharing the same control plane
- cloud-first remote execution where the local workstation is optional

## Design principles

The design is intentionally opinionated:

- trust through independent review: a second agent checking the first's work
  (and iterating until it's good) earns more trust than one model grading itself
- unattended by default: long-running work should persist, background, and
  survive restart, so you can start it and walk away rather than babysit a terminal
- local-first authority: the machine with the local workspace and the Codex or
  Claude Code session remains the source of truth
- privacy-first defaults: the safe path should be the obvious path for people
  who do not want their code, prompts, and approvals copied into a hosted
  middle layer by default
- one operator, many surfaces: browser, phone, and future native clients are
  control surfaces for the same session, not separate runtimes
- approval-first remote UX: remote control must make blocked state, ownership,
  and approval flow obvious instead of pretending the session is stateless
- explicit trust boundaries: broker transport, device identity, and session
  claims are separate concerns; the broker does not become the execution host
- gradual hardening: start with single-owner self-hosting, then add stronger
  replay, audit, and policy guarantees without changing the core model

## Security model

Security is a core part of the product, not a later add-on.

- `private` mode is the default security model: broker-mediated remote traffic
  is end-to-end encrypted and the broker is treated as blind transport rather
  than a content-reading execution layer
- privacy follows from that default: your remote control path can stay usable
  without requiring the broker to see session content in plaintext
- `managed` mode exists for deployments that explicitly want broker or org
  services to read content for audit and policy workflows
- pairing and remote claim flows bind device identity before a remote surface
  can take control of a session
- remote devices keep signing keys in browser-managed crypto storage when
  `WebCrypto` and `IndexedDB` are available, with a compatibility fallback for
  weaker browser contexts
- the relay-server remains the execution authority near the local workspace; the
  broker moves encrypted control traffic rather than hosting the agent itself

## Current focus

- **cross-agent review** — one agent reviews another's work, single-shot or as a
  multi-round reviewer ↔ author loop
- **workflows** — saved execute → review → revise pipelines that loop until a
  reviewer approves, running as long-lived, restart-surviving background tasks
- Codex via the official `codex app-server` JSON-RPC protocol
- Claude Code via the official `@anthropic-ai/claude-agent-sdk`
- single owner, multiple devices
- approval-first remote control that follows you across devices
- web first, native mobile later
- local-first runtime with the hosted public broker at
  <https://agent-relay.up.railway.app/> as the default remote transport, and a
  self-hosted broker as an option

## What exists today

The repository currently includes:

- `crates/relay-server`: Rust API server, provider bridges, session state, and static web hosting
- `crates/relay-broker`: Rust broker service for remote transport, pairing, and
  public-mode auth/control
- `claude-worker/`: Node worker that bridges `@anthropic-ai/claude-agent-sdk`
  into the relay's session protocol
- `frontend/`: Vite-based web client source

The current implementation supports:

- **cross-agent review**: ask a second agent (any provider) to review the current
  changes in its own session and post findings back into the thread, single-shot
  or as a multi-round reviewer ↔ author loop until the reviewer approves
- **workflows (Code Flow)**: a saved execute → review → revise pipeline that
  loops until approval, running as a long-lived, persisted, backgroundable task
  that streams progress to any device and is reconciled to a safe, re-runnable
  state on relay restart
- starting a Codex or Claude Code session from the browser
- picking the provider per session from the launch panel
- listing saved threads scoped by workspace
- resuming a saved thread on the provider that owns it
- sending the next user turn from the active device
- streaming session updates over SSE
- handling approval requests from the web UI
- single-owner multi-device control with explicit `take over`
- approval decisions from any owner device
- controller lease and heartbeat handling
- configurable allowed workspace roots with enforced path restrictions
- surfacing locally available Codex and Claude Code models in the web UI
- optional API token auth with `RELAY_API_TOKEN`
- same-site relay auth cookies with CSRF protection for browser flows
- local session persistence for refresh and resume
- security mode plumbing for `private` and `managed`
- broker-backed remote pairing with signed device claims
- public broker enrollment, refresh, revoke, and revoke-others flows
- persisted public broker device grants for restart-safe remote access, backed
  by JSON for small/self-hosted deployments or Postgres for public broker deployments
- broker message compaction so large session snapshots fit websocket frame limits
- browser-managed remote device keys with `WebCrypto` + `IndexedDB` when available,
  with a compatibility fallback for weaker browser contexts
- broker-served remote shell with installable manifest; the live control surface avoids service worker caching

The current web UI is intentionally simple:

- chat-style thread view
- workspace-scoped history in the sidebar
- launch settings behind a details panel
- session details behind a collapsible drawer

## What is not done yet

The project is usable, but it is still early. It does not yet provide:

- workflow templates beyond **Code Flow** — Design Flow (design-doc artifact), a
  free-form graph editor for custom pipelines, and the long **task-list runner**
  are in progress, not shipped
- a formal event log with replay, cursor, and idempotency guarantees
- push notifications or native mobile apps
- team roles, org policy, or enterprise audit workflows
- cloud runners / remote execution targets
- providers beyond Codex and Claude Code
- a hardened multi-user product surface for untrusted tenants

## Roadmap direction

Near-term work is focused on going deeper on the trust-and-presence story:

- grow workflows past Code Flow: the **task-list runner** (run a whole list of
  tasks unattended, each as its own Code Flow), Design Flow, and a custom
  pipeline editor
- formalize the session and event model
- define replay, cursor, and idempotency behavior
- push notifications so long-running work can reach you when it needs a decision
- make mobile web approval and resume fast and honest
- strengthen device identity, pairing, and remote broker transport
- clarify `private` versus `managed` security modes

Longer-term, the plan is to grow from local-first control into:

- hosted relay and remote access
- stronger audit and policy controls
- native mobile only where the web hits real limits
- cloud execution targets and team workflows later

## License

This project is source-available under the Elastic License 2.0. See
[`LICENSE`](LICENSE).

## Contributions

By submitting a contribution, you agree to the contribution terms in
[`CONTRIBUTING.md`](CONTRIBUTING.md), including a broad license that allows the
maintainer to relicense contributions in the future.
