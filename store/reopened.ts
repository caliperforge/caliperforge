import { logged } from './events.ts'
import type { Db } from './index.ts'

export function reopened(db: Db, plan: number, actor: string): number {
  const row = db.prepare(`UPDATE plans SET step = 1, state = 'queued', retries = 0, head_digest = NULL WHERE id = ? AND state = 'done'
    RETURNING step`).get(plan) as { step: number } | undefined
  if (row === undefined) throw new Error(`plan ${String(plan)} is not done`)
  logged(db, { plan, kind: 'return', actor, outcome: 'pass', message: `step ${String(row.step)}`, pointer: null, run: null })
  return row.step
}
