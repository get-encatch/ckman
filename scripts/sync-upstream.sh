#!/usr/bin/env bash
# Merge housepower/ckman main into a sync branch off encatch/main (see FORK.md).
# Usage: scripts/sync-upstream.sh   (run from a clean checkout of get-encatch/ckman)
set -euo pipefail

UPSTREAM_URL=https://github.com/housepower/ckman.git

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is not clean; commit or stash first" >&2
  exit 1
fi

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"
git fetch upstream main
git fetch origin

# origin/main stays a pure mirror of upstream (fast-forward only).
git push origin upstream/main:refs/heads/main

branch="sync/upstream-$(date +%Y%m%d-%H%M)"
git switch -c "$branch" origin/encatch/main

if ! git merge --no-ff --no-edit -m "Merge housepower/ckman main into encatch/main" upstream/main; then
  # Upstream keeps the Vue UI as the frontend/ submodule; this fork replaced it
  # with web/, so drop any upstream change to the submodule.
  git rm -q --cached -r --ignore-unmatch frontend
  git rm -q -f --ignore-unmatch .gitmodules
  rmdir frontend 2>/dev/null || true

  if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
    echo
    echo "Resolve these conflicts, then: git commit && git push -u origin $branch" >&2
    git diff --name-only --diff-filter=U >&2
    exit 1
  fi
  git commit --no-edit
fi

git push -u origin "$branch"
echo
echo "Now open a PR: $branch -> encatch/main (merge commit, not squash/rebase)."
