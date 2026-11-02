import type { Db } from './index.ts'

export interface Finding { finding: string; area: string; acted_on: 'fixed' | 'agreed' | 'ignored'; source: string }

export function flag(db: Db, repo: string, number: number, rows: Finding[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM precedent_findings WHERE repo = ? AND number = ?').run(repo, number)
    const insert = db.prepare(`INSERT INTO precedent_findings (repo, number, finding, area, acted_on, source)
      VALUES (@repo, @number, @finding, @area, @acted_on, @source)`)
    for (const row of rows) insert.run({ ...row, repo, number })
  })()
}

export function flagged(db: Db, repo: string): (Finding & { number: number })[] {
  return db.prepare('SELECT number, finding, area, acted_on, source FROM precedent_findings WHERE repo = ? ORDER BY id')
    .all(repo) as (Finding & { number: number })[]
}
