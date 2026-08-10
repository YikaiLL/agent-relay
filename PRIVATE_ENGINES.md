# Private orchestration engines

The relay in this repository is complete and buildable on its own. What it does
**not** contain is the orchestration engines — the layer that decides what a long
running agent arrangement does next and how it phrases that to the agent. Those
live in a separate private repository and are linked in only for release builds.

Everything else is here: the transport, the end-to-end encryption, the broker (which
is a blind relay and never sees a decrypted payload), the run records, the HTTP
surface, and the driver that executes whatever the engines decide.

```
crates/relay-api             the seam — shared records and traits, no logic
crates/relay-orchestrators   a STUB in this repo; the real crate is private
crates/relay-server          the relay: records, driver, routes, persistence
```

## What a public checkout gets

| | |
|---|---|
| `cargo build` / `cargo test --workspace` | works, no engines registered |
| `cargo build --features orchestrators` | **fails on purpose** — this checkout has no engines, and a stub that silently satisfied the feature would ship a relay whose task teams quietly do nothing |
| `npm run test:task-team` | skips itself, with a message saying why |
| Task list / task team at runtime | `start_team` refuses with a clear error |

Everything else — sessions, threads, review, workflow, pairing, the broker
protocol, the crypto — runs and is tested normally.

---

# Setup checklist

Steps only a maintainer can do. Nothing here is needed to build or audit the relay.

## 1. Create the private repository

GitHub → New repository → `sealwire/relay-orchestrators` → **Private**.
Do not initialise it with any files.

The organisation rather than a personal account: `sealwire/sealwire` already lives
there, the IP stays with the company rather than an individual, and moving a repo
later means reconfiguring collaborators, secrets and deploy keys. There is no cost
difference, and Actions minutes are billed to the *public* repo that runs the
workflow, which has none.

## 2. Generate a deploy key — outside any repository

```bash
cd "$(mktemp -d)" && pwd     # note this path, you delete it in step 5
ssh-keygen -t ed25519 -f engines-key -N "" -C "relay-orchestrators deploy key"
```

Not under `~/git/`: a key generated inside a working tree can be committed by
accident, and this one reads the engines.

## 3. Public key → the private repo, read only

```bash
cat engines-key.pub
```

`sealwire/relay-orchestrators` → Settings → Deploy keys → Add deploy key

- Title: `CI read-only`
- Key: the output above
- **Leave "Allow write access" unchecked.**

A deploy key is scoped to one repository. A personal access token would be scoped
to *you* — a much larger blast radius for the same job.

## 4. Private key → the public repo's Actions secret

```bash
cat engines-key
```

`sealwire/sealwire` → Settings → Secrets and variables → **Actions** → New
repository secret

- Name: `RELAY_ENGINES_DEPLOY_KEY`
- Secret: the output above, including the `-----BEGIN` and `-----END` lines

GitHub stores it encrypted and never shows it again — not even to you — and masks
it in logs.

## 5. Destroy the local copy

```bash
rm -rf "$(pwd)"      # the temp directory from step 2
```

No backup is needed. To rotate, generate a new pair and delete the old deploy key.

## 6. Push the engines

```bash
cd ../relay-orchestrators
git remote add origin git@github.com:sealwire/relay-orchestrators.git
git push -u origin main
```

---

# Working with the engines locally

The private checkout is expected at `../relay-orchestrators`, or wherever
`RELAY_ENGINES_PATH` points.

```bash
scripts/with-engines.sh cargo test --workspace --features relay-server/orchestrators
scripts/with-engines.sh npm run test:task-team
scripts/with-engines.sh cargo build --release -p relay-server --features orchestrators
```

The script copies the private crate over the stub for the duration of one command
and puts the stub back from a trap — on success, on failure, and on Ctrl-C. Check
`git status` before committing anyway; the one mistake here that a revert cannot
undo is leaving the real sources in a public working tree.

## What CI runs

| Trigger | Unit tests | Task-team e2e |
|---|---|---|
| `pull_request` (including forks) | 1141, no secret in scope | skipped, says so |
| `push` / `schedule` / manual | 1212, real engines | runs for real |
| No secret configured | 1141 | skipped |

The engines are deliberately **not** checked out on `pull_request`. Forks never
receive secrets — GitHub enforces that — but a pull request from a branch in this
repository would, so a workflow edit could print the engines into a public log.
Push and schedule cover the same code minutes later.

**The exposure is exactly "who has write access to `sealwire/sealwire`."** While
that is one person this is fine. Before adding anyone, either trust them with the
engines or move the release pipeline into the private repository (see below).

## When to restructure

The industry-standard shape is the reverse of this one: the public repository knows
nothing about the private one, and the private repository depends on the public one
and produces the shipping binary — Grafana, Sentry and Chromium all work that way.
That shape needs no deploy key in a public repository at all.

Getting there means splitting `relay-server` into a library plus a thin binary, so
the private repository can build its own. `main.rs` uses roughly ten `AppState`
methods and seven types directly, so the visibility sweep is tens of items, not
hundreds — a day's work, compiler-driven.

Worth doing when either becomes true:

- someone other than the maintainer needs write access to the public repository
- a competitor makes tracking release-over-release changes worth their time

Until then this arrangement is smaller and already verified.

## What this protects, honestly

Not secrecy. A user can open any agent's transcript from the team card, and the
provider CLIs write their own session files to disk, so the prompts a run uses are
visible to anyone who runs one. The relay ships as a binary to user machines, and
the Elastic 2.0 licence — not obscurity — is what stops a competitor reselling it.

What a private repository does protect is the **history**: which prompts changed,
when, why, and what was tried and abandoned. That is the part worth having, it only
exists in git, and it is the part that is genuinely hard to reconstruct.
