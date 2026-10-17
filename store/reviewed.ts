import type { Db } from './index.ts'

export function newestVerdict(db: Db): number {
  return (db.prepare('SELECT coalesce(max(id), 0) AS id FROM verdicts').get() as { id: number }).id
}

export function reviewSince(db: Db, plan: number, step: number, after: number): number | null {
  return (db.prepare(`SELECT max(id) AS id FROM verdicts WHERE plan = ? AND step = ? AND kind = 'review' AND id > ?`)
    .get(plan, step, after) as { id: number | null }).id
}
