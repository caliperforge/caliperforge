import type { Db } from './index.ts'

export interface Merge {
  main: string
  incoming: string[]
  mine: string[]
  overlap: boolean
}

/**
 * #130. Every merge from main leaves this row: the files main brought in, the files the job had
 * changed since its branch point, and whether they touch. #60 part b is the decision that reads it;
 * this part only records, so a merge that brings in nothing still leaves a row with empty sets.
 */
export function record(db: Db, plan: number, step: number, m: Merge): number {
  const row = db.prepare(`INSERT INTO merges (plan, step, at, main, incoming, mine, overlap)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(plan, step, new Date().toISOString(), m.main, JSON.stringify(m.incoming), JSON.stringify(m.mine),
      m.overlap ? 1 : 0)
  return Number(row.lastInsertRowid)
}

/** The last merge recorded on a plan, or null where none has happened. */
export function last(db: Db, plan: number): Merge | null {
  const row = db.prepare('SELECT main, incoming, mine, overlap FROM merges WHERE plan = ? ORDER BY id DESC LIMIT 1')
    .get(plan) as { main: string; incoming: string; mine: string; overlap: number } | undefined
  if (row === undefined) return null
  return {
    main: row.main,
    incoming: JSON.parse(row.incoming) as string[],
    mine: JSON.parse(row.mine) as string[],
    overlap: row.overlap === 1,
  }
}
