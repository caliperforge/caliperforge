import type { Db } from '../store/index.ts'
import { partsOf } from '../store/parts.ts'
import { planById, type PlanRow } from '../store/plans.ts'
import { landed } from './split.ts'

/** The last part of a split with a plan that has not landed, followed into a part that split too. */
export function unlanded(db: Db, plan: number): PlanRow | null {
  const part = partsOf(db, plan).reverse().find((p) => p.plan !== null && !landed(db, p.plan))?.plan ?? null
  const row = part === null ? null : planById(db, part)
  return row?.state === 'done' ? unlanded(db, row.id) : row
}
