import type { Db } from './index.ts'

/** On github a pull request and an issue share one number space, so `targets.issue_no` holds the pull number. */
export function adoptTarget(db: Db, account: { id: number; measured_at: string }, repo: string, no: number, url: string): number {
  db.prepare(`INSERT INTO targets (account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence, ineligible_ruling_id)
    VALUES (?, ?, ?, '', 'queued', ?, ?, NULL)
    ON CONFLICT (repo, issue_no, part) DO UPDATE SET account_id = excluded.account_id, state = 'queued',
      evidence_measured_at = excluded.evidence_measured_at, evidence = excluded.evidence,
      ineligible_ruling_id = NULL`)
    .run(account.id, repo, no, account.measured_at.slice(0, 10), url)
  const row = db.prepare("SELECT id FROM targets WHERE repo = ? AND issue_no = ? AND part = ''").get(repo, no) as { id: number }
  return row.id
}

export function heldPlan(db: Db, target: number): number | null {
  const row = db.prepare('SELECT id FROM plans WHERE target_id = ? ORDER BY id LIMIT 1').get(target) as { id: number } | undefined
  return row?.id ?? null
}

export function adoptedPlan(db: Db, pipe: number, target: number, step: number, priority: number): number {
  return Number(db.prepare(`INSERT INTO plans (pipe_id, target_id, template, state, queued_at, step, retries, priority)
    VALUES (?, ?, 'pr_path', 'done', ?, ?, 0, ?)`)
    .run(pipe, target, new Date().toISOString(), step, priority).lastInsertRowid)
}
