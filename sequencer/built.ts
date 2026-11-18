import { eventsOf, logged } from '../store/events.ts'
import { returnToLane } from '../store/holds.ts'
import type { Db } from '../store/index.ts'
import { held, type PlanRow } from '../store/plans.ts'
import type { Cover } from './covered.ts'
import { unhold } from './hold.ts'
import { repoOf } from './ready.ts'
import { rule } from './rule.ts'
import { afresh, maybe } from './workspace.ts'

export function built(db: Db, root: string, plan: PlanRow, cover: Extract<Cover, { verdict: 'landed' }>, home: string): string | false {
  const stopped = plan.state === 'blocked_on_ceo' || plan.state === 'halted'
  if (home !== repoOf(db, plan)) {
    const line = `#${String(cover.no)} landed the fix for this stop as ${cover.sha} on ${home}`
    if (eventsOf(db, plan.id, 'resume').some((e) => e.message === line)) {
      held(db, plan.id, 'coo', `repeat: ${line}, and the plan stopped again`)
      return false
    }
    logged(db, { plan: plan.id, kind: 'resume', actor: 'director', outcome: 'pass', message: line, pointer: cover.url, run: null })
    if (stopped) afresh(root, plan.id, returnToLane(db, plan.id, 'director'))
    return cover.url
  }
  const text = `#${String(cover.no)} landed this as ${cover.sha}: build on top of ${cover.sha} and use what it added; do not build it again.`
  if (maybe(root, plan.id, 'issue.md')?.includes(text) === true) {
    held(db, plan.id, 'coo', `repeat: ${text}`)
    return false
  }
  const to = rule(db, root, plan, 'director', text)
  if (to !== null && stopped) {
    if (to === 'ask.md') unhold(db, root, plan.id, 'director')
    else afresh(root, plan.id, returnToLane(db, plan.id, 'director'))
  }
  return to === null ? false : cover.url
}
