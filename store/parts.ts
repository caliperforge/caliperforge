import type { Db } from './index.ts'

export interface Part { parent: number; n: number; url: string; title: string; body: string; plan: number | null; after: number | null }

export function addPart(db: Db, row: Omit<Part, 'plan' | 'after'> & { plan?: number | null; after?: number | null }): void {
  db.prepare('INSERT INTO parts (parent, n, url, title, body, plan, after) VALUES (@parent, @n, @url, @title, @body, @plan, @after)')
    .run({ ...row, plan: row.plan ?? null, after: row.after ?? null })
}

export function allParts(db: Db): Part[] {
  return db.prepare('SELECT * FROM parts ORDER BY parent, n').all() as Part[]
}
