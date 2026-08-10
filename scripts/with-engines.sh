#!/usr/bin/env bash
# Run a command against the REAL orchestration engines.
#
#   scripts/with-engines.sh cargo test --workspace --features relay-server/orchestrators
#
# The public repo carries a stub at `crates/relay-orchestrators` so anyone can
# build and audit the relay without the proprietary engines. This script swaps the
# private checkout into that path for the duration of one command, then puts the
# stub back.
#
# Restore runs from a trap, so it happens on failure, on Ctrl-C, and on a test that
# panics — not only on the happy path. Leaving the real sources in a public working
# tree is the one mistake here a revert cannot undo.
#
# The stub is restored from a copy this script takes, NOT from git: an earlier
# version used `git checkout` + `git clean`, which deleted the stub outright on a
# tree where it was not committed yet.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
engines_src="${RELAY_ENGINES_PATH:-$repo_root/../relay-orchestrators}"
target="$repo_root/crates/relay-orchestrators"

if [[ ! -f "$engines_src/Cargo.toml" ]]; then
  echo "with-engines: no private engines at $engines_src" >&2
  echo "  set RELAY_ENGINES_PATH, or run without the orchestrators feature." >&2
  exit 1
fi
if [[ ! -d "$target" ]]; then
  echo "with-engines: expected the stub crate at $target" >&2
  exit 1
fi

stash="$(mktemp -d)"
cp -R "$target" "$stash/stub"

restore() {
  rm -rf "$target"
  cp -R "$stash/stub" "$target"
  rm -rf "$stash"
}
trap restore EXIT INT TERM

rm -rf "$target"
cp -R "$engines_src" "$target"
rm -rf "$target/.git" "$target/Cargo.lock"
# The private checkout points at the relay by a path that only makes sense from
# outside the workspace; in here it is a plain sibling crate.
perl -pi -e 's{path = "\.\./agent-relay/crates/relay-api"}{path = "../relay-api"}' "$target/Cargo.toml"

"$@"
