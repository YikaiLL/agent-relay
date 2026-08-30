#!/usr/bin/env bash
# Commit from a tree that has the private crate swapped in.
#
#   scripts/commit.sh -m "Fix the thing"
#   scripts/commit.sh            # opens your editor, like plain git commit
#
# Everything after the script name is passed to `git commit` untouched.
#
# ## Why this exists
#
# While `npm run dev:full` is running, `crates/sealwire-private/` holds the REAL
# private sources, and `check-no-private.sh` refuses every commit — correctly,
# because that directory must never reach a public commit. The remedy it prints
# ("stop the dev server") is right and often impractical: the relay being stopped
# is frequently the thing you are using to work.
#
# So agents reached for `git commit --no-verify`, which commits whatever is in
# the index with no check at all. That is the one mistake in this repo a revert
# does not undo. This script exists so the safe path is the easy one.
#
# ## What it does
#
# Puts the stub back for the length of one commit, runs `git commit` with the
# hook ACTIVE and unmodified, then restores the private sources from a snapshot
# it took on the way in. Its only lasting effect is the commit.
#
# It restores from a SNAPSHOT rather than by re-copying the private checkout, so
# uncommitted edits made directly to `crates/sealwire-private/` survive — those
# edits belong in `~/git/sealwire-private`, but destroying them here would be a
# nasty way to find that out.
#
# ## The check the commit hook cannot do
#
# `check-no-private.sh` inspects the WORKING TREE: it refuses when the STUB
# marker is missing. This script's whole trick is to make the working tree be
# the stub — restored from the INDEX — before the hook runs. So a private source
# file that somebody staged would be written into the working tree by that
# restore, the marker would still be present, and the hook would wave it through.
#
# The hook is not wrong; it was never asked about the index. This script has to
# ask, and it asks the only question that is actually decisive: is this staged
# blob byte-identical to a file in the private checkout? If it is, it is the
# private source, whatever its path says.
#
# Staging a genuine placeholder is legitimate and expected — every new public
# seam needs one — so that is allowed, and only exact matches are refused.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$repo_root/crates/sealwire-private"
private_src="${RELAY_PRIVATE_PATH:-$repo_root/../sealwire-private}"
crate_prefix="crates/sealwire-private/"

# Not swapped: nothing to arrange, and the hook already covers this case. `exec`
# so the editor, the exit status and any signals belong to git rather than to a
# wrapper standing in the middle of them.
if [[ -f "$target/STUB" ]]; then
  exec git -C "$repo_root" commit "$@"
fi

if [[ ! -d "$target" ]]; then
  echo "commit: expected a crate at $target" >&2
  exit 1
fi

# Everything staged under the private crate, checked one blob at a time.
staged_private="$(git -C "$repo_root" diff --cached --name-only -- "$crate_prefix" || true)"
if [[ -n "$staged_private" ]]; then
  if [[ ! -d "$private_src" ]]; then
    # No checkout to compare against, so the decisive question cannot be asked.
    # Refuse rather than guess: a wrong "allow" here is unrecoverable, a wrong
    # "refuse" costs one message.
    cat >&2 <<EOF

REFUSING TO COMMIT: $crate_prefix is staged and there is no private checkout
to compare it against (looked in $private_src).

  Unstage it, or set RELAY_PRIVATE_PATH so this can be verified:
    git restore --staged $crate_prefix

EOF
    exit 1
  fi
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    candidate="$private_src/${path#"$crate_prefix"}"
    [[ -f "$candidate" ]] || continue
    if git -C "$repo_root" show ":$path" 2>/dev/null | cmp -s - "$candidate"; then
      cat >&2 <<EOF

REFUSING TO COMMIT: a staged file is the private source itself.

  $path
  is byte-identical to $candidate

  This is what the swap puts in the tree; only its public placeholder belongs
  in a commit. Unstage it with:

    git restore --staged $path

EOF
      exit 1
    fi
  done <<<"$staged_private"
fi

# Snapshot what we are about to move aside. Restored from a trap, so it happens
# on a refused commit, an abandoned commit message and Ctrl-C — not only when
# git succeeds. As with with-private.sh, SIGKILL is the one case no trap covers;
# `scripts/with-private.sh true` heals a tree left that way.
stash="$(mktemp -d)"
cp -R "$target" "$stash/private"
lock_saved=""
if [[ -f "$repo_root/Cargo.lock" ]]; then
  cp "$repo_root/Cargo.lock" "$stash/Cargo.lock"
  lock_saved=1
fi

restore() {
  trap '' INT TERM
  if [[ -d "$stash/private" ]]; then
    rm -rf "$target.restoring"
    cp -R "$stash/private" "$target.restoring"
    rm -rf "$target"
    mv "$target.restoring" "$target"
  fi
  if [[ -n "$lock_saved" ]]; then
    cp "$stash/Cargo.lock" "$repo_root/Cargo.lock"
  fi
  rm -rf "$stash"
}
trap restore EXIT INT TERM

# The stub, taken from the INDEX. `rm -rf` first because `git checkout` only
# writes tracked paths, and the private checkout carries modules the stub has
# never heard of — left behind, they would still be sitting in the tree while
# the hook decided the tree was clean.
rm -rf "$target"
git -C "$repo_root" checkout -- "$crate_prefix"

# A build under the swap writes the private crate's dependency list into the
# public lock, which the hook refuses on its own terms. Restoring it is the
# remedy that hook prints; the snapshot above puts the swapped one back after.
if grep -A3 '^name = "sealwire-private"$' "$repo_root/Cargo.lock" 2>/dev/null |
   grep -q '^dependencies = \['; then
  git -C "$repo_root" checkout -- Cargo.lock
fi

# Belt and braces. If the stub the index just produced has no marker, something
# is staged that should not be, and the hook is about to be asked the wrong
# question — stop before it can answer it.
if [[ ! -f "$target/STUB" ]]; then
  cat >&2 <<EOF

REFUSING TO COMMIT: the index does not describe the public stub.

  Restoring $crate_prefix from the index produced a tree with no STUB marker,
  which means the staged content is not the placeholder. Inspect it with:

    git diff --cached -- $crate_prefix

EOF
  exit 1
fi

git -C "$repo_root" commit "$@"
