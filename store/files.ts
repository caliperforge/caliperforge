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

/** The repo a plan's paths are relative to: its target's, or ours. */
const REPO = "COALESCE((SELECT t.repo FROM targets t WHERE t.id = %s.target_id), '')"

/**
 * #88. The job this plan must wait for: one in the same repo, not settled, past its brief, whose file
 * list shares a path with this one's -- and either building already or queued ahead of it, so two
 * unbuilt plans never wait on each other. A plan parked on the CEO or stopped holds nothing up.
 */
export function sharing(db: Db, plan: number): { plan: number; path: string } | null {
  return (db.prepare(`SELECT o.id AS plan, f.path FROM plans me
    JOIN plan_files mine ON mine.plan = me.id
    JOIN plan_files f ON f.path = mine.path AND f.plan <> me.id
    JOIN plans o ON o.id = f.plan
    WHERE me.id = ? AND o.state IN ('queued', 'running') AND o.step >= 2
      AND ${REPO.replace('%s', 'o')} = ${REPO.replace('%s', 'me')}
      AND (o.id < me.id OR EXISTS (SELECT 1 FROM runs r WHERE r.plan = o.id AND r.step >= 2))
    ORDER BY o.id LIMIT 1`).get(plan) ?? null) as { plan: number; path: string } | null
}
