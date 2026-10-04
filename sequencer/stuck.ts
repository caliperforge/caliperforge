import type { Db } from '../store/index.ts'
import { partsOf } from '../store/parts.ts'
import { planById, type PlanRow } from '../store/plans.ts'

/** The parts of a split, followed into parts that split too, that ended refused or halted and so will never land. */
export function stuck(db: Db, plan: number): PlanRow[] {
  return partsOf(db, plan).flatMap((p) => p.plan === null ? [] : [planById(db, p.plan)])
    .flatMap((r) => r.state === 'done' ? stuck(db, r.id) : r.state === 'refused' || r.state === 'halted' ? [r] : [])
}
