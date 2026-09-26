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

/**
 * #140: why the tick is not stepping this plan. The store checks the list, so a reason outside it is
 * refused on the way in rather than read back by #141's router or the #139 orchestrator as a surprise.
 */
export const WAIT = ['ceo_batch', 'target_approval', 'ready_proof', 'target_parked', 'token_ceiling',
  'leased', 'over_cap', 'lane_over_cap', 'no_step_map', 'file_overlap'] as const

export type Wait = typeof WAIT[number]

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
  wait_reason: z.enum(WAIT).nullable(),
})

export type PlanRow = z.infer<typeof PlanRow>

const ISSUE = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/

/**
 * A plan filed from one of our own issues: it names an `origin` and no target row.
 * Our repo needs no pulse, no target approval and no CEO signature to land (#20).
 */
export function internal(plan: PlanRow): boolean {
  return plan.origin !== null
}

/** The repo and issue number an internal plan's origin url names. */
export function originRef(plan: PlanRow): { repo: string; no: number } | null {
  const hit = plan.origin === null ? null : ISSUE.exec(plan.origin)
  return hit === null ? null : { repo: String(hit[1]), no: Number(hit[2]) }
}

/** The issue number an internal plan's origin url names. */
export function originIssue(plan: PlanRow): number | null {
  return originRef(plan)?.no ?? null
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

/** Work already under way sorts first — `step = 0` is 1 for a plan not yet started — so a released plan waits behind no later P0. */
export function live(db: Db, pipe: PipeRow): PlanRow[] {
  return db.prepare(`SELECT * FROM plans WHERE pipe_id = ? AND state IN ('queued', 'running')
    ORDER BY step = 0, priority, queued_at, id`).all(pipe.id).map((r) => PlanRow.parse(r))
}

/** A leased plan is mid-fire: it holds the slot it took whatever state the row is caught at. */
export function underCap(pipe: PipeRow, plans: PlanRow[], leased = new Set<number>()): PlanRow[] {
  const holds = (p: PlanRow): boolean => p.state === 'running' || leased.has(p.id)
  const out = plans.filter(holds)
  for (const plan of plans.filter((p) => !holds(p))) {
    if (out.length >= pipe.max_concurrent) break
    out.push(plan)
  }
  return out
}

export const BUILT = "seat NOT IN ('fixer', 'orchestrator')"

/** Whether a builder has ever run on this plan: a rewind onto step 1 finds the ticket it was built against, not a fresh one. */
export function builderRan(db: Db, plan: number): boolean {
  return db.prepare(`SELECT 1 FROM runs WHERE plan = ? AND step >= 2 AND ${BUILT}`).get(plan) !== undefined
}

/** #140: a plan the tick stepped carries no reason; one it passed over carries why, from the list the store checks. */
/** `on` is the plan a `file_overlap` waits for (#88); every other reason names none. */
export function waiting(db: Db, rows: { plan: number; why: Wait | null; on?: number | null }[]): void {
  const set = db.prepare('UPDATE plans SET wait_reason = ?, waits_on = ? WHERE id = ?')
  db.transaction(() => {
    for (const row of rows) set.run(row.why, row.on ?? null, row.plan)
  })()
}

/** The state an `UPDATE plans` puts a plan back in: a full lane queues it, a running plan keeps its slot. */
export const ENTER = `CASE WHEN state = 'running' OR (SELECT count(*) FROM plans o WHERE o.pipe_id = plans.pipe_id
  AND o.id <> plans.id AND o.state = 'running') < (SELECT max_concurrent FROM pipes WHERE pipes.id = plans.pipe_id)
  THEN 'running' ELSE 'queued' END`

export function advance(db: Db, plan: PlanRow, step: number): void {
  db.prepare(`UPDATE plans SET step = ?, state = ${ENTER} WHERE id = ?`).run(step, plan.id)
}

/** `stop` is `store/refusals.ts`'s call; `retries` only marks that the plan has been round once, which names a target's branch. */
export function back(db: Db, plan: PlanRow, step: number, stop: boolean): 'retried' | 'blocked_on_ceo' {
  if (stop) {
    db.prepare("UPDATE plans SET state = 'blocked_on_ceo' WHERE id = ?").run(plan.id)
    return 'blocked_on_ceo'
  }
  db.prepare(`UPDATE plans SET step = ?, retries = 1, state = ${ENTER} WHERE id = ?`)
    .run(Math.max(step, 0), plan.id)
  return 'retried'
}

/** A person sends a blocked plan round again: a refused build goes back to the builder, anything earlier re-runs its step. */
export function retry(db: Db, plan: PlanRow): number {
  const step = plan.step >= 3 ? 2 : plan.step
  db.prepare(`UPDATE plans SET step = ?, state = ${ENTER} WHERE id = ?`).run(step, plan.id)
  return step
}

export function needsCeo(db: Db, plan: PlanRow): void {
  db.prepare("UPDATE plans SET state = 'blocked_on_ceo' WHERE id = ?").run(plan.id)
}

/** The plans whose checkout no step is coming back for. */
export function terminal(db: Db): number[] {
  return (db.prepare("SELECT id FROM plans WHERE state IN ('done', 'refused', 'halted')").all() as { id: number }[])
    .map((row) => row.id)
}

export function finish(db: Db, plan: PlanRow): void {
  db.prepare("UPDATE plans SET step = ?, state = 'done' WHERE id = ?").run(plan.step + 1, plan.id)
}

/** A signal on a pushed PR puts the plan back on the review step it escaped; the head it was signed at is no longer the head. */
export function rewind(db: Db, plan: number, step: number): void {
  db.prepare(`UPDATE plans SET step = ?, state = ${ENTER}, retries = 0, head_digest = NULL WHERE id = ?`)
    .run(step, plan)
}

/** The head the ready gate proved, which is the only head an approval row can be read against. */
export function stampHead(db: Db, plan: number, digest: string): void {
  db.prepare('UPDATE plans SET head_digest = ? WHERE id = ?').run(digest, plan)
}

/** The plans the last tick held on another job's files, and the job each waits for (#88). */
export function overlapWaits(db: Db): { plan: number; on: number }[] {
  return db.prepare("SELECT id AS plan, waits_on AS on_ FROM plans WHERE wait_reason = 'file_overlap' AND waits_on IS NOT NULL ORDER BY id")
    .all().map((r) => ({ plan: (r as { plan: number }).plan, on: (r as { on_: number }).on_ }))
}
