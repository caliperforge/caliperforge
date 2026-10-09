import type { Db } from './index.ts'

export function setting(db: Db, key: string): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value
}

interface Setting { key: string; value: string; who: 'ceo' | 'pr'; origin_kind: 'rail' | 'ruling' | 'incident'; origin_ref: string; set_at: string }

export function addSetting(db: Db, row: Setting): void {
  db.prepare('INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at) VALUES (@key, @value, @who, @origin_kind, @origin_ref, @set_at)')
    .run(row)
}

export function holds(db: Db, condition: string, since: string): boolean {
  return (db.prepare(`SELECT (${condition}) AS on_`).get({ since }) as { on_: number }).on_ === 1
}

export function worked(db: Db, select: string, since: string): boolean {
  return db.prepare(select).get({ since }) !== undefined
}

export function newest(db: Db, from: string, column: string, now: Date): { newest: string | number | null; days: number | null } {
  return db.prepare(`SELECT max(${column}) AS newest, julianday(?) - julianday(max(${column})) AS days FROM ${from}`)
    .get(now.toISOString()) as { newest: string | number | null; days: number | null }
}

export interface Stalled { id: number; step: number; wait_reason: string | null; waits_on: number | null; last: string | null }

export function stalled(db: Db, pipes: number[]): Stalled[] {
  return db.prepare(`SELECT id, step, wait_reason, waits_on,
      (SELECT message FROM events WHERE plan = plans.id ORDER BY id DESC LIMIT 1) AS last
    FROM plans WHERE state IN ('queued', 'running') AND step > 0 AND pipe_id IN (SELECT value FROM json_each(?))
      AND coalesce(wait_reason, '') NOT IN ('ceo_batch', 'target_approval', 'file_overlap') ORDER BY id`).all(JSON.stringify(pipes)) as Stalled[]
}

export interface Finding {
  id: number
  name: string
  state: 'off' | 'silent' | 'stale' | 'seen'
  detail: string
  found_at: string
  outcome: 'fixed' | 'covered' | 'retire' | 'defect' | null
  why: string | null
  ref: string | null
  closed_at: string | null
}

export function addFinding(db: Db, found: Pick<Finding, 'name' | 'state' | 'detail'>, now: Date): number | null {
  const ran = db.prepare('INSERT OR IGNORE INTO drift_findings (name, state, detail, found_at) VALUES (@name, @state, @detail, @at)')
    .run({ ...found, at: now.toISOString() })
  return ran.changes === 1 ? Number(ran.lastInsertRowid) : null
}

export function closeFinding(db: Db, id: number, outcome: NonNullable<Finding['outcome']>, why: string, ref: string | null, now: Date): void {
  db.prepare('UPDATE drift_findings SET outcome = ?, why = ?, ref = ?, closed_at = ? WHERE id = ? AND closed_at IS NULL')
    .run(outcome, why, ref, now.toISOString(), id)
}

export function findings(db: Db): Finding[] {
  return db.prepare('SELECT * FROM drift_findings ORDER BY id').all() as Finding[]
}

export function unanswered(db: Db, now: Date): Finding[] {
  return db.prepare(`SELECT * FROM drift_findings f WHERE closed_at IS NULL AND NOT EXISTS (SELECT 1 FROM events
    WHERE kind = 'director' AND plan IS NULL AND pointer = 'finding ' || f.id AND julianday(at) >= julianday(?, '-1 day'))
    ORDER BY id`).all(now.toISOString()) as Finding[]
}

export function asked(db: Db, now: Date): number {
  return db.prepare(`SELECT count(*) FROM events WHERE kind = 'director' AND plan IS NULL AND pointer LIKE 'finding %'
    AND julianday(at) >= julianday(?, '-1 day')`).pluck().get(now.toISOString()) as number
}

export function week(db: Db, now: Date): Finding[] {
  return db.prepare("SELECT * FROM drift_findings WHERE julianday(found_at) >= julianday(?, '-7 day') ORDER BY id")
    .all(now.toISOString()) as Finding[]
}

export function overdue(db: Db, now: Date): Finding[] {
  return db.prepare('SELECT * FROM drift_findings WHERE closed_at IS NULL AND julianday(?) - julianday(found_at) > 1 ORDER BY id')
    .all(now.toISOString()) as Finding[]
}
