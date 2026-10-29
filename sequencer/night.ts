import type { Db } from '../store/index.ts'
import { hhmm } from '../store/lanes.ts'
import { held as leased } from '../store/leases.ts'
import { allPlans, inWindow, pipeNamed, type PlanRow } from '../store/plans.ts'
import type { Step } from '../templates/pr-path.ts'

/** The bench steps that run Medusa. */
export function fuzzes(plan: PlanRow, step: Step): boolean {
  return plan.template === 'bench' && (step.name === 'score' || step.name === 'null_check')
}

export function benchWait(db: Db, plan: PlanRow, step: Step, now: Date): 'bench_score_busy' | 'bench_night' | null {
  if (plan.template === 'bench' && step.name === 'score' && scoring(db, plan)) return 'bench_score_busy'
  return fuzzes(plan, step) && !night(db, now) ? 'bench_night' : null
}

/** Another open bench plan at this step is leased by a live tick: scores share the host, so one runs at a time. */
function scoring(db: Db, plan: PlanRow): boolean {
  const leases = new Set(leased(db).map((l) => l.plan))
  return allPlans(db).some((p) => p.id !== plan.id && p.template === 'bench' && p.step === plan.step
    && (p.state === 'queued' || p.state === 'running') && leases.has(p.id))
}

/** Inside the refuzz pipe's window, or at any hour when there is no refuzz pipe. */
function night(db: Db, now: Date): boolean {
  const pipe = pipeNamed(db, 'refuzz')
  return pipe === null || inWindow(pipe, hhmm(db, now))
}
