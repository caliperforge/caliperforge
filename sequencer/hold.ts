import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../store/index.ts'
import { returnToLane, retried } from '../store/holds.ts'
import { clearWaitsOn, holdOn } from '../store/plans.ts'
import { WHY } from '../store/refusals.ts'
import { afresh, drop, maybe, planDir, put } from './workspace.ts'

/**
 * A held job stays `blocked_on_ceo` with this note beside it, never `halted`: halted is terminal, and a tick reaps
 * a terminal job's checkout. The orchestrator does not wake on a held job; `released()` or `cf unpark` puts it back
 * where it stopped.
 */
const NOTE = 'parked.md'

export function hold(db: Db, root: string, plan: number, why: string, now: Date, on: number | null = null): void {
  holdOn(db, plan, why, on)
  put(root, plan, NOTE, `# Held ${now.toISOString()}\n\n${why}\n${on === null ? '' : `\nwaits on plan ${String(on)}\n`}`)
}

export function isHeld(root: string, plan: number): boolean {
  return maybe(root, plan, NOTE) !== null
}

const REPEAT = `# Stopped\n\n${WHY.repeat}.\n`

function repeatAtCheck(db: Db, root: string, plan: number): boolean {
  const row = db.prepare('SELECT step FROM plans WHERE id = ?').get(plan) as { step: number } | undefined
  return !isHeld(root, plan) && row?.step === 3 && maybe(root, plan, 'refusal.md')?.endsWith(REPEAT) === true
}

export function unhold(db: Db, root: string, plan: number, actor: string): number {
  if (repeatAtCheck(db, root, plan)) return retried(db, plan, actor)
  const step = returnToLane(db, plan, actor)
  clearWaitsOn(db, plan)
  drop(root, plan, NOTE)
  if (step <= 1) fresh(root, plan)
  afresh(root, plan, step)
  return step
}

/** Nothing is built at step 1, so the brief gets today's main rather than a checkout cut before the job it waited on landed. */
function fresh(root: string, plan: number): void {
  rmSync(join(planDir(root, plan), 'src'), { recursive: true, force: true })
  drop(root, plan, 'base.sha')
  drop(root, plan, 'base.merged')
}
