import { join } from 'node:path'
import { fresh } from '../../checks/sqlite.ts'
import type { Db } from '../../store/index.ts'
import type { Row } from '../record.ts'

const schema = join(import.meta.dirname, '../../schema')
export const REPO = 'acme/widget'
export const MERGED = `https://github.com/${REPO}/pull/3`
export const OPEN = `https://github.com/${REPO}/pull/4`

export interface World { db: Db; ready: number; queued: number; plan: number }

export function world(): World {
  const db = fresh(schema)
  db.prepare(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
    VALUES (1, ?, '2026-09-01', 1, 1, '2026-08-01', 0, 0, 'cold', 'https://github.com/acme/widget/pulse')`).run(REPO)
  const pipe = Number(db.prepare(`INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent)
    VALUES ('scan', 1, '00:00', '23:59', 1)`).run().lastInsertRowid)
  const ready = Number(db.prepare(`INSERT INTO targets (account_id, repo, issue_no, named_merger, state, evidence_measured_at,
    evidence, issue_opened_at, issue_active_at, open_pr, open_pr_draft, size_lines)
    VALUES (1, ?, 1, 'maintainer', 'ready', '2026-09-01', 'https://github.com/acme/widget/issues/1',
      '2026-09-01', '2026-09-20', NULL, NULL, 3)`).run(REPO).lastInsertRowid)
  const queued = Number(db.prepare(`INSERT INTO targets (account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, ?, 50, 'maintainer', 'queued', '2026-09-01', 'https://github.com/acme/widget/issues/50')`).run(REPO).lastInsertRowid)
  const plan = Number(db.prepare(`INSERT INTO plans (pipe_id, target_id, template, state, queued_at, step, retries)
    VALUES (?, ?, 'pr_path', 'queued', '2026-09-20T00:00:00.000Z', 0, 0)`).run(pipe, queued).lastInsertRowid)
  const put = db.prepare(`INSERT INTO records (repo, pr, plan, url, state, merged_at, read_at)
    VALUES (?, ?, ?, ?, ?, ?, '2026-09-25T00:00:00Z')`)
  put.run(REPO, 3, plan, MERGED, 'MERGED', '2026-09-24T00:00:00Z')
  put.run(REPO, 4, plan, OPEN, 'OPEN', null)
  return { db, ready, queued, plan }
}

export const rows = (db: Db): Row[] => db.prepare('SELECT * FROM records ORDER BY pr').all() as Row[]
