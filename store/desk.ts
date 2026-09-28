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

export interface Approved {
  id: number
  title: string
  dek: string
  body: string
  work_date: string
  written_date: string
}

export function approvedSite(db: Db): Approved[] {
  return db.prepare(`SELECT id, COALESCE(edited_title, title) AS title, COALESCE(edited_dek, dek) AS dek,
    COALESCE(edited_body, body) AS body, work_date, written_date
    FROM desk_posts WHERE dest = 'site' AND status = 'approved' ORDER BY id`).all() as Approved[]
}

export function published(db: Db, id: number): void {
  db.prepare("UPDATE desk_posts SET status = 'published' WHERE id = ?").run(id)
}
