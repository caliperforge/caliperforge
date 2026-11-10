import { file, LANE, laneOf } from '../cli/plan.ts'
import { logged } from '../store/events.ts'
import { returnToLane } from '../store/holds.ts'
import type { Db } from '../store/index.ts'
import type { Lane } from '../store/lanes.ts'
import type { PlanRow } from '../store/plans.ts'
import { alike } from '../store/refusals.ts'
import { type Cover, covered, said } from './covered.ts'
import { hold, unhold } from './hold.ts'
import type { Wire } from './push.ts'
import { rule } from './rule.ts'
import { afresh, maybe, put } from './workspace.ts'

const ALIKE = 3

/** Files a ticket in the lane its title's `lane:` token names, else machine, for a stopped job, queues it at P0 and holds the job on it; a `covered()` ticket stands in. */
export function ticketed(db: Db, root: string, plan: PlanRow, title: string, body: string, why: string, wire: Wire,
  now: Date): string | false {
  const lane = laneOf(title.split(/[\s,()]+/).map((name) => ({ name }))) ?? 'machine'
  const cover = covered(db, root, plan, LANE[lane].home, title, body, now, wire.merged)
  const url = acted(db, root, plan, cover, lane, title, body, why, wire, now)
  logged(db, { plan: plan.id, kind: 'covered', actor: 'ticketed', outcome: cover.verdict === 'unreplaced' ? 'refuse' : 'pass',
    message: `compared "${title}" with ${String(cover.open)} open, ${String(cover.landed)} landed, ${String(cover.names)} registry lines: ${said(cover)}`,
    pointer: url === false ? null : url, run: null })
  return url
}

function acted(db: Db, root: string, plan: PlanRow, cover: Cover, lane: Lane, title: string, body: string, why: string, wire: Wire,
  now: Date): string | false {
  switch (cover.verdict) {
    case 'landed': {
      const to = rule(db, root, plan, 'director', `#${String(cover.no)} landed this as ${cover.sha}: build on top of ${cover.sha} and use what it added; do not build it again.`)
      if (to !== null && (plan.state === 'blocked_on_ceo' || plan.state === 'halted')) {
        if (to === 'ask.md') unhold(db, root, plan.id, 'director')
        else afresh(root, plan.id, returnToLane(db, plan.id, 'director'))
      }
      return to === null ? false : cover.url
    }
    case 'open':
      wire.amend?.(LANE[lane].home, cover.no, `- Also hit on plan ${String(plan.id)}: ${why.split('\n')[0] ?? ''}`)
      hold(db, root, plan.id, `${cover.url}\n\n${why}`, now, cover.plan)
      return cover.url
    case 'unreplaced': return false
    case 'filed': return queued(db, root, plan, lane, title, body, why, wire, now)
  }
}

/** On the `ALIKE`th plan with the same stop in a day, tickets the stop; the title leaves out the count so later plans join it. */
export function repeated(db: Db, root: string, plan: PlanRow, wire: Wire, now: Date): { url: string; why: string } | null {
  const stop = alike(db, plan.id, now)
  if (stop === null || stop.plans.length < ALIKE) return null
  const step = String(stop.step)
  const why = `the same stop on ${String(stop.plans.length)} plans within a day`
  const title = `Repeat stop at step ${step}: refusal ${stop.fingerprint.slice(0, 12)}`
  const body = `Filed by director: plans ${stop.plans.join(', ')} stopped at step ${step} with refusal ${stop.fingerprint} within a day.`
  const url = ticketed(db, root, plan, title, body, why, wire, now)
  return url === false ? null : { url, why }
}

function queued(db: Db, root: string, plan: PlanRow, lane: Lane, title: string, body: string, why: string,
  wire: Wire, now: Date): string {
  const stop = maybe(root, plan.id, 'refusal.md') ?? maybe(root, plan.id, 'question.md') ?? 'none'
  const full = `${body}\n\n## Stop at step ${String(plan.step)}\n\n${stop.slice(0, 8000)}`
  const origin = wire.file(LANE[lane].home, title, full, [`lane:${lane}`, 'P0', 'fix'])
  const id = file(db, 'coo', LANE[lane].pipe, lane, LANE[lane].seat, origin, 0)
  put(root, id, 'ask.md', `# ${title}\n\n${full}\n`)
  hold(db, root, plan.id, `${origin}\n\n${why}`, now, id)
  return origin
}
