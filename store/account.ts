import type { Db } from './index.ts'

export function ours(db: Db, repo: string): Record<'plans' | 'prs' | 'targets', unknown[]> {
  return {
    plans: db.prepare('SELECT p.* FROM plans p LEFT JOIN targets t ON t.id = p.target_id WHERE t.repo = ? OR p.origin GLOB ? ORDER BY p.id')
      .all(repo, `https://github.com/${repo}/issues/*`),
    prs: db.prepare('SELECT * FROM deliverables WHERE evidence GLOB ? ORDER BY id').all(`https://github.com/${repo}/pull/*`),
    targets: db.prepare('SELECT * FROM targets WHERE repo = ? ORDER BY id').all(repo),
  }
}

export function targeted(db: Db, repo: string, issue: number): boolean {
  return db.prepare('SELECT 1 FROM targets WHERE repo = ? AND issue_no = ?').get(repo, issue) !== undefined
}
