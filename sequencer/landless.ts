import { reopen } from '../cli/cf-return.ts'
import { type Read, type Run, run } from '../cli/gh.ts'
import { deliverablesOf, unland } from '../store/deliverables.ts'
import { eventsOf, logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { allPlans, planById } from '../store/plans.ts'
import { unhold } from './hold.ts'
import { reread } from './reread.ts'
import { firstLine } from './unpolled.ts'
import { maybe } from './workspace.ts'

const COMMIT = /\/commit\/([0-9a-f]{40})$/

/** A done plan whose landed commit is the base it was cut from landed nothing, so it goes back to step 1. */
export function landless(db: Db, root: string, read: Read, exec: Run = run): string[] {
  const lines: string[] = []
  for (const plan of allPlans(db).filter((p) => p.state === 'done' && atBase(db, root, p.id))) {
    try {
      reopen(root, plan, read, exec)
      unland(db, plan.id)
      unhold(db, root, plan.id, 'tick')
      reread(db, root, planById(db, plan.id), 'tick', read)
      lines.push(`plan ${String(plan.id)} landed at its own base sha; queued at step 1`)
    } catch (error) {
      logged(db, { plan: plan.id, kind: 'swallowed', actor: 'halt', outcome: 'pass', message: firstLine(error), pointer: plan.origin, run: null })
      lines.push(`${plan.origin ?? ''}: ${firstLine(error)}`)
    }
  }
  return lines
}

function atBase(db: Db, root: string, plan: number): boolean {
  const base = maybe(root, plan, 'base.sha')?.trim()
  if (base === undefined) return false
  const row = deliverablesOf(db, plan).find((d) => d.state === 'pushed' && COMMIT.exec(d.evidence)?.[1] === base)
  return row !== undefined && !eventsOf(db, plan, 'close').some((e) => e.message === `fixed by ${row.evidence}`)
}
