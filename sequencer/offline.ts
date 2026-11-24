import { heldOffline, logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { planById } from '../store/plans.ts'
import type { Route } from './next.ts'
import { mapOf, WAITING } from './steps.ts'

const STALE = 60 * 60_000

export function offline(db: Db, now: Date, routes: Map<number, Route>): void {
  for (const { plan, at } of heldOffline(db, new Date(now.getTime() - STALE).toISOString())) {
    const r = routes.get(plan)
    if (r !== undefined && 'fire' in r) continue
    const row = planById(db, plan)
    const why = r !== undefined ? WAITING[r.wait] : row.state === 'queued' || row.state === 'running' ? 'its lane is not open' : `it is ${row.state}`
    const step = String(row.step)
    logged(db, { plan, kind: 'offline', actor: 'tick', outcome: 'pass', pointer: `step-${step}`, run: null,
      message: `step ${step} ${mapOf(row.template).at(row.step).name}: held offline at ${at}; not stepped since: ${why}` })
  }
}
