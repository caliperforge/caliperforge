import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { audit, record } from '../rails/completion-audit/index.ts'
import { ready as readyRail, type Proof } from '../rails/ready/index.ts'
import { record as recordRail } from '../rails/record.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import { at } from '../templates/pr-path.ts'
import type { Outcome } from './kind.ts'
import { doneIds, get } from './workspace.ts'

interface Target { repo: string; issue_no: number; state: string; measured_at: string; pulse: string }

export function blocked(db: Db, plan: PlanRow, today: string): string | null {
  const step = at(plan.step)
  if (step.fires === 'ceo') return 'awaiting the sign-off batch'
  if (step.name === 'ruling') return approved(db, plan) ? null : 'awaiting cf approve target'
  if (step.name === 'ready') return proven(db, plan) ? null : 'awaiting the ready proof'
  const row = target(db, plan)
  if (row?.state === 'parked') return `${row.repo}#${String(row.issue_no)} parked on a cold pulse`
  return stale(db, plan, today)
}

export function kernel(db: Db, root: string, plan: PlanRow): Outcome {
  const step = at(plan.step)
  if (step.name === 'rails') return preReview(db, root, plan)
  if (step.name === 'measure') return measure(db, plan)
  if (step.name === 'ready') return readyGate(db, root, plan)
  return { outcome: 'pass', spans: [], note: step.name }
}

/**
 * Step 6 is a gate, so it has to leave a verdict row behind. Before P4 landed
 * there was no ready rail to fire and the step passed by construction; now it
 * runs `rails/ready` over the deliverable and records what it found.
 */
function readyGate(db: Db, root: string, plan: PlanRow): Outcome {
  const proof = proofOf(db, plan)
  if (proof === null) return { outcome: 'refuse', spans: ['deliverables'], note: `plan ${String(plan.id)} has no deliverable row` }
  const verdict = readyRail(db, proof)
  recordRail(db, join(root, 'rails/ready'), plan.id, verdict, 0)
  return { outcome: verdict.outcome, spans: verdict.spans, note: `ready: ${verdict.message}` }
}

function proofOf(db: Db, plan: PlanRow): Proof | null {
  const row = db.prepare(`SELECT d.tests_pass, d.byte_identical_elsewhere, d.fork_ci_green, d.bot_clean,
      d.diff_digest, t.repo
    FROM deliverables d JOIN plans p ON p.id = d.plan_id JOIN targets t ON t.id = p.target_id
    WHERE d.plan_id = ? ORDER BY d.id DESC LIMIT 1`).get(plan.id) as
    { tests_pass: number; byte_identical_elsewhere: number; fork_ci_green: number; bot_clean: number
      diff_digest: string; repo: string } | undefined
  if (row === undefined) return null
  const ci = db.prepare("SELECT outcome, subject_digest FROM verdicts WHERE plan = ? AND rail_id = 'ci-green' ORDER BY id DESC LIMIT 1")
    .get(plan.id) as { outcome: string; subject_digest: string } | undefined
  return {
    repo: row.repo,
    at: new Date().toISOString().slice(0, 10),
    tests_pass: row.tests_pass === 1,
    byte_identical_elsewhere: row.byte_identical_elsewhere === 1,
    fork_public: row.fork_ci_green === 1,
    bot_clean: row.bot_clean === 1,
    ci: {
      outcome: ci?.outcome === 'refuse' ? 'refuse' : 'pass',
      defect_class: null,
      origin_kind: ci?.outcome === 'refuse' ? 'rail' : null,
      origin_ref: ci?.outcome === 'refuse' ? 'ci-green' : null,
      subject_digest: ci?.subject_digest ?? '0'.repeat(64),
      spans: ci?.outcome === 'refuse' ? ['ci-green'] : [],
      message: 'ci-green',
    },
    spans: [row.diff_digest.slice(0, 12)],
  }
}

export function measure(db: Db, plan: PlanRow): Outcome {
  const row = target(db, plan)
  if (row === null) return { outcome: 'refuse', spans: ['targets'], note: `plan ${String(plan.id)} has no target row` }
  if (row.state === 'ready' || row.state === 'queued') {
    return { outcome: 'pass', spans: [], note: `${row.repo}#${String(row.issue_no)} ${row.pulse}` }
  }
  return { outcome: 'refuse', spans: [`targets/${row.repo}#${String(row.issue_no)}`], note: `target state ${row.state}` }
}

function preReview(db: Db, root: string, plan: PlanRow): Outcome {
  const verdict = audit(get(root, plan.id, 'step-2.handback.md'), doneIds(get(root, plan.id, 'issue.md')))
  record(db, plan.id, verdict, 0)
  return { outcome: verdict.outcome, spans: verdict.spans, note: `completion-audit: ${verdict.message}` }
}

/** The repository and issue a plan's checkout is made from, if it has one. */
export function targetOf(db: Db, plan: PlanRow): { repo: string; issue_no: number } | null {
  const row = db.prepare('SELECT repo, issue_no FROM targets WHERE id = ?').get(plan.target_id)
  return (row ?? null) as { repo: string; issue_no: number } | null
}

function target(db: Db, plan: PlanRow): Target | null {
  const row = db.prepare(`SELECT t.repo, t.issue_no, t.state, a.measured_at, a.pulse
    FROM targets t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`).get(plan.target_id)
  return (row ?? null) as Target | null
}

function stale(db: Db, plan: PlanRow, today: string): string | null {
  const row = target(db, plan)
  if (row === null) return null
  const days = Math.floor((Date.parse(today) - Date.parse(row.measured_at.slice(0, 10))) / 86400000)
  return days > 30 ? `account evidence is ${String(days)} days old, re-measure` : null
}

/**
 * The digest `cf approve target` binds an approval to. Shared with the CLI so
 * the two cannot drift.
 */
export function targetDigest(t: { repo: string; issue_no: number; evidence_measured_at: string }): string {
  return createHash('sha256').update(`${t.repo}#${String(t.issue_no)}@${t.evidence_measured_at}`).digest('hex')
}

/**
 * An approval is for one measurement, not for the target forever: the 30-day
 * rule forces a re-measure, and a re-measured target must be approved again.
 */
function approved(db: Db, plan: PlanRow): boolean {
  const t = db.prepare('SELECT repo, issue_no, evidence_measured_at FROM targets WHERE id = ?').get(plan.target_id) as
    { repo: string; issue_no: number; evidence_measured_at: string } | undefined
  if (t === undefined) return false
  return db.prepare("SELECT 1 FROM approvals WHERE subject_kind = 'target' AND subject_id = ? AND subject_digest = ?")
    .get(plan.target_id, targetDigest(t)) !== undefined
}

function proven(db: Db, plan: PlanRow): boolean {
  return db.prepare(`SELECT 1 FROM deliverables WHERE plan_id = ? AND tests_pass = 1
    AND byte_identical_elsewhere = 1 AND fork_ci_green = 1 AND bot_clean = 1 AND target_warm = 1`)
    .get(plan.id) !== undefined
}
