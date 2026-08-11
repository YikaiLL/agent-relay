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
if [[ ! -f "$root/crates/sealwire-private/STUB" ]]; then
  cat >&2 <<EOF

REFUSING TO COMMIT: crates/sealwire-private/ is not the public stub.

  Its STUB marker file is missing, which means the private sources are in the
  tree — a with-private.sh run was probably killed before it could restore.

  Restore it with:
    rm -rf crates/sealwire-private && git checkout -- crates/sealwire-private

EOF
  exit 1
fi
