import type { Note } from '../reviews/verdict.ts'
import type { Db } from './index.ts'

type Kept = Omit<Note, 'kind'>

export function keep(db: Db, plan: number, seat: string, notes: Note[]): void {
  const insert = db.prepare(`INSERT INTO language_notes (plan, seat, file, line, old, new, why, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
  for (const n of notes) insert.run(plan, seat, n.file, n.line, n.old, n.new, n.why)
}

/** The notes `seat` has not been shown yet, marked shown to `plan`. */
export function due(db: Db, seat: string, plan: number): Kept[] {
  return db.transaction(() => {
    const rows = db.prepare('SELECT file, line, old, new, why FROM language_notes WHERE seat = ? AND used_by IS NULL ORDER BY id').all(seat) as Kept[]
    db.prepare("UPDATE language_notes SET used_by = ?, used_at = datetime('now') WHERE seat = ? AND used_by IS NULL").run(plan, seat)
    return rows
  })()
}
