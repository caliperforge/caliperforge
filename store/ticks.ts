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

/** How a tick's note begins when it halted on a landing the live tree cannot move to. */
export const BEHIND = 'live tree is behind'

/** launchd writes no log of its own, so the row this leaves is the only record the timer fired. */
export function receipt(db: Db, row: Receipt): number {
  const made = db.prepare(`INSERT INTO ticks (at, hhmm, dry, pipes, fired, exit, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(row.at, row.hhmm, Number(row.dry), row.pipes, row.fired, row.exit, row.note)
  return Number(made.lastInsertRowid)
}

export function slots(db: Db, tick: number, rows: { pipe: { id: number }; free: number; startable: number }[]): void {
  const put = db.prepare('INSERT INTO tick_lanes (tick, pipe, free, startable) VALUES (?, ?, ?, ?)')
  db.transaction(() => {
    for (const row of rows) put.run(tick, row.pipe.id, row.free, row.startable)
  })()
}

export function last(db: Db, limit = 10): Receipt[] {
  return db.prepare('SELECT at, hhmm, dry, pipes, fired, exit, note FROM ticks ORDER BY id DESC LIMIT ?')
    .all(limit).map((r) => ({ ...(r as Receipt), dry: (r as { dry: number }).dry === 1 }))
}

export function unhalted(db: Db): Receipt | undefined {
  const row = db.prepare(`SELECT at, hhmm, dry, pipes, fired, exit, note FROM ticks WHERE dry = 0 AND note NOT LIKE ?
    ORDER BY at DESC LIMIT 1`).get(`${BEHIND}%`) as Receipt | undefined
  return row === undefined ? undefined : { ...row, dry: false }
}

export function real(db: Db, limit: number): Receipt[] {
  return db.prepare('SELECT at, hhmm, dry, pipes, fired, exit, note FROM ticks WHERE dry = 0 ORDER BY at DESC LIMIT ?')
    .all(limit).map((r) => ({ ...(r as Receipt), dry: (r as { dry: number }).dry === 1 }))
}
