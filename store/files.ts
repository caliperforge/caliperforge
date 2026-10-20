import { SEED } from '../cli/digests.ts'
import { logged } from './events.ts'
import type { Db } from './index.ts'
import { held } from './leases.ts'
import { BUILT, type Holder } from './plans.ts'

export interface PlanFile {
  path: string
  is_new: boolean
}

export function filesOf(db: Db, plan: number): PlanFile[] {
  return (db.prepare('SELECT path, is_new FROM plan_files WHERE plan = ? AND stray = 0 ORDER BY position').all(plan) as
    { path: string; is_new: number }[]).map((r) => ({ path: r.path, is_new: r.is_new === 1 }))
}

/** Paths the build wrote that the list did not name, kept apart so only the overlap check reads them. */
export function strays(db: Db, plan: number, paths: string[]): void {
  const insert = db.prepare(`INSERT INTO plan_files (plan, path, is_new, position, stray)
    SELECT ?, ?, 0, coalesce(max(position) + 1, 0), 1 FROM plan_files WHERE plan = ?`)
  const known = new Set((db.prepare('SELECT path FROM plan_files WHERE plan = ?').all(plan) as { path: string }[]).map((r) => r.path))
  db.transaction(() => {
    for (const path of paths.filter((p) => !known.has(p))) insert.run(plan, path, plan)
  })()
}

/** A path the build already wrote is a stray row: it is listed by clearing the flag, never by a second row. */
export function listed(db: Db, plan: number, path: string, isNew = true): void {
  const held = db.prepare('SELECT 1 FROM plan_files WHERE plan = ? AND path = ?').get(plan, path)
  if (held !== undefined) {
    db.prepare('UPDATE plan_files SET stray = 0 WHERE plan = ? AND path = ?').run(plan, path)
    return
  }
  const next = db.prepare('SELECT coalesce(max(position), -1) + 1 AS n FROM plan_files WHERE plan = ?').get(plan) as { n: number }
  db.prepare('INSERT INTO plan_files (plan, path, is_new, position, stray) VALUES (?, ?, ?, ?, 0)').run(plan, path, isNew ? 1 : 0, next.n)
}

export const VERBS = ['set', 'add', 'drop'] as const

export function edit(db: Db, plan: number, verb: typeof VERBS[number], path: string, actor: Holder | 'ruling', why: string | null, isNew = true): void {
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM plans WHERE id = ?').get(plan) === undefined) throw new Error(`no plan ${String(plan)}`)
    if (verb === 'drop' && db.prepare('DELETE FROM plan_files WHERE plan = ? AND path = ? AND stray = 0').run(plan, path).changes === 0) {
      throw new Error(`plan ${String(plan)} does not list ${path}`)
    }
    if (verb === 'set') db.prepare('DELETE FROM plan_files WHERE plan = ? AND path <> ? AND stray = 0').run(plan, path)
    if (verb !== 'drop') listed(db, plan, path, isNew)
    const message = `${verb} ${path}${why === null ? '' : `: ${why}`}`
    logged(db, { plan, kind: 'files', actor, outcome: 'pass', message, pointer: null, run: null })
  })()
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

/** Another job `o` in the same repo, not settled and past its brief, listing a path of plan `me` other than the seed and `.cf/`. */
const SHARED = `FROM plans me
    JOIN plan_files mine ON mine.plan = me.id
    JOIN plan_files f ON f.path = mine.path AND f.plan <> me.id
    JOIN plans o ON o.id = f.plan
    WHERE me.id = ? AND o.state IN ('queued', 'running') AND o.step >= 2 AND mine.path NOT LIKE '.cf/%' AND mine.path <> ?
      AND ${REPO.replace('%s', 'o')} = ${REPO.replace('%s', 'me')}`

/**
 * The job this plan must wait for: one in the same repo, not settled, past its brief, whose file
 * list shares a path with this one's -- and either building already or ahead of it in queue order
 * (priority, then age), so two unbuilt plans never wait on each other and a P0 never waits on an unbuilt P1. A plan waiting on a person or stopped holds nothing up.
 * A built lower-priority plan holds a plan back only while a tick holds its lease.
 */
export function sharing(db: Db, plan: number): { plan: number; path: string } | null {
  const leased = held(db).map((l) => l.plan)
  return (db.prepare(`SELECT o.id AS plan, f.path ${SHARED}
      AND (o.priority < me.priority OR (o.priority = me.priority AND o.id < me.id)
        OR (EXISTS (SELECT 1 FROM runs r WHERE r.plan = o.id AND r.step >= 2 AND r.${BUILT})
          AND (o.priority <= me.priority OR o.id IN (SELECT value FROM json_each(?)))))
    ORDER BY o.priority, o.id LIMIT 1`).get(plan, SEED, JSON.stringify(leased)) ?? null) as { plan: number; path: string } | null
}

/** The higher-priority job sharing a path that this built plan stands aside for when its step ends. */
export function ahead(db: Db, plan: number): number | null {
  const row = db.prepare(`SELECT o.id AS plan ${SHARED}
      AND me.state IN ('queued', 'running') AND o.priority < me.priority
      AND COALESCE(o.wait_reason, '') <> 'ceo_batch'
      AND EXISTS (SELECT 1 FROM runs r WHERE r.plan = me.id AND r.step >= 2 AND r.${BUILT})
    ORDER BY o.priority, o.id LIMIT 1`).get(plan, SEED) as { plan: number } | undefined
  return row?.plan ?? null
}

/** Every path the plan holds, strays included. */
export function recorded(db: Db, plan: number): string[] {
  return (db.prepare('SELECT path FROM plan_files WHERE plan = ? ORDER BY position').all(plan) as { path: string }[]).map((r) => r.path)
}

/**
 * An older job already building, in the same repo, whose recorded set holds one of `paths`. Only an
 * older one that has built: a younger job, or one not yet built, is the one `sharing` holds back.
 */
export function building(db: Db, plan: number, paths: string[]): { plan: number; path: string } | null {
  if (paths.length === 0) return null
  return (db.prepare(`SELECT o.id AS plan, f.path FROM plans me
    JOIN plans o ON o.id < me.id
    JOIN plan_files f ON f.plan = o.id
    WHERE me.id = ? AND f.path IN (SELECT value FROM json_each(?))
      AND o.state IN ('queued', 'running') AND o.step >= 2
      AND COALESCE(o.wait_reason, '') <> 'ceo_batch'
      AND ${REPO.replace('%s', 'o')} = ${REPO.replace('%s', 'me')}
      AND EXISTS (SELECT 1 FROM runs r WHERE r.plan = o.id AND r.step >= 2 AND r.${BUILT})
    ORDER BY o.id LIMIT 1`).get(plan, JSON.stringify(paths)) ?? null) as { plan: number; path: string } | null
}
