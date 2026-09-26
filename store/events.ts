import type { Db } from './index.ts'
import type { Verdict } from './verdict.ts'

export interface Event {
  plan: number
  kind: string
  actor: string
  outcome: Verdict['outcome']
  message: string
  pointer: string | null
  run: number | null
}

export function logged(db: Db, e: Event): number {
  const row = db.prepare(`INSERT INTO events (plan, kind, actor, outcome, message, pointer, run)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(e.plan, e.kind, e.actor, e.outcome, e.message, e.pointer, e.run)
  return Number(row.lastInsertRowid)
}

export function eventsOf(db: Db, plan: number, kind: string): Event[] {
  return db.prepare('SELECT plan, kind, actor, outcome, message, pointer, run FROM events WHERE plan = ? AND kind = ? ORDER BY id')
    .all(plan, kind) as Event[]
}

export function newestRun(db: Db): number {
  return (db.prepare('SELECT coalesce(max(id), 0) AS id FROM runs').get() as { id: number }).id
}

export function runSince(db: Db, plan: number, step: number, after: number): number | null {
  return (db.prepare('SELECT max(id) AS id FROM runs WHERE plan = ? AND step = ? AND id > ?')
    .get(plan, step, after) as { id: number | null }).id
}
