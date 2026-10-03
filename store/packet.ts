import type { Db } from './index.ts'
import { zone } from './lanes.ts'
import { ofDay } from './refusals.ts'

/** What was learned, drifted, decided, landed and refused on the local day `plan`'s title ends in, or today. */
export function packetOf(db: Db, plan: number) {
  const minutes = zone(db)
  const { title } = db.prepare('SELECT title FROM plans WHERE id = ?').get(plan) as { title: string | null }
  const day = /\d{4}-\d{2}-\d{2}$/.exec(title ?? '')?.[0] ?? new Date(Date.now() + minutes * 60000).toISOString().slice(0, 10)
  const shift = `${String(minutes)} minutes`
  const on = [shift, shift, day]
  const learned = db.prepare('SELECT items FROM desk_learnings WHERE date = ?').get(day) as { items: string } | undefined
  return {
    day,
    learned: JSON.parse(learned?.items ?? '[]') as unknown[],
    drift: db.prepare(`SELECT number, title, datetime(opened_at, ?) AS at FROM tickets
      WHERE title GLOB 'Drift: *' AND date(opened_at, ?) = ? ORDER BY opened_at, number`).all(...on),
    decisions: db.prepare(`SELECT e.plan, p.title, e.actor, e.kind, e.message AS why, datetime(e.at, ?) AS at FROM events e
      LEFT JOIN plans p ON p.id = e.plan WHERE e.actor IN ('director', 'coo_lite') AND date(e.at, ?) = ? ORDER BY e.id`).all(...on),
    landed: db.prepare(`SELECT p.id AS plan, p.origin, a.subject_digest AS digest, p.title, datetime(a.approved_at, ?) AS at FROM plans p
      JOIN approvals a ON a.subject_kind = 'plan' AND a.subject_id = p.id AND a.who = 'gates'
      WHERE p.origin IS NOT NULL AND a.subject_digest = p.head_digest AND date(a.approved_at, ?) = ? ORDER BY p.id`).all(...on),
    refusals: ofDay(db, day, minutes),
  }
}
