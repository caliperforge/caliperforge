#!/bin/sh
# #168. The tick runs main's bytes, never the tree a person is working in. This script lives in the
# pinned worktree (`cf_v2_tick`), whose `cf.db` and `.cf` are symlinks to the one
# canonical tree: the code is pinned, the state is shared.
#
# The braces are load-bearing: `sh` reads the whole group before running any of it, and the checkout
# below rewrites this very file. Without them a refresh mid-run could truncate the script.
#
# A fetch that cannot reach the remote leaves the last good pinned code in place and the tick still
# fires. Installing this script anywhere but the pinned worktree points the checkout at a tree people
# work in, which is the failure it exists to remove.
{
  # launchd's PATH (the plist) has no ~/.cargo/bin; without it every cargo call from a seat or step 3 is ENOENT (#204)
  PATH="$HOME/.cargo/bin:$PATH"
  export PATH
  # One Rust build folder for every job: a fresh clone reuses the compiled dependencies instead of
  # building all of them again (a surfpool job left 8.5 GB and minutes of every core behind). Cargo locks
  # the folder, so two Rust builds take turns rather than fight for the cores.
  CARGO_TARGET_DIR="$HOME/.cf-cache/cargo-target"
  export CARGO_TARGET_DIR
  cd "$(dirname "$0")/.." || exit 1
  # Never FETCH_HEAD: this worktree shares its repo with every job's git, and on 09-25 a whole-remote fetch
  # landed between these two lines, so FETCH_HEAD's first line was a 09-22 branch. The tick checked it out,
  # and that commit's tick.sh had no fetch, so the tree stayed there all night. The tree only moves
  # forward: a commit that is not ahead of the one it holds is left alone.
  was=$(git rev-parse -q --verify HEAD 2>/dev/null)
  git fetch -q --no-tags origin +refs/heads/main:refs/remotes/origin/main 2>/dev/null
  main=$(git rev-parse -q --verify refs/remotes/origin/main 2>/dev/null)
  if [ -n "$main" ] && git merge-base --is-ancestor HEAD "$main" 2>/dev/null; then
    git checkout -q --detach "$main" 2>/dev/null
  fi
  mkdir -p .cf
  # launchd's PATH (the plist) has no cf; without it a seat's `cf look` is "command not found" (#879)
  mkdir -p .cf/bin
  printf '#!/bin/sh\nexec node "$HOME/cf_v2_tick/cli/cf.ts" "$@"\n' > .cf/bin/cf.new && chmod +x .cf/bin/cf.new && mv .cf/bin/cf.new .cf/bin/cf
  PATH="$PWD/.cf/bin:$PATH"
  # Cut in place, never `mv`: the last minute's tick may still be appending to this file.
  if [ -f .cf/tick.log ] && [ "$(wc -l < .cf/tick.log)" -gt 5000 ]; then
    tail -n 5000 .cf/tick.log > .cf/tick.log.tail && cat .cf/tick.log.tail > .cf/tick.log
    rm -f .cf/tick.log.tail
  fi
  lock=$(git hash-object package-lock.json 2>/dev/null)
  if [ -n "$lock" ] && [ "$lock" != "$(cat .cf/deps.lock.sha 2>/dev/null)" ]; then
    # launchd's NODE_ENV=production would drop the dev dependencies the tick imports.
    if npm ci --include=dev >/dev/null 2>&1; then
      echo "$lock" > .cf/deps.lock.sha
    else
      git checkout -q --detach "$was" 2>/dev/null
      echo "deps npm ci failed for lockfile $lock, back on $was" >> .cf/tick.log
    fi
  fi
  node cli/cf.ts tick >>.cf/tick.log 2>&1 &
}
