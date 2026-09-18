import type { Db } from './index.ts'

export interface Receipt {
  at: string
  hhmm: string
  dry: boolean
  pipes: number
  fired: number
  exit: number
  note: string
}

/** launchd writes no log of its own, so the row this leaves is the only record the timer fired. */
export function receipt(db: Db, row: Receipt): number {
  const made = db.prepare(`INSERT INTO ticks (at, hhmm, dry, pipes, fired, exit, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(row.at, row.hhmm, Number(row.dry), row.pipes, row.fired, row.exit, row.note)
  return Number(made.lastInsertRowid)
}

export function last(db: Db, limit = 10): Receipt[] {
  return db.prepare('SELECT at, hhmm, dry, pipes, fired, exit, note FROM ticks ORDER BY id DESC LIMIT ?')
    .all(limit).map((r) => ({ ...(r as Receipt), dry: (r as { dry: number }).dry === 1 }))
}
