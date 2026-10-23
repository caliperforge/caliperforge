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

export interface Pulse {
  repo: string
  measured_at: string
  maintainers: number
  doors: number
  last_outsider_merge: string | null
  open_pr_age_p50_days: number
  cross_repo_activity: number
  open_loop: boolean
  pulse: 'warm' | 'cold'
  evidence: string
}

const UPSERT = `INSERT INTO accounts (repo, measured_at, maintainers, doors, last_outsider_merge,
  open_pr_age_p50_days, cross_repo_activity, open_loop, pulse, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (repo, measured_at) DO UPDATE SET maintainers = excluded.maintainers, doors = excluded.doors,
    last_outsider_merge = excluded.last_outsider_merge, open_pr_age_p50_days = excluded.open_pr_age_p50_days,
    cross_repo_activity = excluded.cross_repo_activity, open_loop = excluded.open_loop,
    pulse = excluded.pulse, evidence = excluded.evidence`

export function putPulse(db: Db, row: Pulse): void {
  db.prepare(UPSERT).run(row.repo, row.measured_at, row.maintainers, row.doors, row.last_outsider_merge,
    row.open_pr_age_p50_days, row.cross_repo_activity, row.open_loop ? 1 : 0, row.pulse, row.evidence)
}

/** Plan states a plan can still leave; a target under one of them is a loop of ours that is still open. */
const LIVE = "('queued', 'running', 'blocked_on_ceo')"

export function loopOpen(db: Db, repo: string): boolean {
  return db.prepare(`SELECT 1 FROM plans JOIN targets ON targets.id = plans.target_id
    WHERE targets.repo = ? AND plans.state IN ${LIVE} LIMIT 1`).get(repo) !== undefined
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

export interface TargetCard {
  repo: string
  issue_no: number
  named_merger: string
  issue_opened_at: string
  issue_active_at: string
  open_pr: number | null
  open_pr_draft: number | null
  size_lines: number
  evidence: string
}

const READY = `INSERT INTO targets (account_id, repo, issue_no, part, named_merger, state, evidence_measured_at, evidence,
  issue_opened_at, issue_active_at, open_pr, open_pr_draft, size_lines) VALUES (?, ?, ?, '', ?, 'ready', ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (repo, issue_no, part) DO UPDATE SET account_id = excluded.account_id, named_merger = excluded.named_merger,
    evidence_measured_at = excluded.evidence_measured_at, evidence = excluded.evidence,
    issue_opened_at = excluded.issue_opened_at, issue_active_at = excluded.issue_active_at, open_pr = excluded.open_pr,
    open_pr_draft = excluded.open_pr_draft, size_lines = excluded.size_lines
  WHERE targets.state = 'ready'
  RETURNING id`

export function putReady(db: Db, row: TargetCard & { account_id: number; evidence_measured_at: string }): number | undefined {
  const put = db.prepare(READY).get(row.account_id, row.repo, row.issue_no, row.named_merger, row.evidence_measured_at,
    row.evidence, row.issue_opened_at, row.issue_active_at, row.open_pr, row.open_pr_draft, row.size_lines) as { id: number } | undefined
  return put?.id
}

export function cardOf(db: Db, id: number): TargetCard {
  return db.prepare(`SELECT repo, issue_no, named_merger, issue_opened_at, issue_active_at, open_pr, open_pr_draft,
    size_lines, evidence FROM targets WHERE id = ?`).get(id) as TargetCard
}

export function readyRepo(db: Db, id: number): string | null {
  const t = db.prepare('SELECT repo, state FROM targets WHERE id = ?').get(id) as { repo: string; state: string } | undefined
  return t?.state === 'ready' ? t.repo : null
}

export function setTargetState(db: Db, id: number | null, state: Target['state']): void {
  db.prepare('UPDATE targets SET state = ? WHERE id = ?').run(state, id)
}

export function targetRef(db: Db, id: number | null): { repo: string; issue_no: number; part: string } | null {
  return (db.prepare('SELECT repo, issue_no, part FROM targets WHERE id = ?').get(id) ?? null) as { repo: string; issue_no: number; part: string } | null
}

export function planTarget(db: Db, plan: number): { origin: string | null; repo: string | null; issue_no: number | null } | undefined {
  return db.prepare(`SELECT p.origin, t.repo, t.issue_no FROM plans p LEFT JOIN targets t ON t.id = p.target_id
    WHERE p.id = ?`).get(plan) as { origin: string | null; repo: string | null; issue_no: number | null } | undefined
}
