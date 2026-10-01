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
  origin_ref: string | null
  tree: string | null
  tokens: number
  kept_by: number | null
}

export function verdictRows(db: Db, plan: number): VerdictRow[] {
  return db.prepare(`SELECT id, gate, kind, step, rail_id, outcome, origin_ref, tree, tokens, kept_by
    FROM verdicts WHERE plan = ? ORDER BY id`).all(plan) as VerdictRow[]
}

export function overrule(db: Db, plan: number, step: number, ref: string, tree: string): void {
  db.prepare(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, origin_kind, origin_ref, tokens, seconds, tree)
    SELECT gate, kind, subject_digest, plan, step, 'refuse', 'ruling', ?, 0, 0, ? FROM verdicts
    WHERE plan = ? AND step = ? AND kind = 'review'`).run(ref, tree, plan, step)
}
