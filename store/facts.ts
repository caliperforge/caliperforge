import type { Db } from './index.ts'
import { lastReview } from './merges.ts'
import { builds } from './refusals.ts'

export interface Fact { name: string; ok: boolean; says: string }

function gate(name: string, outcome: string | undefined): Fact {
  return { name, ok: outcome === 'pass', says: outcome ?? 'no verdict' }
}

function rails(db: Db, plan: number): Fact {
  const rows = db.prepare(`SELECT rail_id, outcome FROM verdicts WHERE id IN (SELECT max(id) FROM verdicts
    WHERE plan = ? AND kind = 'rail' AND gate = 'pre_review' AND rail_id <> 'identifiers' GROUP BY rail_id)
    ORDER BY rail_id`).all(plan) as { rail_id: string; outcome: string }[]
  if (rows.length === 0) return gate('rails', undefined)
  const failing = rows.filter((r) => r.outcome !== 'pass').map((r) => `${r.rail_id} ${r.outcome}`)
  return { name: 'rails', ok: failing.length === 0, says: failing.length === 0 ? 'pass' : failing.join(', ') }
}

export function facts(db: Db, plan: number): Fact[] {
  const identifiers = db.prepare(`SELECT outcome FROM verdicts WHERE plan = ? AND kind = 'rail' AND rail_id = 'identifiers'
    ORDER BY id DESC LIMIT 1`).get(plan) as { outcome: string } | undefined
  const n = builds(db, plan)
  return [
    rails(db, plan),
    gate('code_quality', lastReview(db, plan, 'review')?.outcome),
    gate('senior', lastReview(db, plan, 'senior_review')?.outcome),
    gate('identifiers', identifiers?.outcome),
    { name: 'builds', ok: true, says: `${String(n)} build${n === 1 ? '' : 's'}` },
  ]
}
