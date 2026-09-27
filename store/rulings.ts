import type { Db } from './index.ts'

export function latest(db: Db, subject: string): { value: string; issue_no: number } | undefined {
  return db.prepare('SELECT value, issue_no FROM rulings WHERE subject = ? ORDER BY id DESC LIMIT 1').get(subject) as
    { value: string; issue_no: number } | undefined
}
