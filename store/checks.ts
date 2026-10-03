import type { Db } from './index.ts'

interface Checked {
  outcome: string
  subject_digest: string
  message: string | null
}

export function lastChecks(db: Db, plan: number): Checked | undefined {
  return db.prepare(`SELECT outcome, subject_digest, message FROM verdicts WHERE plan = ? AND kind = 'rail' AND rail_id = 'checks'
    ORDER BY id DESC LIMIT 1`).get(plan) as Checked | undefined
}

export function restamp(db: Db, plan: number, before: string, after: string): void {
  const row = lastChecks(db, plan)
  if (row?.outcome !== 'pass' || row.subject_digest !== before) return
  db.prepare(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds, message)
    VALUES ('pre_review', 'rail', ?, ?, 3, 'pass', 'checks', NULL, NULL, 0, 0, 'checks re-stamped after notes')`).run(after, plan)
}
