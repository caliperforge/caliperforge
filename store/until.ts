import type { Db } from './index.ts'

export interface Lapsed { id: number; step: number; held_until: string }

/** The held plans whose `held_until` is at or before `at`, an ISO time. */
export function lapsed(db: Db, at: string): Lapsed[] {
  return db.prepare("SELECT id, step, held_until FROM plans WHERE state = 'blocked_on_ceo' AND held_until <= ? ORDER BY id")
    .all(at) as Lapsed[]
}
