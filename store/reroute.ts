import type { Db } from './index.ts'
import type { PlanRow } from './plans.ts'

export function toResearch(db: Db, plan: number, pipe: number, seat: string): void {
  db.prepare("UPDATE plans SET template = 'research', lane = 'research', pipe_id = ?, seat = ? WHERE id = ?").run(pipe, seat, plan)
}

/** Open research plans that are parts of any parent. */
export function researchParts(db: Db): { plan: number; parent: number; body: string }[] {
  return db.prepare(`SELECT p.plan, p.parent, p.body FROM parts p JOIN plans c ON c.id = p.plan
    WHERE c.template = 'research' AND c.state IN ('queued', 'running', 'blocked_on_ceo') ORDER BY p.plan`)
    .all() as { plan: number; parent: number; body: string }[]
}

export function toBuild(db: Db, plan: number, parent: PlanRow, lane: string, seat: string): void {
  db.prepare(`UPDATE plans SET template = ?, pipe_id = ?, lane = ?, seat = ?, step = 0, state = 'queued', retries = 0, head_digest = NULL,
    wait_reason = NULL, waits_on = NULL, held_by = NULL, held_why = NULL, held_until = NULL WHERE id = ?`)
    .run(parent.template, parent.pipe_id, lane, seat, plan)
}
