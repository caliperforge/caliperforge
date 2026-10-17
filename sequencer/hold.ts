import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../store/index.ts'
import { returnToLane, retried, rewound } from '../store/holds.ts'
import { clearWaitsOn, holdOn, terminal } from '../store/plans.ts'
import { WHY } from '../store/refusals.ts'
import { COUNTS } from './push.ts'
import { afresh, drop, maybe, planDir, put } from './workspace.ts'

/**
 * A held job stays `blocked_on_ceo` with this note beside it, never `halted`: halted is terminal, and a tick reaps
 * a terminal job's checkout. The orchestrator does not wake on a held job; `released()` or `cf unpark` puts it back
 * where it stopped.
 */
const NOTE = 'parked.md'

export function hold(db: Db, root: string, plan: number, why: string, now: Date, on: number | null = null,
  until: Date | null = null): void {
  if (on === null && until === null) throw new Error(`plan ${String(plan)} needs a time or a plan that releases it`)
  holdOn(db, plan, why, on, until?.toISOString() ?? null)
  put(root, plan, NOTE, `# Held ${now.toISOString()}\n\n${why}\n${on === null ? '' : `\nwaits on plan ${String(on)}\n`}`)
}

/** A park asked for while a tick holds the plan's lease: the tick applies it when the step ends. */
const PENDING = 'park.pending.json'

export function later(root: string, plan: number, why: string, on: number | null, until: Date | null): void {
  if (on === null && until === null) throw new Error(`plan ${String(plan)} needs a time or a plan that releases it`)
  put(root, plan, PENDING, JSON.stringify({ why, on, until: until?.toISOString() ?? null }))
}

export function pending(root: string, plan: number): boolean {
  return maybe(root, plan, PENDING) !== null
}

/** `holdOn` sets `blocked_on_ceo` whatever the state, so only a step that closed the plan keeps what it left. */
export function ended(db: Db, root: string, plan: number, now: Date): void {
  const park = maybe(root, plan, PENDING)
  if (park === null) return
  const { why, on, until } = JSON.parse(park) as { why: string; on: number | null; until: string | null }
  if (!terminal(db).includes(plan)) hold(db, root, plan, why, now, on, until === null ? null : new Date(until))
  drop(root, plan, PENDING)
}

export function isHeld(root: string, plan: number): boolean {
  return maybe(root, plan, NOTE) !== null
}

const REPEAT = `# Stopped\n\n${WHY.repeat}.\n`

function repeatAtCheck(db: Db, root: string, plan: number): boolean {
  const row = db.prepare('SELECT step, template, state FROM plans WHERE id = ?').get(plan) as
    { step: number; template: string; state: string } | undefined
  const refusal = maybe(root, plan, 'refusal.md')
  if (row?.step !== 3 || refusal === null) return false
  if (row.template !== 'comms') return !isHeld(root, plan) && refusal.endsWith(REPEAT)
  return row.state === 'blocked_on_ceo' && refusal.startsWith('step 3 ')
}

function next(db: Db, root: string, plan: number, actor: string, to?: number): number {
  if (to !== undefined) return rewound(db, plan, to, actor)
  return repeatAtCheck(db, root, plan) ? retried(db, plan, actor) : returnToLane(db, plan, actor)
}

export function unhold(db: Db, root: string, plan: number, actor: string, to?: number): number {
  const step = next(db, root, plan, actor, to)
  clearWaitsOn(db, plan)
  for (const key of COUNTS) drop(root, plan, key)
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
