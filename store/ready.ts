import { FORK } from '../sequencer/workspace.ts'
import type { Db } from './index.ts'
import { BUILT, type PlanRow } from './plans.ts'

export interface Target { repo: string; issue_no: number; state: string; measured_at: string; pulse: string }

/**
 * The pulse is the repo's latest measurement, not the one `cf queue add` froze in `targets.account_id`,
 * or a `cf measure` would refresh nothing the kernel reads. What was approved is
 * still pinned by `targets.evidence_measured_at` in `targetDigest()`.
 */
export function target(db: Db, plan: PlanRow): Target | null {
  const row = db.prepare(`SELECT t.repo, t.issue_no, t.state, a.measured_at, a.pulse
    FROM targets t JOIN accounts a ON a.repo = t.repo
    WHERE t.id = ? ORDER BY a.measured_at DESC LIMIT 1`).get(plan.target_id)
  return (row ?? null) as Target | null
}

export function lastCi(db: Db, plan: number): { outcome: string; subject_digest: string } | undefined {
  return db.prepare("SELECT outcome, subject_digest FROM verdicts WHERE plan = ? AND rail_id = 'ci-green' ORDER BY id DESC LIMIT 1")
    .get(plan) as { outcome: string; subject_digest: string } | undefined
}

export function targetRepo(db: Db, id: number): string | null {
  const row = db.prepare('SELECT repo FROM targets WHERE id = ?').get(id) as { repo: string } | undefined
  return row?.repo ?? null
}

/** What the deliverable row points at: the target's issue url, or the issue of ours the plan was filed from. */
export function evidenceOf(db: Db, plan: PlanRow): string {
  if (plan.origin !== null) return plan.origin
  const row = db.prepare('SELECT evidence FROM targets WHERE id = ?').get(plan.target_id) as
    { evidence: string } | undefined
  if (row === undefined) throw new Error(`plan ${String(plan.id)} has no target row`)
  return row.evidence
}

/** A low bot score a later build, or another `head`, has answered no longer holds the plan; the bot scores the new head once it is pushed. */
export function unanswered(db: Db, plan: number, head?: string): unknown {
  return db.prepare(`SELECT 1 FROM signals s WHERE s.plan = @plan AND s.kind = 'bot_review' AND s.score < 5 AND s.repo NOT GLOB @fork
    AND (@head IS NULL OR s.head IS NULL OR s.head = @head)
    AND julianday(s.at) > coalesce((SELECT max(julianday(r.at)) FROM runs r WHERE r.plan = @plan AND r.step = 2 AND r.${BUILT}), 0)`)
    .get({ plan, fork: `${FORK}/*`, head: head ?? null })
}

/** The parts while one ran its rails after the parent's own last `pre_review`: each passed them on the bytes it put on the branch. */
export function railedParts(db: Db, plan: number): number[] {
  return (db.prepare(`SELECT plan FROM parts WHERE parent = @plan AND plan IS NOT NULL
    AND (SELECT max(v.id) FROM verdicts v JOIN parts q ON q.plan = v.plan WHERE q.parent = @plan AND v.gate = 'pre_review')
      > coalesce((SELECT max(id) FROM verdicts WHERE plan = @plan AND gate = 'pre_review'), 0)`)
    .all({ plan }) as { plan: number }[]).map((p) => p.plan)
}

export function passed(db: Db, plan: number, column: 'gate' | 'rail_id', value: string): boolean {
  const row = db.prepare(`SELECT outcome FROM verdicts WHERE plan = ? AND ${column} = ? ORDER BY id DESC LIMIT 1`)
    .get(plan, value) as { outcome: string } | undefined
  return row?.outcome === 'pass'
}

/** The four the gates left at senior. The fifth, fork CI, is the ready step's own first act. */
export function proven(db: Db, plan: PlanRow): boolean {
  return db.prepare(`SELECT 1 FROM deliverables WHERE plan_id = ? AND tests_pass = 1
    AND byte_identical_elsewhere = 1 AND bot_clean = 1 AND target_warm = 1`)
    .get(plan.id) !== undefined
}
