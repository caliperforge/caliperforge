import type { Db } from './index.ts'

export interface Merge {
  main: string
  incoming: string[]
  mine: string[]
  overlap: boolean
  clean: boolean
}

export interface Recorded extends Merge {
  id: number
  /** The newest verdict on the plan when the merge was made; null where there was none. */
  verdict: number | null
}

/**
 * #130. Every merge from main leaves this row: the files main brought in, the files the job had
 * changed since its branch point, whether they touch, and whether git took it. A merge that brings
 * in nothing still leaves a row with empty sets. #131 reads it to decide whether the reviews stand.
 */
export function record(db: Db, plan: number, step: number, m: Merge): number {
  const newest = db.prepare('SELECT max(id) AS id FROM verdicts WHERE plan = ?').get(plan) as { id: number | null }
  const row = db.prepare(`INSERT INTO merges (plan, step, at, main, incoming, mine, overlap, clean, verdict)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(plan, step, new Date().toISOString(), m.main, JSON.stringify(m.incoming), JSON.stringify(m.mine),
      m.overlap ? 1 : 0, m.clean ? 1 : 0, newest.id)
  return Number(row.lastInsertRowid)
}

/** The last merge recorded on a plan, or null where none has happened. */
export function last(db: Db, plan: number): Recorded | null {
  const row = db.prepare(`SELECT id, main, incoming, mine, overlap, clean, verdict FROM merges
    WHERE plan = ? ORDER BY id DESC LIMIT 1`).get(plan) as
    { id: number; main: string; incoming: string; mine: string; overlap: number; clean: number | null; verdict: number | null } | undefined
  if (row === undefined) return null
  return {
    id: row.id,
    main: row.main,
    incoming: JSON.parse(row.incoming) as string[],
    mine: JSON.parse(row.mine) as string[],
    overlap: row.overlap === 1,
    clean: row.clean === 1,
    verdict: row.verdict,
  }
}

export interface Given { id: number; outcome: string; subject_digest: string; tree: string | null }

/** The verdict a review gate last gave on a plan. */
export function lastReview(db: Db, plan: number, gate: string): Given | null {
  return (db.prepare(`SELECT id, outcome, subject_digest, tree FROM verdicts
    WHERE plan = ? AND gate = ? AND kind = 'review' ORDER BY id DESC LIMIT 1`).get(plan, gate) ?? null) as Given | null
}

/** A review verdict carried across a merge: the same outcome and tree, no tokens, and the merge that let it stand. */
export function keep(db: Db, plan: number, step: number, gate: string, from: Given, merge: number): number {
  const row = db.prepare(`INSERT INTO verdicts
    (gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds, tree, kept_by)
    VALUES (?, 'review', ?, ?, ?, 'pass', NULL, NULL, NULL, 0, 0, ?, ?)`)
    .run(gate, from.subject_digest, plan, step, from.tree, merge)
  return Number(row.lastInsertRowid)
}
