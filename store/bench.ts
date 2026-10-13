import type { Db } from './index.ts'

export interface Score { plan: number; target: string; generator: string; catches: number; false_positives: number; untested: number; tokens: number; seconds: number }

export function record(db: Db, s: Score): number {
  return Number(db.prepare(`INSERT INTO bench_scorecard (plan, target, generator, catches, false_positives, untested, tokens, seconds)
    VALUES (@plan, @target, @generator, @catches, @false_positives, @untested, @tokens, @seconds)`).run(s).lastInsertRowid)
}

export function scores(db: Db): Score[] {
  return db.prepare(`SELECT plan, target, generator, catches, false_positives, untested, tokens, seconds
    FROM bench_scorecard ORDER BY id`).all() as Score[]
}
