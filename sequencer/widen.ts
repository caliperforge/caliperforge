import { decided } from '../store/decisions.ts'
import { returnToLane } from '../store/holds.ts'
import type { Db } from '../store/index.ts'
import { width } from '../store/lanes.ts'
import { pipeOf, type PlanRow } from '../store/plans.ts'
import { afresh } from './workspace.ts'

/** The same 1 to 8 bound `cf pipe width` holds. */
export function widen(db: Db, root: string, plan: PlanRow, why: string): boolean {
  const pipe = pipeOf(db, plan.pipe_id)
  const n = pipe.max_concurrent
  if (n >= 8) return false
  afresh(root, plan.id, db.transaction(() => {
    width(db, pipe.id, n + 1)
    decided(db, { plan: plan.id, step: plan.step, wait_reason: 'blocked_on_ceo', verb: 'widen', why: why.slice(0, 200),
      evidence: `${pipe.name} width ${String(n)} → ${String(n + 1)}`, tokens: 0 })
    return returnToLane(db, plan.id, 'director')
  })())
  return true
}
