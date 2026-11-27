import type { Db } from './index.ts'

export function closedWithin(db: Db, plan: number, at: string): boolean {
  return db.prepare("SELECT 1 FROM events WHERE plan = ? AND kind = 'close' AND julianday(at) > julianday(?, '-15 minutes')")
    .get(plan, at) !== undefined
}
