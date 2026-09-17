import { audit, record } from '../rails/completion-audit/index.ts'
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
  return { outcome: 'pass', spans: [], note: step.name }
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

function approved(db: Db, plan: PlanRow): boolean {
  return db.prepare("SELECT 1 FROM approvals WHERE subject_kind = 'target' AND subject_id = ?").get(plan.target_id) !== undefined
}

function proven(db: Db, plan: PlanRow): boolean {
  return db.prepare(`SELECT 1 FROM deliverables WHERE plan_id = ? AND tests_pass = 1
    AND byte_identical_elsewhere = 1 AND fork_ci_green = 1 AND bot_clean = 1 AND target_warm = 1`)
    .get(plan.id) !== undefined
}
