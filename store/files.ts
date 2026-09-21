import type { Db } from './index.ts'

export interface PlanFile {
  path: string
  is_new: boolean
}

export function filesOf(db: Db, plan: number): PlanFile[] {
  return (db.prepare('SELECT path, is_new FROM plan_files WHERE plan = ? ORDER BY position').all(plan) as
    { path: string; is_new: number }[]).map((r) => ({ path: r.path, is_new: r.is_new === 1 }))
}

export function record(db: Db, plan: number, list: PlanFile[]): void {
  const insert = db.prepare('INSERT INTO plan_files (plan, path, is_new, position) VALUES (?, ?, ?, ?)')
  db.transaction(() => {
    db.prepare('DELETE FROM plan_files WHERE plan = ?').run(plan)
    list.forEach((file, at) => void insert.run(plan, file.path, file.is_new ? 1 : 0, at))
  })()
}
