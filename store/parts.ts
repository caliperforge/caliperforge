import type { Db } from './index.ts'
import type { PlanRow } from './plans.ts'

export interface Part { parent: number; n: number; url: string; title: string; body: string; plan: number | null; after: number | null }

export function addPart(db: Db, row: Omit<Part, 'plan' | 'after'> & { plan?: number | null; after?: number | null }): void {
  db.prepare('INSERT INTO parts (parent, n, url, title, body, plan, after) VALUES (@parent, @n, @url, @title, @body, @plan, @after)')
    .run({ ...row, plan: row.plan ?? null, after: row.after ?? null })
}

export function allParts(db: Db): Part[] {
  return db.prepare('SELECT * FROM parts ORDER BY parent, n').all() as Part[]
}

export function partOf(db: Db, plan: number): { parent: number; n: number } | undefined {
  return db.prepare('SELECT parent, n FROM parts WHERE plan = ?').get(plan) as { parent: number; n: number } | undefined
}

export function waitingOn(db: Db, parent: number, n: number): number[] {
  return (db.prepare('SELECT n FROM parts WHERE parent = ? AND after = ? AND plan IS NULL').all(parent, n) as { n: number }[]).map((r) => r.n)
}

export function partsOf(db: Db, parent: number): Part[] {
  return db.prepare('SELECT * FROM parts WHERE parent = ? ORDER BY n').all(parent) as Part[]
}

export function partAt(db: Db, parent: number, n: number): Part | undefined {
  return db.prepare('SELECT * FROM parts WHERE parent = ? AND n = ?').get(parent, n) as Part | undefined
}

export function claimedPart(db: Db, url: string): number | null {
  const row = db.prepare('SELECT plan FROM parts WHERE url = ? AND plan IS NOT NULL').get(url) as { plan: number } | undefined
  return row?.plan ?? null
}

export function releasable(db: Db, repo: string): { parent: number; n: number; after: number }[] {
  return db.prepare(`SELECT p.parent, p.n, a.value AS after FROM parts p
    JOIN tickets t ON p.url = 'https://github.com/' || t.repo || '/issues/' || t.number, json_each(t.after) a
    WHERE p.plan IS NULL AND t.repo = ? AND t.closed_at IS NULL`).all(repo) as { parent: number; n: number; after: number }[]
}

export function queuePart(db: Db, parent: PlanRow, n: number, url: string, lane: string, seat: string): number {
  const inserted = db.prepare(`INSERT INTO plans (pipe_id, target_id, template, state, queued_at, step, retries, priority, lane, seat, origin)
    VALUES (?, ?, ?, 'queued', ?, 0, 0, ?, ?, ?, ?)`)
    .run(parent.pipe_id, parent.target_id, parent.template, new Date().toISOString(), parent.priority, lane, seat, url)
  const id = Number(inserted.lastInsertRowid)
  db.prepare('UPDATE parts SET plan = ? WHERE parent = ? AND n = ?').run(id, parent.id, n)
  return id
}
