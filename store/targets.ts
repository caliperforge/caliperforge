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
