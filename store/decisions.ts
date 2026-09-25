import type { Db } from './index.ts'
import type { Wait } from './plans.ts'

/** The closed menu #139 wakes the orchestrator with. The store is what holds it to these. */
export const VERBS = ['retry', 'return', 'halt', 'next', 'clear', 'split', 'ask_ceo', 'ask_coo'] as const

export type Verb = typeof VERBS[number]

export interface Decision {
  plan: number
  step: number
  wait_reason: Wait | 'blocked_on_ceo'
  verb: Verb
  why: string
  evidence: string | null
  tokens: number
}

export function decided(db: Db, d: Decision): number {
  const row = db.prepare(`INSERT INTO decisions (plan, step, wait_reason, verb, why, evidence, tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(d.plan, d.step, d.wait_reason, d.verb, d.why, d.evidence, d.tokens)
  return Number(row.lastInsertRowid)
}

export function decisions(db: Db, plan: number): Decision[] {
  return db.prepare(`SELECT plan, step, wait_reason, verb, why, evidence, tokens
    FROM decisions WHERE plan = ? ORDER BY id`).all(plan) as Decision[]
}
