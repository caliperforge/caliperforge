import type { Db } from './index.ts'

export interface PlanFile {
  path: string
  is_new: boolean
}

export function record(db: Db, plan: number, list: PlanFile[]): void {
  const insert = db.prepare('INSERT INTO plan_files (plan, path, is_new, position) VALUES (?, ?, ?, ?)')
  db.transaction(() => {
    db.prepare('DELETE FROM plan_files WHERE plan = ?').run(plan)
    list.forEach((file, at) => void insert.run(plan, file.path, file.is_new ? 1 : 0, at))
  })()
}
