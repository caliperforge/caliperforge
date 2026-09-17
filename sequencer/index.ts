import type { Provider } from '../providers/kind.ts'
import type { Db } from '../store/index.ts'
import { advance, back, clock, live, needsCeo, openPipes, underCap, type PipeRow, type PlanRow } from '../store/plans.ts'
import { at, type Step } from '../templates/pr-path.ts'
import type { Fired, Outcome } from './kind.ts'
import { fireReview, fireSeat } from './seat.ts'
import { blocked, kernel } from './steps.ts'

export async function tick(db: Db, root: string, provider: Provider, now: Date = new Date()): Promise<Fired[]> {
  const today = now.toISOString().slice(0, 10)
  const out: Fired[] = []
  for (const pipe of openPipes(db, clock(now))) {
    const plan = pick(db, pipe, today)
    if (plan !== null) out.push(await one(db, root, pipe, plan, provider))
  }
  return out
}

export function pick(db: Db, pipe: PipeRow, today: string): PlanRow | null {
  return underCap(pipe, live(db, pipe)).find((p) => blocked(db, p, today) === null) ?? null
}

async function one(db: Db, root: string, pipe: PipeRow, plan: PlanRow, provider: Provider): Promise<Fired> {
  const step = at(plan.step)
  const outcome = await fire(db, root, plan, step, provider)
  return {
    pipe: pipe.name,
    plan: plan.id,
    step: step.step,
    name: step.name,
    outcome: outcome.outcome,
    state: settle(db, plan, step, outcome),
    note: outcome.note,
  }
}

function fire(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  if (step.fires === 'seat') return fireSeat(db, root, plan, step, provider)
  if (step.fires === 'review') return fireReview(db, root, plan, step, provider)
  return Promise.resolve(kernel(db, root, plan))
}

function settle(db: Db, plan: PlanRow, step: Step, outcome: Outcome): string {
  if (outcome.outcome === 'needs_ceo') {
    needsCeo(db, plan)
    return 'blocked_on_ceo'
  }
  if (outcome.outcome === 'refuse') return back(db, plan)
  advance(db, plan, step.step + 1)
  return 'running'
}
