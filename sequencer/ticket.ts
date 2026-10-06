import { file, LANE } from '../cli/plan.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import { alike } from '../store/refusals.ts'
import { hold } from './hold.ts'
import type { Wire } from './push.ts'
import { maybe, put, SELF, titleOf } from './workspace.ts'

const ALIKE = 3

/** Files a machine ticket for a stopped job, queues it at P0 and holds the job on it; an open plan with the same title stands in. */
export function ticketed(db: Db, root: string, plan: PlanRow, title: string, body: string, why: string, wire: Wire,
  now: Date): string {
  const open = db.prepare(`SELECT id, origin FROM plans WHERE lane = 'machine' AND origin IS NOT NULL AND id <> ?
    AND state IN ('queued', 'running', 'blocked_on_ceo') ORDER BY id`).all(plan.id) as { id: number; origin: string }[]
  const { id, origin } = open.find((r) => titleOf(root, r.id) === title) ?? queued(db, root, plan, title, body, wire)
  hold(db, root, plan.id, `${origin}\n\n${why}`, now, id)
  return origin
}

/** On the `ALIKE`th plan with the same stop in a day, tickets the stop; the title leaves out the count so later plans join it. */
export function repeated(db: Db, root: string, plan: PlanRow, wire: Wire, now: Date): { url: string; why: string } | null {
  const stop = alike(db, plan.id, now)
  if (stop === null || stop.plans.length < ALIKE) return null
  const step = String(stop.step)
  const why = `the same stop on ${String(stop.plans.length)} plans within a day`
  const title = `Repeat stop at step ${step}: refusal ${stop.fingerprint.slice(0, 12)}`
  const body = `Filed by director: plans ${stop.plans.join(', ')} stopped at step ${step} with refusal ${stop.fingerprint} within a day.`
  return { url: ticketed(db, root, plan, title, body, why, wire, now), why }
}

function queued(db: Db, root: string, plan: PlanRow, title: string, body: string, wire: Wire): { id: number; origin: string } {
  const stop = maybe(root, plan.id, 'refusal.md') ?? maybe(root, plan.id, 'question.md') ?? 'none'
  const full = `${body}\n\n## Stop at step ${String(plan.step)}\n\n${stop.slice(0, 8000)}`
  const origin = wire.file(SELF, title, full, ['lane:machine', 'P0', 'fix'])
  const id = file(db, 'coo', LANE.machine.pipe, 'machine', LANE.machine.seat, origin, 0)
  put(root, id, 'ask.md', `# ${title}\n\n${full}\n`)
  return { id, origin }
}
