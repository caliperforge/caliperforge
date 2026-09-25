import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../store/index.ts'
import { returnToLane } from '../store/holds.ts'
import { afresh, drop, maybe, planDir, put } from './workspace.ts'

/**
 * #291: a held job stays `blocked_on_ceo` with a note beside it, never `halted`. Halted is terminal, so the next
 * tick reaped the checkout of every job the fixer parked or ticketed (plan 70 on 09-25 13:07, plan 106 at 13:15).
 * The orchestrator does not wake on a held job; `released()` or `cf unpark` puts it back where it stopped.
 */
const NOTE = 'parked.md'

export function hold(db: Db, root: string, plan: number, why: string, now: Date, on: number | null = null): void {
  db.prepare("UPDATE plans SET state = 'blocked_on_ceo', waits_on = ? WHERE id = ?").run(on, plan)
  put(root, plan, NOTE, `# Held ${now.toISOString()}\n\n${why}\n${on === null ? '' : `\nwaits on plan ${String(on)}\n`}`)
}

export function isHeld(root: string, plan: number): boolean {
  return maybe(root, plan, NOTE) !== null
}

export function unhold(db: Db, root: string, plan: number): number {
  const step = returnToLane(db, plan)
  db.prepare('UPDATE plans SET waits_on = NULL WHERE id = ?').run(plan)
  drop(root, plan, NOTE)
  if (step <= 1) fresh(root, plan)
  afresh(root, plan, step)
  return step
}

/** Plan 146 went back at step 1 on a checkout cut before the job it waited on landed. Nothing is built yet, so the brief gets today's main. */
function fresh(root: string, plan: number): void {
  rmSync(join(planDir(root, plan), 'src'), { recursive: true, force: true })
  drop(root, plan, 'base.sha')
  drop(root, plan, 'base.merged')
}
