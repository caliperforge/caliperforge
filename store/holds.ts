import { logged } from './events.ts'
import type { Db } from './index.ts'
import { builderRan, PlanRow, retry } from './plans.ts'
import { clear } from './refusals.ts'

const SPEND = `UPDATE settings SET value = CAST(CAST(value AS INTEGER) - 1 AS TEXT)
  WHERE key = 'brief.reads_left' AND CAST(value AS INTEGER) > 0`

/**
 * Ruling 2026-09-19: the COO reads the brief of the first ten jobs before a builder runs on one.
 * The read is spent and the plan parked in one transaction, so no brief is held off an unspent row.
 */
export function hold(db: Db, plan: number, step: number): 'running' | 'blocked_on_ceo' {
  return db.transaction((): 'running' | 'blocked_on_ceo' => {
    if (step !== 1 || builderRan(db, plan)) return 'running'
    if (db.prepare(SPEND).run().changes === 0) return 'running'
    db.prepare("UPDATE plans SET state = 'blocked_on_ceo' WHERE id = ?").run(plan)
    return 'blocked_on_ceo'
  })()
}

/** Lifting a hold queues the plan and never runs it: the lane's width is what admits, in `picks` (`sequencer/index.ts:56`). */
export function release(db: Db, plan: number): void {
  const done = db.prepare("UPDATE plans SET state = 'queued' WHERE id = ? AND step = 2 AND state = 'blocked_on_ceo'")
    .run(plan)
  if (done.changes === 0) throw new Error(`plan ${String(plan)} is not a brief waiting on the coo's read`)
  logged(db, { plan, kind: 'release', actor: 'coo', outcome: 'pass', message: 'step 2', pointer: null, run: null })
}

export function returnToLane(db: Db, plan: number, actor = 'orchestrator'): number {
  const row = db.prepare(`UPDATE plans SET state = 'queued' WHERE id = ? AND state IN ('blocked_on_ceo', 'halted')
    RETURNING step`).get(plan) as { step: number } | undefined
  if (row === undefined) throw new Error(`plan ${String(plan)} is neither blocked on the ceo nor halted`)
  logged(db, { plan, kind: 'return', actor, outcome: 'pass', message: `step ${String(row.step)}`, pointer: null, run: null })
  return row.step
}

export function retried(db: Db, id: number, actor: string): number {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id)
  if (row === undefined) throw new Error(`no plan ${String(id)}`)
  const plan = PlanRow.parse(row)
  if (plan.state !== 'blocked_on_ceo') throw new Error(`plan ${String(id)} is ${plan.state}, not blocked`)
  return db.transaction(() => {
    clear(db, id)
    const step = retry(db, plan)
    logged(db, { plan: id, kind: 'retry', actor, outcome: 'pass', message: `step ${String(step)}`, pointer: null, run: null })
    return step
  })()
}
