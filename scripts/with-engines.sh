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

# Escape hatch for a public checkout, which has no engines to swap in. Off by
# default and deliberately explicit: the scripts that route through here are the
# ones that start long-running task lists, and a relay that came up quietly
# without them would refuse every start while looking perfectly healthy.
if [[ "${RELAY_NO_ENGINES:-}" == "1" ]]; then
  exec "$@"
fi

if [[ ! -f "$engines_src/Cargo.toml" ]]; then
  cat >&2 <<EOF
with-engines: no orchestration engines at $engines_src

  Task lists and task teams need the private engines. Either:
    - clone them next to this repo, or set RELAY_ENGINES_PATH, or
    - RELAY_NO_ENGINES=1 <your command>   (starts without them; long tasks refuse)

  See PRIVATE_ENGINES.md.
EOF
  exit 1
fi
if [[ ! -d "$target" ]]; then
  echo "with-engines: expected the stub crate at $target" >&2
  exit 1
fi

stash="$(mktemp -d)"
cp -R "$target" "$stash/stub"

# Ignore further signals while restoring. The window between removing the private
# crate and putting the stub back is short, but a second Ctrl-C landing inside it
# leaves the tree with neither — which looks like a deleted stub and is confusing
# to diagnose. Swap into place from a sibling directory so the tree is never
# without a crate for longer than a rename.
restore() {
  trap '' INT TERM
  if [[ -d "$stash/stub" ]]; then
    rm -rf "$target.swapping"
    cp -R "$stash/stub" "$target.swapping"
    rm -rf "$target"
    mv "$target.swapping" "$target"
  fi
  rm -rf "$stash"
}
trap restore EXIT INT TERM

rm -rf "$target"
cp -R "$engines_src" "$target"
rm -rf "$target/.git" "$target/Cargo.lock"
# The private checkout points at the relay by a path that only makes sense from
# outside the workspace; in here it is a plain sibling crate.
perl -pi -e 's{path = "\.\./agent-relay/crates/relay-api"}{path = "../relay-api"}' "$target/Cargo.toml"

# Run the command in the BACKGROUND and wait on it, forwarding signals.
#
# Not `exec` and not a foreground call: bash defers a trap until the command in
# progress returns, so a `kill` aimed at this script while a long-running dev
# server was in the foreground would sit there doing nothing, and the restore
# would not happen until the server exited on its own. Ctrl-C happens to work
# either way — it goes to the whole process group — which is exactly what makes
# the foreground version look correct until the day something sends a plain TERM.
"$@" &
child=$!
trap 'kill -TERM "$child" 2>/dev/null' INT TERM
wait "$child"
status=$?
trap - INT TERM
exit "$status"
