import { eventsOf } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { parked } from '../store/plans.ts'
import { stop } from './fixed.ts'
import { isHeld } from './hold.ts'
import { maybe, put } from './workspace.ts'

const RETURNED = 'returned.txt'

/** Why no actor may send the job round now: it waits on another plan, or it was already sent round on this stop. */
export function barred(db: Db, root: string, plan: number): string | null {
  const on = parked(db).find((r) => r.id === plan)
  if (on !== undefined) return `the job is parked ${on.held_why ?? 'on another plan'}`
  const at = stop(root, plan)
  return at !== 'none' && (maybe(root, plan, RETURNED) ?? '').split('\n').includes(at) ? `the job was already returned on stop ${at}` : null
}

export function returned(root: string, plan: number): void {
  put(root, plan, RETURNED, `${maybe(root, plan, RETURNED) ?? ''}${stop(root, plan)}\n`)
}

/** The hold bounds it: `unhold()` drops `parked.md`, so a released job is the fixer's again. */
export function filed(db: Db, root: string, plan: number): boolean {
  return isHeld(root, plan) && /^(file|park): /.test(eventsOf(db, plan, 'director').at(-1)?.message ?? '')
}
