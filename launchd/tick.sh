#!/bin/sh
# #168. The tick runs main's bytes, never the tree a person is working in. This script lives in the
# pinned worktree (`cf_v2_tick`), whose `cf.db`, `.cf` and `node_modules` are symlinks to the one
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
  cd "$(dirname "$0")/.." || exit 1
  git fetch -q --no-tags origin main 2>/dev/null && git checkout -q --detach FETCH_HEAD 2>/dev/null
  node cli/cf.ts tick >/dev/null 2>&1 &
}
