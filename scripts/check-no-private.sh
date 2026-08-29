#!/usr/bin/env bash
# Refuse to commit while the private crate is swapped into the public tree.
#
# `scripts/with-private.sh` restores the stub from a trap, and that covers a clean
# exit, a failing command and Ctrl-C. It cannot cover SIGKILL, a machine losing
# power, or a shell that never runs the trap — and the mistake it would leave
# behind is the one no revert undoes, because the sources would already be in a
# public commit. So this check does not depend on any of that: it just looks.
#
# It looks for the STUB marker the stub carries and the private crate does not,
# rather than for a module name today's private crate happens to have. That way it
# fails CLOSED: anything unexpected in that directory — a module added on the
# private side, a half-finished swap, a rename — reads as "not the stub" and stops
# the commit. The other direction would fail open and say nothing.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The lock file leaks separately from the sources. A build with the private crate
# writes its dependency list into the public `Cargo.lock`, and the stub — which
# has no dependencies at all — leaves that entry bare. So a `dependencies = [`
# under it means a swapped build's lock is about to be committed, even if the
# sources themselves were restored.
if [[ -f "$root/Cargo.lock" ]] &&
   grep -A3 '^name = "sealwire-private"$' "$root/Cargo.lock" | grep -q '^dependencies = \['; then
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

EOF
  exit 1
fi
