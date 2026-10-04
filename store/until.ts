import type { Db } from './index.ts'
import { zone } from './lanes.ts'

export interface Lapsed { id: number; step: number; held_until: string }

/** The held plans whose `held_until` is at or before `at`, an ISO time. */
export function lapsed(db: Db, at: string): Lapsed[] {
  return db.prepare("SELECT id, step, held_until FROM plans WHERE state = 'blocked_on_ceo' AND held_until <= ? ORDER BY id")
    .all(at) as Lapsed[]
}

/** What releases a held plan: its time in the windows' zone, else the plan it waits on. */
export function until(db: Db, plan: number): string | null {
  const row = db.prepare("SELECT held_until, waits_on FROM plans WHERE id = ? AND state = 'blocked_on_ceo'")
    .get(plan) as { held_until: string | null; waits_on: number | null } | undefined
  if (row === undefined) return null
  if (row.held_until !== null) {
    return `until ${new Date(Date.parse(row.held_until) + zone(db) * 60000).toISOString().slice(5, 16).replace('T', ' ')}`
  }
  return row.waits_on === null ? null : `until plan ${String(row.waits_on)} lands`
}
