import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { refuse } from '../runner/index.ts'
import { seat } from '../runner/rules.ts'
import { filesOf } from '../store/files.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import type { Step } from '../templates/pr-path.ts'
import { deletions } from './fence.ts'
import { kernelPlan } from './home.ts'
import type { Outcome } from './kind.ts'
import { fenceFor } from './route.ts'
import { cloned, holds, maybe, srcDir } from './workspace.ts'

/**
 * The build names paths under `## Deleted` and the kernel removes them, before the rails read the
 * tree. A build removes only what it made, or a base file its brief lists: a path inside the fence -- the same
 * `refuse()` the seat's own tools run through -- or one git ignores, that is in the tree, not under `.git`, and
 * not on the base commit unless the brief lists it exactly.
 */
export function dropped(db: Db, root: string, plan: PlanRow, step: Step, handback: string): Outcome | null {
  const { paths, unread } = deletions(handback)
  if (unread.length > 0) return { outcome: 'refuse', spans: unread, note: `${step.runs}: ${unread.map((r) => `${r} names no path`).join('; ')}` }
  if (paths.length === 0) return null
  const src = srcDir(root, plan.id)
  const top = realpathSync.native(src)
  const rel = (path: string): string => relative(top, realpathSync.native(resolve(top, path)))
  const base = maybe(root, plan.id, 'base.sha')?.trim()
  const fence = fenceFor(db, plan.id, seat(root, step.runs).manifest.write_paths)
  const barred = paths.filter((path) => refuse(src, fence, path, kernelPlan(plan)) !== null && !ignored(src, path, rel))
  const absent = paths.filter((path) => !barred.includes(path) && !existsSync(join(src, path)))
  const rest = paths.filter((path) => !barred.includes(path) && !absent.includes(path))
  const git = rest.filter((path) => rel(path) === '.git' || rel(path).startsWith('.git/'))
  const listed = filesOf(db, plan.id).map((f) => f.path)
  const based = rest.filter((path) => !git.includes(path) && !listed.includes(rel(path)) && base !== undefined && cloned(src) && holds(src, `${base}:${rel(path)}`))
  if (barred.length > 0 || absent.length > 0 || git.length > 0 || based.length > 0) {
    const why = [...barred.map((p) => `${p} is outside the fence`), ...absent.map((p) => `${p} is not in the tree`),
      ...git.map((p) => `${p} is under .git`), ...based.map((p) => `${p} is on base`)]
    return { outcome: 'refuse', spans: [...barred, ...absent, ...git, ...based], note: `${step.runs}: ${why.join('; ')}` }
  }
  for (const path of paths) rmSync(join(top, rel(path)))
  return null
}

/** `check-ignore` exits nonzero for a path git does not ignore, a tracked one, and one outside the checkout. */
function ignored(src: string, path: string, rel: (path: string) => string): boolean {
  if (!cloned(src) || !existsSync(join(src, path))) return false
  return spawnSync('git', ['check-ignore', '-q', '--', rel(path)], { cwd: src }).status === 0
}
