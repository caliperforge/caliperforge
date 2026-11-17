import { LANE } from '../cli/plan.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { holder } from '../store/leases.ts'
import { planById } from '../store/plans.ts'
import { clear } from '../store/refusals.ts'
import { researchParts, toBuild } from '../store/reroute.ts'
import { aside } from './reroute.ts'

const MEASURE = '**Measure:**'

// A part's own lines end at its first blank line; the parent's ask and comments follow, and may carry their own `**Measure:**`.
export const own = (body: string): boolean => (body.split('\n\n')[0] ?? '').includes(`\n${MEASURE}`)

export function misrouted(db: Db, root: string, now: Date): void {
  for (const row of researchParts(db).filter((r) => !own(r.body) && holder(db, r.plan, now) === null)) {
    const parent = planById(db, row.parent)
    const lane = parent.lane ?? 'machine'
    db.transaction(() => {
      toBuild(db, row.plan, parent, lane, parent.seat ?? LANE.machine.seat)
      clear(db, row.plan)
      logged(db, { plan: row.plan, kind: 'return', actor: 'tick', outcome: 'pass', message: `research → ${lane}: its own lines carry no ${MEASURE}`, pointer: null, run: null })
    })()
    aside(root, row.plan)
  }
}
