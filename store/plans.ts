import { z } from 'zod'
import type { Db } from './index.ts'

export const PipeRow = z.object({
  id: z.int(),
  name: z.string(),
  enabled: z.int(),
  window_start: z.string(),
  window_end: z.string(),
  max_concurrent: z.int(),
})

export type PipeRow = z.infer<typeof PipeRow>

export const PlanRow = z.object({
  id: z.int(),
  pipe_id: z.int(),
  target_id: z.int().nullable(),
  template: z.enum(['pr_path', 'research', 'comms']),
  state: z.enum(['queued', 'running', 'blocked_on_ceo', 'halted', 'done', 'refused']),
  queued_at: z.string(),
  step: z.int(),
  retries: z.int(),
  head_digest: z.string().nullable(),
  priority: z.int(),
  lane: z.enum(['machine', 'atelier', 'comms', 'research']).nullable(),
  seat: z.string().nullable(),
  origin: z.string().nullable(),
})

export type PlanRow = z.infer<typeof PlanRow>

const ISSUE = /\/issues\/(\d+)$/

/**
 * A plan filed from one of our own issues: it names an `origin` and no target row.
 * Our repo needs no pulse, no target approval and no CEO signature to land (#20).
 */
export function internal(plan: PlanRow): boolean {
  return plan.origin !== null
}

/** The issue number an internal plan's origin url names. */
export function originIssue(plan: PlanRow): number | null {
  const hit = plan.origin === null ? null : ISSUE.exec(plan.origin)
  return hit === null ? null : Number(hit[1])
}

/** Wall-clock HH:MM in the zone the pipe windows are written in; the offset comes from the store. */
export function clock(now: Date, offsetMinutes = 0): string {
  const shifted = new Date(now.getTime() + offsetMinutes * 60000)
  return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function inWindow(pipe: PipeRow, hhmm: string): boolean {
  return pipe.window_start <= pipe.window_end
    ? hhmm >= pipe.window_start && hhmm <= pipe.window_end
    : hhmm >= pipe.window_start || hhmm <= pipe.window_end
}

export function openPipes(db: Db, hhmm: string): PipeRow[] {
  return db.prepare('SELECT * FROM pipes WHERE enabled = 1 ORDER BY id').all()
    .map((r) => PipeRow.parse(r))
    .filter((p) => inWindow(p, hhmm))
}

export function live(db: Db, pipe: PipeRow): PlanRow[] {
  return db.prepare("SELECT * FROM plans WHERE pipe_id = ? AND state IN ('queued', 'running') ORDER BY priority, queued_at, id")
    .all(pipe.id).map((r) => PlanRow.parse(r))
}

export function underCap(pipe: PipeRow, plans: PlanRow[]): PlanRow[] {
  const out = plans.filter((p) => p.state === 'running')
  for (const plan of plans.filter((p) => p.state !== 'running')) {
    if (out.length >= pipe.max_concurrent) break
    out.push(plan)
  }
  return out
}

/** Whether a builder has ever run on this plan: a rewind onto step 1 finds the ticket it was built against, not a fresh one. */
export function builderRan(db: Db, plan: number): boolean {
  return db.prepare('SELECT 1 FROM runs WHERE plan = ? AND step >= 2').get(plan) !== undefined
}

export function advance(db: Db, plan: PlanRow, step: number): void {
  db.prepare("UPDATE plans SET step = ?, state = 'running' WHERE id = ?").run(step, plan.id)
}

export function back(db: Db, plan: PlanRow): 'retried' | 'blocked_on_ceo' {
  if (plan.retries >= 1) {
    db.prepare("UPDATE plans SET state = 'blocked_on_ceo' WHERE id = ?").run(plan.id)
    return 'blocked_on_ceo'
  }
  db.prepare("UPDATE plans SET step = ?, retries = retries + 1, state = 'running' WHERE id = ?")
    .run(Math.max(plan.step - 1, 0), plan.id)
  return 'retried'
}

export function needsCeo(db: Db, plan: PlanRow): void {
  db.prepare("UPDATE plans SET state = 'blocked_on_ceo' WHERE id = ?").run(plan.id)
}

export function finish(db: Db, plan: PlanRow): void {
  db.prepare("UPDATE plans SET step = ?, state = 'done' WHERE id = ?").run(plan.step + 1, plan.id)
}

/** A signal on a pushed PR puts the plan back on the review step it escaped; the head it was signed at is no longer the head. */
export function rewind(db: Db, plan: number, step: number): void {
  db.prepare("UPDATE plans SET step = ?, state = 'running', retries = 0, head_digest = NULL WHERE id = ?")
    .run(step, plan)
}

/** The head the ready gate proved, which is the only head an approval row can be read against. */
export function stampHead(db: Db, plan: number, digest: string): void {
  db.prepare('UPDATE plans SET head_digest = ? WHERE id = ?').run(digest, plan)
}
