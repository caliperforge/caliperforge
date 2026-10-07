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

export function newestAccount(db: Db, repo: string): unknown {
  return db.prepare('SELECT id, measured_at, pulse FROM accounts WHERE repo = ? ORDER BY measured_at DESC LIMIT 1').get(repo)
}

export function upsertTarget(db: Db, row: Target & { part: string; ineligible_ruling_id: number | null }): number {
  db.prepare(`INSERT INTO targets (account_id, repo, issue_no, part, named_merger, state, evidence_measured_at, evidence, ineligible_ruling_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo, issue_no, part) DO UPDATE SET account_id = excluded.account_id, named_merger = excluded.named_merger,
      state = excluded.state, evidence_measured_at = excluded.evidence_measured_at, evidence = excluded.evidence,
      ineligible_ruling_id = excluded.ineligible_ruling_id`)
    .run(row.account_id, row.repo, row.issue_no, row.part, row.named_merger, row.state, row.evidence_measured_at, row.evidence, row.ineligible_ruling_id)
  const id = db.prepare('SELECT id FROM targets WHERE repo = ? AND issue_no = ? AND part = ?').get(row.repo, row.issue_no, row.part) as { id: number }
  return id.id
}

export interface Scanned { repo: string; issue_no: number; part: string; evidence_measured_at: string; state: string; evidence: string }

export function scannedTarget(db: Db, id: number): Scanned {
  const t = db.prepare('SELECT repo, issue_no, part, evidence_measured_at, state, evidence FROM targets WHERE id = ?').get(id) as Scanned | undefined
  if (t === undefined) throw new Error(`no target ${String(id)}`)
  return t
}

export function ineligibleRuling(db: Db, id: number): number | null {
  return db.prepare('SELECT ineligible_ruling_id FROM targets WHERE id = ?').pluck().get(id) as number | null
}

export function setEvidence(db: Db, id: number, url: string | null): void {
  db.prepare('UPDATE targets SET evidence = coalesce(?, evidence) WHERE id = ?').run(url, id)
}

export function setTake(db: Db, id: number, take: string): void {
  if (db.prepare('UPDATE targets SET coo_take = ? WHERE id = ?').run(take, id).changes === 0) throw new Error(`no target ${String(id)}`)
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
