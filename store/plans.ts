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

export function addPipe(db: Db, pipe: Omit<PipeRow, 'id'>): void {
  db.prepare(`INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent)
    VALUES (@name, @enabled, @window_start, @window_end, @max_concurrent)`).run(pipe)
}

export function addPlan(db: Db, row: Pick<PlanRow, 'pipe_id' | 'target_id' | 'template' | 'state' | 'queued_at' | 'lane' | 'seat' | 'origin' | 'step'>): number {
  return Number(db.prepare(`INSERT INTO plans (pipe_id, target_id, template, state, queued_at, lane, seat, origin, step)
    VALUES (@pipe_id, @target_id, @template, @state, @queued_at, @lane, @seat, @origin, @step)`).run(row).lastInsertRowid)
}

export function putPlan(db: Db, row: Pick<PlanRow, 'id' | 'pipe_id' | 'target_id' | 'template' | 'state' | 'queued_at' | 'step' | 'retries'>): void {
  db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, step, retries)
    VALUES (@id, @pipe_id, @target_id, @template, @state, @queued_at, @step, @retries)`).run(row)
}

export function titles(db: Db, template: PlanRow['template']): (string | null)[] {
  return (db.prepare('SELECT title FROM plans WHERE template = ? ORDER BY id').all(template) as { title: string | null }[])
    .map((r) => r.title)
}

export function pipeNamed(db: Db, name: string): PipeRow | null {
  const row = db.prepare('SELECT * FROM pipes WHERE name = ?').get(name)
  return row === undefined ? null : PipeRow.parse(row)
}

export function allPlans(db: Db): PlanRow[] {
  return db.prepare('SELECT * FROM plans ORDER BY id').all().map((r) => PlanRow.parse(r))
}

/** The pipe's name when this call switched it off; null when it was already off. */
export function laneOff(db: Db, pipe: number): string | null {
  const row = db.prepare('UPDATE pipes SET enabled = 0 WHERE id = ? AND enabled = 1 RETURNING name').get(pipe) as { name: string } | undefined
  return row?.name ?? null
}

export function dropPlan(db: Db, id: number): void {
  db.prepare('DELETE FROM plans WHERE id = ?').run(id)
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
  const set = db.prepare(`UPDATE plans SET wait_reason = @why, waits_on = @on,
    held_by = CASE WHEN state = 'blocked_on_ceo' THEN held_by WHEN ${ON_CEO} THEN 'ceo' WHEN held_by = 'ceo' THEN NULL ELSE held_by END,
    held_why = CASE WHEN state = 'blocked_on_ceo' THEN held_why WHEN ${ON_CEO} THEN @why WHEN held_by = 'ceo' THEN NULL ELSE held_why END
    WHERE id = @plan`)
  db.transaction(() => {
    for (const row of rows) set.run({ why: row.why, on: row.on ?? null, plan: row.plan })
  })()
}

const ON_CEO = "@why IN ('target_approval', 'ceo_batch')"

export const HOLDERS = ['ceo', 'coo'] as const

export type Holder = typeof HOLDERS[number]

export function holderOf(by: string): Holder {
  const hit = HOLDERS.find((h) => h === by)
  if (hit === undefined) throw new Error(`--by takes ${HOLDERS.join(' or ')}, not ${by}`)
  return hit
}

export function held(db: Db, plan: number, by: Holder, why: string): void {
  db.prepare('UPDATE plans SET held_by = ?, held_why = ? WHERE id = ?').run(by, why, plan)
}

export const ENTER = `CASE WHEN state = 'running' OR (SELECT count(*) FROM plans o WHERE o.pipe_id = plans.pipe_id
  AND o.id <> plans.id AND o.state = 'running') < (SELECT max_concurrent FROM pipes WHERE pipes.id = plans.pipe_id)
  THEN 'running' ELSE 'queued' END`

export function advance(db: Db, plan: PlanRow, step: number): void {
  db.prepare(`UPDATE plans SET step = ?, state = ${ENTER} WHERE id = ?`).run(step, plan.id)
}

/** `stop` is `store/refusals.ts`'s call; `retries` only marks that the plan has been round once, which names a target's branch. */
export function back(db: Db, plan: PlanRow, step: number, stop: boolean, why: string): 'retried' | 'blocked_on_ceo' {
  if (stop) {
    needsCeo(db, plan, why)
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

export function needsCeo(db: Db, plan: PlanRow, why: string | null = null): void {
  db.prepare("UPDATE plans SET state = 'blocked_on_ceo', held_why = ? WHERE id = ?").run(why?.split('\n')[0] ?? null, plan.id)
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

export interface Overlap { plan: number; on: number; path: string | null }

/** The plans the last tick held on another job's files, the job each waits for, and the first file they share. */
export function overlapWaits(db: Db): Overlap[] {
  return db.prepare(`SELECT p.id AS plan, p.waits_on AS "on", (SELECT f.path FROM plan_files f
    JOIN plan_files mine ON mine.plan = p.id AND mine.path = f.path
    WHERE f.plan = p.waits_on AND f.path NOT LIKE '.cf/%' ORDER BY f.position LIMIT 1) AS path
    FROM plans p WHERE p.wait_reason = 'file_overlap' AND p.waits_on IS NOT NULL ORDER BY p.id`).all() as Overlap[]
}
