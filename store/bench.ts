import type { Db } from './index.ts'

export interface Score { plan: number; target: string; generator: string; catches: number; false_positives: number; untested: number | null; tokens: number; seconds: number; x_ray: 0 | 1 | null
  pre_fix_calls: number | null; fix_calls: number | null }

const COLUMNS = 'plan, target, generator, catches, false_positives, untested, tokens, seconds, x_ray, pre_fix_calls, fix_calls'

export function record(db: Db, s: Score): number {
  return Number(db.prepare(`INSERT INTO bench_scorecard (${COLUMNS})
    VALUES (@plan, @target, @generator, @catches, @false_positives, @untested, @tokens, @seconds, @x_ray, @pre_fix_calls, @fix_calls)`).run(s).lastInsertRowid)
}

export function setUntested(db: Db, plan: number, untested: number): void {
  db.prepare('UPDATE bench_scorecard SET untested = ? WHERE id = (SELECT max(id) FROM bench_scorecard WHERE plan = ?)').run(untested, plan)
}

export function supersede(db: Db, plan: number): number | null {
  const row = db.prepare('UPDATE bench_scorecard SET superseded = 1 WHERE plan = ? AND superseded = 0 RETURNING id').get(plan) as { id: number } | undefined
  return row?.id ?? null
}

export function scores(db: Db): Score[] {
  return db.prepare(`SELECT ${COLUMNS} FROM bench_scorecard ORDER BY id`).all() as Score[]
}

export function underpowered(db: Db, floor: number): Score[] {
  return db.prepare(`SELECT ${COLUMNS} FROM bench_scorecard
    WHERE superseded = 0 AND (pre_fix_calls < @floor OR fix_calls < @floor) ORDER BY id`).all({ floor }) as Score[]
}
