import type { Db } from './index.ts'

export function missed(db: Db, plan: number): number {
  return db.prepare(`INSERT INTO unreached (plan, failed) VALUES (?, 1)
    ON CONFLICT (plan) DO UPDATE SET failed = failed + 1 RETURNING failed`).pluck().get(plan) as number
}

export function reached(db: Db, plan: number): number {
  return (db.prepare('DELETE FROM unreached WHERE plan = ? RETURNING failed').pluck().get(plan) as number | undefined) ?? 0
}
