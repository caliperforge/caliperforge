import type { Db } from './index.ts'
import type { Wait } from './plans.ts'

/** The closed menu the orchestrator is woken with. The store is what holds it to these. */
export const VERBS = ['retry', 'return', 'halt', 'next', 'clear', 'split', 'ask_ceo', 'ask_coo', 'widen'] as const

export type Verb = typeof VERBS[number]

export type Applied = 'applied' | 'escalated' | 'capped'

export interface Decision {
  plan: number
  step: number
  wait_reason: Wait | 'blocked_on_ceo'
  verb: Verb
  why: string
  evidence: string | null
  tokens: number
}

export function decided(db: Db, d: Decision, at: string | null = null): number {
  const row = db.prepare(`INSERT INTO decisions (plan, step, wait_reason, verb, why, evidence, tokens, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, coalesce(?, CURRENT_TIMESTAMP))`)
    .run(d.plan, d.step, d.wait_reason, d.verb, d.why, d.evidence, d.tokens, at)
  return Number(row.lastInsertRowid)
}

export function decisions(db: Db, plan: number): Decision[] {
  return db.prepare(`SELECT plan, step, wait_reason, verb, why, evidence, tokens
    FROM decisions WHERE plan = ? ORDER BY id`).all(plan) as Decision[]
}

export interface DirectorDay { day: string; seen: number; decided: number; fixer: number; ceo: number; held: number; missed: number }

export function directorDays(db: Db, now: Date): DirectorDay[] {
  return db.prepare(`SELECT day, coalesce(sum(seen), 0) AS seen, coalesce(sum(decided), 0) AS decided, coalesce(sum(fixer), 0) AS fixer,
    coalesce(sum(ceo), 0) AS ceo, coalesce(sum(held), 0) AS held, coalesce(sum(missed), 0) AS missed FROM (
      SELECT date(e.at) AS day, 1 AS seen, e.outcome = 'pass' AS decided, 0 AS fixer, e.outcome = 'needs_ceo' AS ceo,
        o.outcome = 'held' AS held, o.outcome = 'missed' AS missed
      FROM events e LEFT JOIN outcomes o ON o.event = e.id WHERE e.kind IN ('director', 'coo_lite')
      UNION ALL SELECT date(at), 0, 0, 1, 0, 0, 0 FROM decisions WHERE verb = 'ask_coo')
    WHERE day BETWEEN date(?, '-6 days') AND date(?) GROUP BY day`).all(now.toISOString(), now.toISOString()) as DirectorDay[]
}

export function mark(db: Db, id: number, applied: Applied): void {
  db.prepare('UPDATE decisions SET applied = ? WHERE id = ?').run(applied, id)
}

/** Moves the orchestrator made on this plan in the day before `now`. */
export function touches(db: Db, plan: number, now: Date): number {
  const row = db.prepare(`SELECT count(*) AS n FROM decisions WHERE plan = ? AND applied = 'applied'
    AND at >= datetime(?, '-1 day')`).get(plan, now.toISOString()) as { n: number }
  return row.n
}
