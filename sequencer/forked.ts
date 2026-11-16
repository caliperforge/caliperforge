import type { Db } from '../store/index.ts'
import { opened } from '../store/ready.ts'
import { git, maybe, put } from './workspace.ts'

/** The fork branch the pull request opens from, saved when our fork already held the plan's branch before any pull request. */
const FORKED = 'fork.branch'

/** The saved fork branch, else `branch`; step 8 reads it and never chooses one. */
export function forkedAs(root: string, plan: number, branch: string): string {
  return maybe(root, plan, FORKED)?.trim() ?? branch
}

/** A branch our fork held before any pull request only moves forward, so the squash goes out under the first free `<branch>-<n>`. */
export function forkBranch(db: Db, root: string, plan: number, dir: string, branch: string): string {
  const saved = maybe(root, plan, FORKED)?.trim()
  if (saved !== undefined) return saved
  if (opened(db, plan) !== null || !onFork(dir, branch)) return branch
  let n = 2
  while (onFork(dir, `${branch}-${String(n)}`)) n += 1
  const name = `${branch}-${String(n)}`
  put(root, plan, FORKED, name)
  return name
}

export function onFork(dir: string, branch: string): boolean {
  return git(dir, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]).trim() !== ''
}
