import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { laneHeld } from '../store/lane-held.ts'
import { laneOff, type PlanRow } from '../store/plans.ts'
import type { Outcome } from './kind.ts'

export function breaker(db: Db, plan: PlanRow, other: number | undefined, outcome: Outcome): void {
  const off = `lane off: plans ${String(plan.id)} and ${String(other)} refused on ${outcome.spans.join(', ')}`
  laneOff(db, plan.pipe_id)
  laneHeld(db, plan.pipe_id, off)
  outcome.note += `; ${off}`
  logged(db, { plan: plan.id, kind: 'pipe', actor: 'settle', outcome: 'escalate', message: outcome.note, pointer: null, run: null })
}
