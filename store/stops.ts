import type { Db } from './index.ts'
import { PlanRow } from './plans.ts'

export interface Stop { id: number; answered: number | null; today: number }

export function stopped(db: Db, now: Date): Stop[] {
  return db.prepare(`SELECT p.id, e.ruled >= d.at AS answered,
      (SELECT count(*) FROM events WHERE plan = p.id AND kind IN ('director', 'coo_lite') AND outcome = 'pass'
        AND at >= datetime(@at, '-1 day')) AS today
    FROM plans p JOIN decisions d ON d.id = (SELECT max(id) FROM decisions WHERE plan = p.id)
    LEFT JOIN (SELECT plan, max(at) AS ruled FROM events WHERE kind IN ('director', 'coo_lite') GROUP BY plan) e ON e.plan = p.id
    WHERE p.state = 'blocked_on_ceo' AND p.held_by = 'coo' AND d.verb IN ('ask_coo', 'ask_ceo')
    ORDER BY d.at, p.id`).all({ at: now.toISOString() }) as Stop[]
}

export function runs(db: Db, now: Date): number {
  return db.prepare(`SELECT (SELECT count(*) FROM runs WHERE seat = 'director' AND at >= datetime(@at, '-1 day')) + (SELECT count(*)
    FROM events WHERE kind = 'director' AND plan IS NULL AND julianday(at) >= julianday(@at, '-1 day'))`).pluck().get({ at: now.toISOString() }) as number
}

export function kin(db: Db, repo: string, no: number, plan: number): number[] {
  return db.prepare(`SELECT p.id FROM plans p
    JOIN tickets t ON p.origin = 'https://github.com/' || t.repo || '/issues/' || t.number
    WHERE t.repo = ? AND t.parent = (SELECT parent FROM tickets WHERE repo = ? AND number = ?) AND p.id <> ?
    ORDER BY p.id`).pluck().all(repo, repo, no, plan) as number[]
}

export function waitable(db: Db, on: number, plan: number): boolean {
  return db.prepare("SELECT 1 FROM plans WHERE id = ? AND id <> ? AND state IN ('queued', 'running', 'blocked_on_ceo')")
    .get(on, plan) !== undefined
}

export function waitsEnded(db: Db): { id: number; step: number; on_: number; theirs: string }[] {
  return db.prepare(`SELECT p.id, p.step, p.waits_on AS on_, w.state AS theirs FROM plans p JOIN plans w ON w.id = p.waits_on
    WHERE p.state = 'blocked_on_ceo' AND w.state IN ('done', 'refused', 'halted') ORDER BY p.id`).all() as
    { id: number; step: number; on_: number; theirs: string }[]
}

export function openJobs(db: Db, plan: number): { id: number; state: string; step: number; lane: string | null; origin: string | null }[] {
  return db.prepare(`SELECT id, state, step, lane, origin FROM plans
    WHERE state IN ('queued', 'running', 'blocked_on_ceo') AND id <> ? ORDER BY id`).all(plan) as
    { id: number; state: string; step: number; lane: string | null; origin: string | null }[]
}

export function waking(db: Db, wake: readonly string[]): PlanRow[] {
  return db.prepare(`SELECT * FROM plans WHERE ((wait_reason IN (${wake.map(() => '?').join(', ')})
    AND state IN ('queued', 'running', 'blocked_on_ceo')) OR state = 'blocked_on_ceo') AND held_by IS NOT 'ceo' ORDER BY id`)
    .all(...wake).map((r) => PlanRow.parse(r))
}
