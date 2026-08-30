#!/usr/bin/env bash
# Refuse to publish private crate material into the public repository.
#
# Two modes, because the question is different for each gate:
#
#   (default)  Inspect the WORKING TREE. Used by pre-commit and
#              `npm prepublishOnly`: those gates care about what is on disk
#              right now (about to be committed / packed).
#
#   --commits  Inspect the named COMMIT TREES. Used by pre-push: that gate
#              cares about what is about to leave the machine. A live
#              `with-private.sh` session leaves the real sources (and a dirty
#              Cargo.lock) on disk for as long as the relay is up — that is
#              the normal day-to-day state, and it must not block pushing a
#              commit that is itself the public stub.
#
# In both modes it looks for the STUB marker the stub carries and the private
# crate does not, rather than for a module name today's private crate happens
# to have. That way it fails CLOSED: anything unexpected — a module added on
# the private side, a half-finished swap, a rename — reads as "not the stub"
# and stops the publish. The other direction would fail open and say nothing.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
private_src="${RELAY_PRIVATE_PATH:-$root/../sealwire-private}"
crate_prefix="crates/sealwire-private/"

lock_has_private_deps() {
  local lock_text=$1
  printf '%s\n' "$lock_text" |
    grep -A3 '^name = "sealwire-private"$' |
    grep -q '^dependencies = \['
}

commit_tree_has_private_source() {
  local sha=$1
  local path candidate

  [[ -d "$private_src" ]] || return 1

  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    [[ "$path" == "${crate_prefix}STUB" ]] && continue
    candidate="$private_src/${path#"$crate_prefix"}"
    [[ -f "$candidate" ]] || continue
    if git -C "$root" show "${sha}:${path}" 2>/dev/null | cmp -s - "$candidate"; then
      printf '%s\n' "$path"
      return 0
    fi
  done < <(git -C "$root" ls-tree -r --name-only "$sha" -- "$crate_prefix")

  return 1
}

refuse_commit_tree() {
  local sha=$1
  local short leaked_path
  short=$(git -C "$root" rev-parse --short "$sha")

  if ! git -C "$root" cat-file -e "${sha}:crates/sealwire-private/STUB" 2>/dev/null; then
    cat >&2 <<EOF

REFUSING TO PUSH: commit $short is missing crates/sealwire-private/STUB.

  That commit's tree is not the public stub — private sources would leave
  the machine. Rewrite or drop it before pushing.

EOF
    exit 1
  fi

  if git -C "$root" cat-file -e "${sha}:Cargo.lock" 2>/dev/null; then
    if lock_has_private_deps "$(git -C "$root" show "${sha}:Cargo.lock")"; then
      cat >&2 <<EOF

REFUSING TO PUSH: commit $short's Cargo.lock carries the private crate's
dependencies.

  A build under with-private.sh wrote them into that commit. Drop or rewrite
  that commit before pushing — a clean tip does not erase a bad ancestor.

EOF
      exit 1
    fi
  fi

  if leaked_path=$(commit_tree_has_private_source "$sha"); then
    cat >&2 <<EOF

REFUSING TO PUSH: commit $short contains the private source itself.

  $leaked_path
  is byte-identical to $private_src/${leaked_path#"$crate_prefix"}

  STUB being present does not make that safe. Rewrite or drop the commit
  before pushing.

EOF
    exit 1
  fi
}

if [[ "${1:-}" == "--commits" ]]; then
  shift
  for sha in "$@"; do
    [[ -n "$sha" ]] || continue
    refuse_commit_tree "$sha"
  done
  exit 0
fi

# Working-tree mode (pre-commit / prepublishOnly).
#
# The lock file leaks separately from the sources. A build with the private
# crate writes its dependency list into the public `Cargo.lock`, and the stub
# — which has no dependencies at all — leaves that entry bare. So a
# `dependencies = [` under it means a swapped build's lock is about to be
# committed, even if the sources themselves were restored.
if [[ -f "$root/Cargo.lock" ]] &&
   lock_has_private_deps "$(cat "$root/Cargo.lock")"; then
  cat >&2 <<EOF

REFUSING TO COMMIT: Cargo.lock carries the private crate's dependencies.

  A build under with-private.sh wrote them there. Restore it with:
    git checkout -- Cargo.lock

EOF
  exit 1
fi

if [[ ! -f "$root/crates/sealwire-private/STUB" ]]; then
  cat >&2 <<EOF

REFUSING TO COMMIT: crates/sealwire-private/ is not the public stub.

  Its STUB marker file is missing, which means the private sources are in the
  tree — a with-private.sh run was probably killed before it could restore.

  If a private-enabled dev server is running, stop it normally (Ctrl-C) and the
  swap trap will restore the stub. If the previous run crashed, heal it with:

    scripts/with-private.sh true

  To commit public work without stopping the relay, use:
    scripts/commit.sh -m "..."

EOF
  exit 1
fi
