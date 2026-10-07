import type { Db } from './index.ts'

export function latest(db: Db, subject: string): { value: string; issue_no: number } | undefined {
  return db.prepare('SELECT value, issue_no FROM rulings WHERE subject = ? ORDER BY id DESC LIMIT 1').get(subject) as
    { value: string; issue_no: number } | undefined
}

export function rulingId(db: Db, subject: string): number | null {
  const row = db.prepare('SELECT id FROM rulings WHERE subject = ? ORDER BY id DESC LIMIT 1').get(subject) as { id: number } | undefined
  return row?.id ?? null
}

export function rulingSubject(db: Db, id: number): string | undefined {
  return db.prepare('SELECT subject FROM rulings WHERE id = ?').pluck().get(id) as string | undefined
}
