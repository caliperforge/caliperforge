import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { planById, rewind } from '../store/plans.ts'
import { planDir } from './workspace.ts'

export interface At { step: number; why: string }

const READS: Partial<Record<string, Partial<Record<number, string[]>>>> = {
  bench: { 2: ['target.yml', 'generate.json', 'src/test/fizz'] },
  pr_path: { 3: ['issue.md', 'step-2.handback.md', 'base.sha', 'src/.git'] },
  research: { 2: ['answer.md', 'sources.json'] },
}

export function forward(db: Db, root: string, plan: number, actor: string, { step: at, why }: At): number {
  const row = planById(db, plan)
  if (row.state !== 'blocked_on_ceo' && row.state !== 'halted') throw new Error(`plan ${String(plan)} is neither blocked on the ceo nor halted`)
  const reads = READS[row.template] ?? {}
  const paths = at > row.step ? reads[at] : undefined
  if (paths === undefined) throw new Error(`--at takes a later step ${row.template} can resume at: ${Object.keys(reads).join(', ')}, not ${String(at)}`)
  const missing = paths.find((path) => !existsSync(join(planDir(root, plan), path)))
  if (missing !== undefined) throw new Error(`plan ${String(plan)} has no ${missing} for step ${String(at)}`)
  db.transaction(() => {
    rewind(db, plan, at)
    logged(db, { plan, kind: 'return', actor, outcome: 'pass', message: `step ${String(row.step)} → ${String(at)}: ${why}`, pointer: null, run: null })
  })()
  return at
}
