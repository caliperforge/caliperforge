import { chmodSync, existsSync, realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { refuse } from '../runner/index.ts'
import { seat } from '../runner/rules.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import type { Step } from '../templates/pr-path.ts'
import { rowsUnder } from './fence.ts'
import { kernelPlan } from './home.ts'
import type { Outcome } from './kind.ts'
import { fenceFor } from './route.ts'
import { srcDir } from './workspace.ts'

/** A row a builder sets a file's mode with: `- 100755 <path>` or `- 100644 <path>`. */
const MODE = /^\s*[-*]\s*(100755|100644)\s+`?([A-Za-z0-9_+./-]+)`?\s*$/

/** The `[mode, path]` rows a build names under `## Modes`, read as `deletions()` reads its rows. */
export function modes(handback: string): { rows: [string, string][]; unread: string[] } {
  const rows = rowsUnder(handback, '## Modes')
  return { rows: rows.flatMap((l): [string, string][] => { const m = MODE.exec(l); return m === null ? [] : [[String(m[1]), String(m[2])]] }), unread: rows.filter((l) => !MODE.test(l)) }
}

/** The build names `## Modes` rows and the kernel sets them, as `dropped()` removes: a path inside the fence, in the tree, not under `.git`. */
export function moded(db: Db, root: string, plan: PlanRow, step: Step, handback: string): Outcome | null {
  const { rows, unread } = modes(handback)
  if (unread.length > 0) return { outcome: 'refuse', spans: unread, note: `${step.runs}: ${unread.map((r) => `${r} names no 100755 or 100644 path`).join('; ')}` }
  if (rows.length === 0) return null
  const src = srcDir(root, plan.id)
  const top = realpathSync.native(src)
  const rel = (path: string): string => relative(top, realpathSync.native(resolve(top, path)))
  const fence = fenceFor(db, plan.id, seat(root, step.runs).manifest.write_paths)
  const fault = (path: string): string | null => {
    if (refuse(src, fence, path, kernelPlan(plan)) !== null) return 'is outside the fence'
    if (!existsSync(join(src, path))) return 'is not in the tree'
    return rel(path) === '.git' || rel(path).startsWith('.git/') ? 'is under .git' : null
  }
  const faulted = rows.map(([, path]) => path).filter((path) => fault(path) !== null)
  if (faulted.length > 0) return { outcome: 'refuse', spans: faulted, note: `${step.runs}: ${faulted.map((p) => `${p} ${String(fault(p))}`).join('; ')}` }
  for (const [mode, path] of rows) chmodSync(join(top, rel(path)), mode === '100755' ? 0o755 : 0o644)
  return null
}
