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
