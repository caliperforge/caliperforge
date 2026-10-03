import type { Db } from './index.ts'

export interface Spend { n: number; tokens: number; usd: number }
export interface Refused { step: number; what: string; outcome: string; message: string }

export function parentOf(db: Db, plan: number): number | null {
  const row = db.prepare('SELECT parent FROM parts WHERE plan = ?').get(plan) as { parent: number } | undefined
  return row?.parent ?? null
}

export function spendOf(db: Db, plan: number): Spend {
  return db.prepare(`SELECT count(*) AS n, coalesce(sum(input_tokens + output_tokens + cache_read_tokens), 0) AS tokens,
    coalesce(sum(cost_computed_usd), 0) AS usd FROM runs WHERE plan = ?`).get(plan) as Spend
}

export function refusedOf(db: Db, plan: number, limit = 12): Refused[] {
  return db.prepare(`SELECT step, coalesce(rail_id, gate) AS what, outcome, coalesce(message, '') AS message
    FROM verdicts WHERE plan = ? AND outcome <> 'pass' ORDER BY id DESC LIMIT ?`).all(plan, limit) as Refused[]
}
