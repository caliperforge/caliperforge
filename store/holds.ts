import type { Db } from './index.ts'
import { builderRan } from './plans.ts'

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

export function release(db: Db, plan: number): void {
  const done = db.prepare("UPDATE plans SET state = 'running' WHERE id = ? AND step = 2 AND state = 'blocked_on_ceo'")
    .run(plan)
  if (done.changes === 0) throw new Error(`plan ${String(plan)} is not a brief waiting on the coo's read`)
}
