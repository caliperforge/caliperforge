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
  if (n >= 8 || plan.wait_reason === 'lane_over_cap') return false
  const stopped = plan.state === 'blocked_on_ceo' || plan.state === 'halted'
  const step = db.transaction((): number | null => {
    width(db, pipe.id, n + 1)
    decided(db, { plan: plan.id, step: plan.step, wait_reason: stopped ? 'blocked_on_ceo' : (plan.wait_reason ?? 'over_cap'),
      verb: 'widen', why: why.slice(0, 200), evidence: `${pipe.name} width ${String(n)} → ${String(n + 1)}`, tokens: 0 })
    // A queued job only needed the room; returning it to its lane throws and takes the tick down (#1855).
    return stopped ? returnToLane(db, plan.id, 'director') : null
  })()
  if (step !== null) afresh(root, plan.id, step)
  return true
}
