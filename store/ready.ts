import { FORK } from '../sequencer/workspace.ts'
import { newest } from './deliverables.ts'
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

export interface Landed { plan: number; origin: string; digest: string }

/** An internal plan lands on the gates alone and is never a card to sign; the batch lists it as landed and asks nothing. */
export function landed(db: Db): Landed[] {
  return db.prepare(`SELECT p.id AS plan, p.origin, a.subject_digest AS digest FROM plans p
    JOIN approvals a ON a.subject_kind = 'plan' AND a.subject_id = p.id AND a.who = 'gates'
    WHERE p.origin IS NOT NULL AND a.subject_digest = p.head_digest ORDER BY p.id`).all() as Landed[]
}

export interface Ready { id: number; repo: string; issue_no: number }

export function readyPlans(db: Db): Ready[] {
  return db.prepare(`SELECT p.id, t.repo, t.issue_no FROM plans p JOIN targets t ON t.id = p.target_id
    WHERE p.step = 7 AND p.state IN ('queued', 'running', 'blocked_on_ceo') ORDER BY p.queued_at, p.id`)
    .all() as Ready[]
}

/** The four the gates left at senior. The fifth, fork CI, is the ready step's own first act. */
export function proven(db: Db, plan: PlanRow): boolean {
  return db.prepare(`SELECT 1 FROM deliverables WHERE plan_id = ? AND tests_pass = 1
    AND byte_identical_elsewhere = 1 AND bot_clean = 1 AND target_warm = 1`)
    .get(plan.id) !== undefined
}

/** The pull request this plan already opened, if it did: the row step 8 stamped carries its url, else the target `cf adopt` wrote. */
export function opened(db: Db, plan: number): string | null {
  const row = db.prepare(`SELECT COALESCE(
    (SELECT evidence FROM deliverables WHERE plan_id = ? AND state = 'pushed' AND evidence GLOB 'https://*/pull/*' ORDER BY id DESC LIMIT 1),
    (SELECT t.evidence FROM plans p JOIN targets t ON t.id = p.target_id WHERE p.id = ? AND t.evidence GLOB 'https://*/pull/*')
  ) AS evidence`).get(plan, plan) as { evidence: string | null }
  return row.evidence
}

export function markPushed(db: Db, plan: number, approval: number, url: string): void {
  db.prepare(`UPDATE deliverables SET state = 'pushed', approval_id = ?, evidence = ?
    WHERE id = ?`).run(approval, url, newest(db, plan)?.id ?? null)
}

/** The stranger's repository the pull request is opened on and the issue it closes. */
export function pushTarget(db: Db, plan: PlanRow): { repo: string; issue_no: number; named_merger: string } | null {
  return (db.prepare('SELECT repo, issue_no, named_merger FROM targets WHERE id = ?').get(plan.target_id) ?? null) as
    { repo: string; issue_no: number; named_merger: string } | null
}

export function botBody(db: Db, plan: number, head: string): string | null {
  const row = db.prepare(`SELECT body FROM signals WHERE plan = ? AND kind = 'bot_review' AND head = ? AND body IS NOT NULL
    ORDER BY id DESC LIMIT 1`).get(plan, head) as { body: string } | undefined
  return row?.body ?? null
}

/** The tree the reviewer last passed, else the one its last verdict judged, off the row `judge()` wrote it on. */
export function judgedTree(db: Db, plan: number, step: number): string | null {
  const row = db.prepare(`SELECT tree FROM verdicts WHERE plan = ? AND step = ? AND kind = 'review' AND gate <> 'blind_review'
    ORDER BY outcome = 'pass' AND tree IS NOT NULL DESC, id DESC LIMIT 1`)
    .get(plan, step) as { tree: string | null } | undefined
  return row?.tree ?? null
}
