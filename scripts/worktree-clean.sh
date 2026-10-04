#!/usr/bin/env bash
# Remove git worktrees whose work is finished. Dry run unless --apply.
#
#   scripts/worktree-clean.sh            list what would be removed and why others are kept
#   scripts/worktree-clean.sh --apply    remove them (worktree dir only; the branch is kept)
#   scripts/worktree-clean.sh --apply --delete-branches   also delete the local branch
#
# A worktree counts as done only when ALL hold:
#   - it is clean (no modified or untracked files),
#   - it is on a branch whose HEAD is covered by the head of a MERGED PR for that branch
#     (the repo squash-merges, so ancestry alone would call merged work unmerged).
# Ignored files other than node_modules/dist/coverage also block removal (they can be notes or data).
# Anything else is kept and the reason printed. Entries whose directory is gone (moved or
# deleted by hand) are pruned from git's registry. The main checkout is never touched.
#
# Convention: create worktrees as /Volumes/Dev/wt-<name>, outside the repo, so they stay on the
# external drive and out of the main checkout:
#   git worktree add -b feat/x /Volumes/Dev/wt-x origin/main
set -euo pipefail

apply=0; del_branches=0
for a in "$@"; do
  case "$a" in
    --apply) apply=1 ;;
    --delete-branches) del_branches=1 ;;
    *) echo "usage: worktree-clean.sh [--apply] [--delete-branches]" >&2; exit 2 ;;
  esac
done

repo=$(git rev-parse --show-toplevel)
main_wt=$(git -C "$repo" worktree list --porcelain | awk '/^worktree /{print $2; exit}')
git -C "$main_wt" fetch -q origin || echo "warning: fetch failed; merge state may be stale" >&2

removed=0; kept=0
decide() {  # $1=path $2=branch $3=head ; echoes "REMOVE <why>" or "KEEP <why>"
  local path=$1 branch=$2 head=$3 oid
  # Fail closed: if git cannot read the worktree (e.g. its .git pointer references a moved repo),
  # an empty status is an error, not "clean". Fix with `git worktree repair <path>`.
  local st
  st=$(git -C "$path" status --porcelain --ignored 2>&1) || { echo "KEEP git cannot read it (try: git worktree repair $path)"; return; }
  [ -z "$(printf '%s\n' "$st" | grep -v -E '^!! ((node_modules|dist|coverage)/?|.*\.tsbuildinfo)$')" ] \
    || { echo "KEEP uncommitted or ignored files (git status --ignored)"; return; }
  [ -n "$branch" ] || { echo "KEEP detached HEAD (cannot tell finished from fresh)"; return; }
  while read -r oid; do
    [ -n "$oid" ] && git -C "$main_wt" merge-base --is-ancestor "$head" "$oid" 2>/dev/null \
      && { echo "REMOVE covered by a merged PR"; return; }
  done < <(gh pr list --head "$branch" --state merged --json headRefOid --jq '.[].headRefOid' 2>/dev/null)
  # A branch sitting inside origin/main with no merged PR is either brand new (no commits yet)
  # or was merged without a PR; the script cannot tell, so it never removes it on its own.
  if git -C "$main_wt" merge-base --is-ancestor "$head" origin/main 2>/dev/null; then
    echo "KEEP no merged PR; fresh worktree or merged without one (remove by hand if done)"; return
  fi
  echo "KEEP commits not in origin/main or a merged PR"
}

while IFS='|' read -r path branch head prunable; do
  [ "$path" = "$main_wt" ] && continue
  name=$(basename "$path")
  if [ "$prunable" = 1 ] || [ ! -d "$path" ]; then
    echo "PRUNE  $name (directory missing)"
    [ $apply = 1 ] && git -C "$main_wt" worktree prune
    continue
  fi
  verdict=$(decide "$path" "$branch" "$head")
  case "$verdict" in
    REMOVE*)
      echo "REMOVE $name  (${verdict#REMOVE })"; removed=$((removed+1))
      if [ $apply = 1 ]; then
        # one failure must not abort the rest; git itself also refuses dirty trees (never --force)
        if git -C "$main_wt" worktree remove "$path"; then
          [ $del_branches = 1 ] && [ -n "$branch" ] && git -C "$main_wt" branch -D "$branch" >/dev/null
        else
          echo "FAILED to remove $name; left in place" >&2
        fi
      fi ;;
    *) echo "keep   $name  (${verdict#KEEP })"; kept=$((kept+1)) ;;
  esac
done < <(git -C "$main_wt" worktree list --porcelain | awk -v RS= -F'\n' '{
  p="";b="";h="";pr=0
  for(i=1;i<=NF;i++){
    if($i~/^worktree /)p=substr($i,10); else if($i~/^HEAD /)h=substr($i,6)
    else if($i~/^branch /){b=substr($i,8); sub("refs/heads/","",b)} else if($i~/^prunable/)pr=1 }
  print p"|"b"|"h"|"pr }')

[ $apply = 1 ] || echo "(dry run; re-run with --apply to remove)"
echo "$removed removable, $kept kept"
