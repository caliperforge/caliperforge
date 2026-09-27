import type { Db } from './index.ts'

export interface Count { metric: string; count: number }
export interface Warning { plan: number; at: string; message: string }
export interface Raise { key: string; value: string; origin_kind: string; origin_ref: string; set_at: string }

export function record(db: Db, day: string, rows: Count[]): void {
  const put = db.prepare('INSERT OR REPLACE INTO ratchet_counts (day, metric, count) VALUES (?, ?, ?)')
  for (const r of rows) put.run(day, r.metric, r.count)
}

export function counted(db: Db, day: string): Map<string, number> {
  const rows = db.prepare('SELECT metric, count FROM ratchet_counts WHERE day = ?').all(day) as Count[]
  return new Map(rows.map((r) => [r.metric, r.count]))
}

export function warnings(db: Db, since: string): Warning[] {
  return db.prepare(`SELECT plan, at, message FROM events
    WHERE kind = 'ratchet' AND message GLOB 'would refuse: *' AND at >= ? ORDER BY at, id`).all(since) as Warning[]
}

export function raises(db: Db): Raise[] {
  return db.prepare(`SELECT key, value, origin_kind, origin_ref, set_at FROM settings
    WHERE key GLOB 'ratchet.raise.*' ORDER BY key`).all() as Raise[]
}
