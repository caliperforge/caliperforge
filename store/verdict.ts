/** The one verdict shape: a rail and a review both end in a `verdicts` row. */
import type { Db } from './index.ts'

export interface Verdict {
  outcome: 'pass' | 'refuse' | 'needs_ceo'
  subject_digest: string
  spans: string[]
  origin_kind: 'rail' | 'ruling' | 'incident' | null
  origin_ref: string | null
  message: string
  defect_class: string | null
}

interface VerdictRow {
  id: number
  gate: string
  kind: string
  step: number
  rail_id: string | null
  outcome: Verdict['outcome']
  origin_kind: Verdict['origin_kind']
  origin_ref: string | null
  tree: string | null
  tokens: number
  seconds: number
  kept_by: number | null
}

export function verdictRows(db: Db, plan: number): VerdictRow[] {
  return db.prepare(`SELECT id, gate, kind, step, rail_id, outcome, origin_kind, origin_ref, tree, tokens, seconds, kept_by
    FROM verdicts WHERE plan = ? ORDER BY id`).all(plan) as VerdictRow[]
}

export function overrule(db: Db, plan: number, step: number, ref: string, tree: string): void {
  db.prepare(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, origin_kind, origin_ref, tokens, seconds, tree)
    SELECT gate, kind, subject_digest, plan, step, 'refuse', 'ruling', ?, 0, 0, ? FROM verdicts
    WHERE plan = ? AND step = ? AND kind = 'review'`).run(ref, tree, plan, step)
}

export function addReview(db: Db, gate: string, step: number, plan: number, v: Verdict,
  tokens: number, seconds: number, tree: string | null): number {
  const row = db.prepare(`INSERT INTO verdicts
    (gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds, tree, message)
    VALUES (?, 'review', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`)
    .run(gate, v.subject_digest, plan, step, v.outcome, v.origin_kind, v.origin_ref, tokens, seconds, tree, v.message)
  return Number(row.lastInsertRowid)
}

export function addRail(db: Db, gate: string, step: number, plan: number, rail: string, v: Verdict, seconds: number): number {
  const row = db.prepare(`INSERT INTO verdicts
    (gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, message, tokens, seconds)
    VALUES (?, 'rail', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(gate, v.subject_digest, plan, step, v.outcome, rail, v.origin_kind, v.origin_ref, v.message, seconds)
  return Number(row.lastInsertRowid)
}
