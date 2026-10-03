import type { Db } from './index.ts'

export function setting(db: Db, key: string): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value
}

export function holds(db: Db, condition: string): boolean {
  return (db.prepare(`SELECT (${condition}) AS on_`).get() as { on_: number }).on_ === 1
}

export function newest(db: Db, from: string, column: string, now: Date): { newest: string | number | null; days: number | null } {
  return db.prepare(`SELECT max(${column}) AS newest, julianday(?) - julianday(max(${column})) AS days FROM ${from}`)
    .get(now.toISOString()) as { newest: string | number | null; days: number | null }
}

export function openTicket(db: Db, repo: string, title: string): boolean {
  return db.prepare('SELECT 1 FROM tickets WHERE repo = ? AND title = ? AND closed_at IS NULL').get(repo, title) !== undefined
}

export interface Drift { number: number; title: string; days: number | null }

export function drifts(db: Db, repo: string, now: Date): Drift[] {
  return db.prepare(`SELECT number, title, CAST(julianday(?) - julianday(opened_at) AS INTEGER) AS days FROM tickets
    WHERE repo = ? AND title GLOB 'Drift: *' AND closed_at IS NULL ORDER BY opened_at, number`).all(now.toISOString(), repo) as Drift[]
}
