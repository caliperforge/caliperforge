import { join } from 'node:path'
import { fresh } from '../../checks/sqlite.ts'
import type { Db } from '../../store/index.ts'
import { addPipe, addPlan, pipeNamed } from '../../store/plans.ts'
import { addRecord, recordsOf } from '../../store/record.ts'
import { addAccount, addTarget, putTarget } from '../../store/targets.ts'
import type { Row } from '../record.ts'

const schema = join(import.meta.dirname, '../../schema')
export const REPO = 'acme/widget'
export const MERGED = `https://github.com/${REPO}/pull/3`
export const OPEN = `https://github.com/${REPO}/pull/4`

export interface World { db: Db; ready: number; queued: number; plan: number }

export function world(): World {
  const db = fresh(schema)
  addAccount(db, { id: 1, repo: REPO, measured_at: '2026-09-01', maintainers: 1, doors: 1, last_outsider_merge: '2026-08-01',
    open_pr_age_p50_days: 0, cross_repo_activity: 0, pulse: 'cold', evidence: 'https://github.com/acme/widget/pulse' })
  addPipe(db, { name: 'scan', enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 1 })
  const pipe = Number(pipeNamed(db, 'scan')?.id)
  const ready = 1
  putTarget(db, { id: ready, account_id: 1, repo: REPO, issue_no: 1, named_merger: 'maintainer', state: 'ready',
    evidence_measured_at: '2026-09-01', evidence: 'https://github.com/acme/widget/issues/1',
    issue_opened_at: '2026-09-01', issue_active_at: '2026-09-20', open_pr: null, open_pr_draft: null, size_lines: 3 })
  const queued = addTarget(db, { account_id: 1, repo: REPO, issue_no: 50, named_merger: 'maintainer', state: 'queued',
    evidence_measured_at: '2026-09-01', evidence: 'https://github.com/acme/widget/issues/50' })
  const plan = addPlan(db, { pipe_id: pipe, target_id: queued, template: 'pr_path', state: 'queued',
    queued_at: '2026-09-20T00:00:00.000Z', step: 0, lane: null, seat: null, origin: null })
  const read_at = '2026-09-25T00:00:00Z'
  addRecord(db, { repo: REPO, pr: 3, plan, url: MERGED, state: 'MERGED', merged_at: '2026-09-24T00:00:00Z', read_at })
  addRecord(db, { repo: REPO, pr: 4, plan, url: OPEN, state: 'OPEN', merged_at: null, read_at })
  return { db, ready, queued, plan }
}

export const rows = (db: Db): Row[] => recordsOf(db, REPO) as Row[]
