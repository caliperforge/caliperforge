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

interface Ruling {
  subject: string
  value: string
  origin_kind: string
  origin_ref: string
  who: string
  date: string
  issue_no: number
  supersedes: number | null
}

export function addRuling(db: Db, row: Ruling): void {
  db.prepare(`INSERT INTO rulings (subject, value, origin_kind, origin_ref, who, date, issue_no, supersedes)
    VALUES (@subject, @value, @origin_kind, @origin_ref, @who, @date, @issue_no, @supersedes)`).run(row)
}

export function rulingsOf(db: Db, ref: string): Pick<Ruling, 'subject' | 'origin_kind' | 'origin_ref' | 'issue_no'>[] {
  return db.prepare('SELECT subject, origin_kind, origin_ref, issue_no FROM rulings WHERE origin_ref = ? ORDER BY subject')
    .all(ref) as Pick<Ruling, 'subject' | 'origin_kind' | 'origin_ref' | 'issue_no'>[]
}
