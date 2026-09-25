import { record } from '../cli/inbox.ts'
import type { Post } from '../cli/watch.ts'
import { mark, touches, type Applied, type Verb } from '../store/decisions.ts'
import type { Db } from '../store/index.ts'
import { returnToLane } from '../store/holds.ts'
import { retry, type PlanRow } from '../store/plans.ts'
import { clear } from '../store/refusals.ts'
import { afresh } from './workspace.ts'

/** #238, CEO 2026-09-25: the moves the orchestrator makes by itself. Every other verb goes to a person. */
export const MECHANICAL = new Set<Verb>(['retry', 'return', 'clear', 'next'])

/** Past this many applied moves on one plan in a day it is spinning, and the next decision goes to a person. */
export const TOUCHES = 2

/** Off until the CEO's shadow comparison clears it: `orchestrator.apply` = 1 hands it the wheel. */
export function applying(db: Db): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'orchestrator.apply'").get() as { value: string } | undefined
  return row?.value === '1'
}

/** A move changes the plan exactly as the matching `cf` command would, and the decision row says what became of it. */
export function act(db: Db, root: string, plan: PlanRow, d: { id: number; verb: Verb; why: string }, ticket: string,
  now: Date, post: Post): Applied {
  const applied = move(db, root, plan, d.verb, now)
  mark(db, d.id, applied)
  const note = `${d.verb}: ${d.why}`
  const at = now.toISOString()
  if (applied === 'applied') {
    // `next` leaves the plan stopped, so it reaches the desktop; a plan sent round again only reaches the file.
    const kind = d.verb === 'next' ? 'blocked' : 'refused'
    record(root, [{ at, plan: plan.id, ticket, kind, step: plan.step, name: 'orchestrator', note }])
    return applied
  }
  const head = applied === 'capped' ? `touched ${String(TOUCHES)} times today, so it is yours` : 'needs a person'
  record(root, [{ at, plan: plan.id, ticket, kind: 'blocked', step: plan.step, name: 'orchestrator', note: `${head}. ${note}` }])
  post(`CaliperForge · ${ticket} ${head}`, `plan ${String(plan.id)}, step ${String(plan.step)}. ${note}`)
  return applied
}

function move(db: Db, root: string, plan: PlanRow, verb: Verb, now: Date): Applied {
  if (!MECHANICAL.has(verb)) return 'escalated'
  if (plan.state !== 'blocked_on_ceo' && plan.state !== 'halted') return 'escalated'
  if (touches(db, plan.id, now) >= TOUCHES) return 'capped'
  if (verb === 'next') return 'applied'
  const step = db.transaction((): number => {
    if (verb === 'retry') {
      clear(db, plan.id)
      return plan.state === 'blocked_on_ceo' ? retry(db, plan) : returnToLane(db, plan.id)
    }
    if (verb === 'clear') clear(db, plan.id)
    return returnToLane(db, plan.id)
  })()
  afresh(root, plan.id, step)
  return 'applied'
}
