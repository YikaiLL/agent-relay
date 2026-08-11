#!/usr/bin/env bash
# Refuse to commit while the private orchestration engines are swapped into the
# public tree.
#
# `scripts/with-engines.sh` restores the stub from a trap, and that covers a clean
# exit, a failing command and Ctrl-C. It cannot cover SIGKILL, a machine losing
# power, or a shell that never runs the trap — and the mistake it would leave
# behind is the one no revert undoes, because the sources would already be in a
# public commit. So this check does not depend on any of that: it just looks.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -d "$root/crates/relay-orchestrators/src/team" ]] ||
   [[ -d "$root/crates/relay-orchestrators/src/task_list" ]]; then
  cat >&2 <<EOF

REFUSING TO COMMIT: the private orchestration engines are in the public tree.

  crates/relay-orchestrators/ should hold the stub, not the real crate. A
  with-engines.sh run was probably killed before it could restore.

  Restore it with:
    rm -rf crates/relay-orchestrators && git checkout -- crates/relay-orchestrators

EOF
  exit 1
fi
