import { deliverablesOf } from '../store/deliverables.ts'
import { refiled } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { partsOf } from '../store/parts.ts'
import { newestOfOrigin, planById } from '../store/plans.ts'

/** A `done` plan lands once its work is pushed, or once the plan behind the issue it was refiled to has; a split one is `done` from the moment it splits, so it lands only when its own parts have. */
export function landed(db: Db, plan: number | null): boolean {
  if (plan === null || planById(db, plan).state !== 'done') return false
  const parts = partsOf(db, plan)
  if (parts.length > 0) return parts.every((p) => landed(db, p.plan))
  if (deliverablesOf(db, plan).some((d) => d.state === 'pushed')) return true
  const url = refiled(db, plan)
  const moved = url === null ? undefined : newestOfOrigin(db, url)
  return moved !== undefined && landed(db, moved.id)
}
