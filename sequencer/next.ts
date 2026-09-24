import type { Db } from '../store/index.ts'
import { held, type Lease } from '../store/leases.ts'
import { cap, hhmm } from '../store/lanes.ts'
import { live, openPipes, underCap, type PipeRow, type PlanRow, type Wait } from '../store/plans.ts'
import { overBudget } from '../store/refusals.ts'
import { at, type Step } from '../templates/pr-path.ts'
import { blocked, overlapping } from './steps.ts'

export type Route = { fire: Step } | { wait: Wait; on: number | null }
  | { wait: 'token_ceiling'; on: null; over: { spent: number; ceiling: number } }

export interface Offer {
  pipe: PipeRow
  plans: PlanRow[]
}

/** The templates a step map exists for. A lane whose map is unwritten is on with nothing to step. */
const MAPPED = new Set(['pr_path'])

export function route(db: Db, plan: PlanRow, now: Date, mine: Lease | null = null): Route {
  if (others(db, now, mine).some((l) => l.plan === plan.id)) return { wait: 'leased', on: null }
  if (!MAPPED.has(plan.template)) return { wait: 'no_step_map', on: null }
  const stop = blocked(db, plan)
  if (stop !== null) return { wait: stop, on: stop === 'file_overlap' ? (overlapping(db, plan)?.plan ?? null) : null }
  const lane = working(offered(db, now, mine), cap(db).cap).find((o) => o.pipe.id === plan.pipe_id)
  if (lane === undefined) return { wait: 'lane_over_cap', on: null }
  if (!lane.plans.some((p) => p.id === plan.id)) return { wait: 'over_cap', on: null }
  const step = at(plan.step)
  const spends = step.fires === 'brief' || step.fires === 'seat' || step.fires === 'review'
  const over = spends ? overBudget(db, plan.id) : null
  return over === null ? { fire: step } : { wait: 'token_ceiling', on: null, over }
}

function others(db: Db, now: Date, mine: Lease | null): Lease[] {
  return held(db, now).filter((l) => l.plan !== mine?.plan || l.pid !== mine.pid)
}

/** Every open lane and what it would step, asked once: one reading of the queues serves the whole tick. */
export function offered(db: Db, now: Date, mine: Lease | null = null): Offer[] {
  return openPipes(db, hhmm(db, now)).map((pipe) => ({ pipe, plans: picks(db, pipe, now, mine) }))
}

/**
 * #125: the cap is spent on lanes that can use it. A lane with nothing to step takes no slot, so at
 * cap 1 an idle lane no longer holds the only slot against a lane with a plan it could step; among
 * lanes that can step, the lower id still wins, which is the order `openPipes` returns.
 */
export function working(offers: Offer[], wide: number): Offer[] {
  return offers.filter((o) => o.plans.length > 0).slice(0, wide)
}

/**
 * The plans this pipe steps this tick, in priority order. A queued plan that is
 * blocked holds no slot; a running one holds the slot it already took, and so does
 * one another tick has leased, which this tick offers to nobody.
 */
export function picks(db: Db, pipe: PipeRow, now: Date = new Date(), mine: Lease | null = null): PlanRow[] {
  const leases = new Set(others(db, now, mine).map((l) => l.plan))
  const mapped = live(db, pipe).filter((p) => MAPPED.has(p.template))
  const free = mapped.filter((p) => leases.has(p.id) || blocked(db, p) === null
    || (p.state === 'running' && overlapping(db, p) === null))
  return underCap(pipe, free, leases)
    .filter((p) => !leases.has(p.id) && (p.state !== 'running' || blocked(db, p) === null))
}
