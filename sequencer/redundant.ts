import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { end, originRef, type PlanRow } from '../store/plans.ts'
import type { Wire } from './push.ts'

export function redundant(db: Db, plan: PlanRow, why: string, wire: Wire): boolean {
  const ref = originRef(plan)
  if (ref?.repo.startsWith('caliperforge/') !== true) return false
  db.transaction(() => {
    end(db, plan.id, 'refused')
    logged(db, { plan: plan.id, kind: 'close', actor: 'director', outcome: 'refuse', message: why, pointer: null, run: null })
  })()
  wire.close(ref.repo, ref.no, '', `Closed by director on plan ${String(plan.id)}.\n\n${why}`)
  return true
}
