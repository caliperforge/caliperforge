import type { Db } from './index.ts'

export interface Limit { repo: string; lines: number; origin_kind: 'rail' | 'ruling' | 'incident'; origin_ref: string; set_at: string }

export function setLimit(db: Db, row: Limit): void {
  db.prepare('INSERT INTO size_limits (repo, lines, origin_kind, origin_ref, set_at) VALUES (@repo, @lines, @origin_kind, @origin_ref, @set_at)')
    .run(row)
}
