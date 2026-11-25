import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { holder } from '../store/leases.ts'
import { waitsOpen } from '../store/stops.ts'
import { hold } from './hold.ts'

/** A research job back in its lane while the plan it waits on is open is held again before the tick routes it. */
export function rehold(db: Db, root: string, now: Date): void {
  for (const r of waitsOpen(db)) {
    if (r.state === 'blocked_on_ceo' || holder(db, r.id, now) !== null) continue
    const why = `waits on plan ${String(r.on_)}`
    hold(db, root, r.id, why, now, r.on_)
    logged(db, { plan: r.id, kind: 'park', actor: 'tick', outcome: 'pass', message: why, pointer: null, run: null })
  }
}

/** A ruled research job whose awaited plan is still open stays held on it; any other job is released. */
export function rewait(db: Db, root: string, plan: number, now: Date, release: () => void): void {
  const on = waitsOpen(db).find((r) => r.id === plan)?.on_
  if (on === undefined) release()
  else hold(db, root, plan, `waits on plan ${String(on)}`, now, on)
}
