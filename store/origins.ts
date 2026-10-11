import type { Db } from './index.ts'

export interface Queued { pipe_id: number; template: string; priority: number; lane: string; seat: string; origin: string }

export function seen(db: Db): Set<string> {
  return new Set((db.prepare('SELECT origin AS url FROM plans WHERE origin IS NOT NULL UNION SELECT url FROM parts').all() as
    { url: string }[]).map((r) => r.url))
}

export function planOfOrigin(db: Db, url: string): number | null {
  const row = db.prepare('SELECT id FROM plans WHERE origin = ?').get(url) as { id: number } | undefined
  return row?.id ?? null
}

export function lanePipe(db: Db, name: string): void {
  db.prepare("INSERT OR IGNORE INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES (?, 0, '07:00', '22:00', 1)").run(name)
}

export function queueOrigin(db: Db, row: Queued): number {
  const made = db.prepare(`INSERT INTO plans (pipe_id, template, state, queued_at, step, retries, priority, lane, seat, origin)
    VALUES (?, ?, 'queued', ?, 0, 0, ?, ?, ?, ?)`)
    .run(row.pipe_id, row.template, new Date().toISOString(), row.priority, row.lane, row.seat, row.origin)
  return Number(made.lastInsertRowid)
}
