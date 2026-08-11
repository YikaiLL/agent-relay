#!/usr/bin/env bash
# Run a command against the REAL private crate.
#
#   scripts/with-private.sh cargo test --workspace --features relay-server/private
#
# The public repo carries a stub at `crates/sealwire-private` so anyone can build
# and audit the relay without the proprietary sources. This script swaps the
# private checkout into that path for the duration of one command, then puts the
# stub back.
#
# One crate, whatever is in it. Everything that has to stay closed lives in
# `sealwire-private` as another module rather than as a second hidden crate, so
# this script never grows a list of things to swap.
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
private_src="${RELAY_PRIVATE_PATH:-$repo_root/../sealwire-private}"
target="$repo_root/crates/sealwire-private"

# Escape hatch for a public checkout, which has no private crate to swap in. Off by
# default and deliberately explicit: the scripts that route through here are the
# ones that start long-running task lists, and a relay that came up quietly
# without them would refuse every start while looking perfectly healthy.
if [[ "${RELAY_PUBLIC_ONLY:-}" == "1" ]]; then
  exec "$@"
fi

if [[ ! -f "$private_src/Cargo.toml" ]]; then
  cat >&2 <<EOF
with-private: no private crate at $private_src

  Task lists and task teams need it. Either:
    - clone it next to this repo, or set RELAY_PRIVATE_PATH, or
    - RELAY_PUBLIC_ONLY=1 <your command>   (starts without it; long tasks refuse)

  See PRIVATE_CRATE.md.
EOF
  exit 1
fi
if [[ ! -d "$target" ]]; then
  echo "with-private: expected the stub crate at $target" >&2
  exit 1
fi

stash="$(mktemp -d)"
cp -R "$target" "$stash/stub"
# The lock file too. A build with the private crate writes ITS dependency list
# into the public `Cargo.lock`, which is both a dirty tree after every run and a
# slow leak of exactly the thing a private repository is for: not the names
# themselves, but which ones changed and when. The cost is that a `cargo add` made
# during a session under this script is reverted with everything else — do that in
# a plain checkout.
if [[ -f "$repo_root/Cargo.lock" ]]; then
  cp "$repo_root/Cargo.lock" "$stash/Cargo.lock"
fi

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
  if [[ -f "$stash/Cargo.lock" ]]; then
    cp "$stash/Cargo.lock" "$repo_root/Cargo.lock"
  fi
  rm -rf "$stash"
}
trap restore EXIT INT TERM

rm -rf "$target"
cp -R "$private_src" "$target"
rm -rf "$target/.git" "$target/Cargo.lock"
# Belt and braces: the private repo must not carry the stub's marker file, because
# everything else keys "is the private crate in the tree" off its absence. Copying
# one in would make the guard wave the real sources straight through.
rm -f "$target/STUB"
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
