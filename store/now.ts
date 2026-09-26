import type { Db } from './index.ts'
import { alive } from './leases.ts'

export interface Now {
  plan: number
  doing: string
  detail: string
  since: string
  pid: number
  stale: boolean
}

export function busy(db: Db, plan: number, doing: string, detail: string, at: Date = new Date(),
  pid: number = process.pid): void {
  db.prepare('INSERT OR REPLACE INTO now (plan, doing, detail, since, pid) VALUES (?, ?, ?, ?, ?)')
    .run(plan, doing, detail, at.toISOString(), pid)
}

export function idle(db: Db, plan: number): void {
  db.prepare('DELETE FROM now WHERE plan = ?').run(plan)
}

/** A lap that stopped to wait on CI leaves that row: the wait outlives the process, and the card shows it, not idle. */
export function keepWait(db: Db, plan: number): void {
  db.prepare("DELETE FROM now WHERE plan = ? AND doing <> 'waiting on CI'").run(plan)
}

export function current(db: Db): Now[] {
  return (db.prepare('SELECT plan, doing, detail, since, pid FROM now ORDER BY plan').all() as Omit<Now, 'stale'>[])
    .map((row) => ({ ...row, stale: !alive(row.pid) }))
}
