import type { Db } from './index.ts'

export interface Edited {
  id: number
  title: string
  dek: string
  body: string
  edited_title: string | null
  edited_dek: string | null
  edited_body: string | null
  note: string | null
}

export function edited(db: Db): Edited[] {
  return db.prepare(`SELECT id, title, dek, body, edited_title, edited_dek, edited_body, note FROM desk_posts
    WHERE edited_title IS NOT NULL OR edited_dek IS NOT NULL OR edited_body IS NOT NULL ORDER BY id`).all() as Edited[]
}

export interface Post extends Edited {
  kind: string
  dest: 'site' | 'substack' | 'note' | 'pack' | 'scorecard'
  status: 'proof' | 'approved' | 'changes' | 'published'
  sources: string
  checks: string
  work_date: string
  written_date: string
  order: number | null
  proof_at: string | null
}

export function posts(db: Db): Post[] {
  return db.prepare('SELECT * FROM desk_posts ORDER BY id').all() as Post[]
}

export function putPost(db: Db, p: Pick<Post, 'id' | 'kind' | 'dest' | 'status' | 'title' | 'dek' | 'body' | 'edited_title' | 'sources'
  | 'checks' | 'work_date' | 'written_date'>): void {
  db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, edited_title, sources, checks, work_date, written_date)
    VALUES (@id, @kind, @dest, @status, @title, @dek, @body, @edited_title, @sources, @checks, @work_date, @written_date)`).run(p)
}

export function learnings(db: Db): { date: string; numbers: string | null; items: string | null; sources: string | null }[] {
  return db.prepare('SELECT date, numbers, items, sources FROM desk_learnings ORDER BY date')
    .all() as { date: string; numbers: string | null; items: string | null; sources: string | null }[]
}

export function learningsIn(db: Db, from: string, to: string): { date: string; items: unknown[] }[] {
  const rows = db.prepare('SELECT date, items FROM desk_learnings WHERE date BETWEEN ? AND ? ORDER BY date').all(from, to) as
    { date: string; items: string | null }[]
  return rows.map((r) => ({ date: r.date, items: JSON.parse(r.items ?? '[]') as unknown[] }))
}
