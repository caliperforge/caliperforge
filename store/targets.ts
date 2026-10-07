import type { Db } from './index.ts'

export interface Target {
  account_id: number
  repo: string
  issue_no: number
  named_merger: string
  state: 'cold' | 'ready' | 'queued' | 'parked' | 'refused'
  evidence_measured_at: string
  evidence: string
}

interface Account {
  id: number
  repo: string
  measured_at: string
  maintainers: number
  doors: number
  last_outsider_merge: string | null
  open_pr_age_p50_days: number
  cross_repo_activity: number
  pulse: 'warm' | 'cold'
  evidence: string
}

export function addAccount(db: Db, row: Account): void {
  db.prepare(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
    VALUES (@id, @repo, @measured_at, @maintainers, @doors, @last_outsider_merge,
    @open_pr_age_p50_days, @cross_repo_activity, @pulse, @evidence)`).run(row)
}

export function accountRows(db: Db): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM accounts ORDER BY id').all() as Record<string, unknown>[]
}

export function targetRows(db: Db): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM targets ORDER BY id').all() as Record<string, unknown>[]
}

export function putTarget(db: Db, row: Record<string, unknown>): void {
  const keys = Object.keys(row)
  db.prepare(`INSERT INTO targets (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`).run(row)
}

export function addTarget(db: Db, row: Target): number {
  return Number(db.prepare(`INSERT INTO targets (account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (@account_id, @repo, @issue_no, @named_merger, @state, @evidence_measured_at, @evidence)`).run(row).lastInsertRowid)
}

export function targetRow(db: Db, id: number): Target {
  const row = db.prepare(`SELECT account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence
    FROM targets WHERE id = ?`).get(id) as Target | undefined
  if (row === undefined) throw new Error(`no target ${String(id)}`)
  return row
}

export function setTargetState(db: Db, id: number, state: Target['state']): void {
  db.prepare('UPDATE targets SET state = ? WHERE id = ?').run(state, id)
}
