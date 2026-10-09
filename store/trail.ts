import type { Event } from './events.ts'
import type { Db } from './index.ts'

export function planEvents(db: Db, plan: number): Omit<Event, 'plan'>[] {
  return db.prepare('SELECT kind, actor, outcome, message, pointer, run FROM events WHERE plan = ? ORDER BY id').all(plan) as Omit<Event, 'plan'>[]
}

export function verdictMessage(db: Db, id: number): string | null | undefined {
  return db.prepare('SELECT message FROM verdicts WHERE id = ?').pluck().get(id) as string | null | undefined
}
