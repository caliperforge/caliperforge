import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { CARRY, git, maybe, planDir, put } from './workspace.ts'

/** A split parent's builder diff, which its first part that is not a measure part is cut with. */
export const PARENT = 'parent.diff'

/** A fresh cut of `branch` at `head`, with the split parent's diff applied unless a recut carries the plan's own. */
export function cut(root: string, plan: number, dir: string, branch: string, head: string): void {
  git(dir, ['checkout', '-B', branch, head])
  if (maybe(root, plan, PARENT) !== null && maybe(root, plan, CARRY) === null) applied(dir, join(planDir(root, plan), PARENT))
  put(root, plan, 'base.sha', `${head}\n`)
}

/** A throw removes `dir`, as `prBranch` does: a clone left on bare `main` would be reused on the next tick. */
function applied(dir: string, patch: string): void {
  try {
    git(dir, ['apply', patch])
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`${PARENT} does not apply: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}
