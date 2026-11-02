import type { Opening } from '../precedents/openings.ts'
import type { Db } from './index.ts'

export function hashes(db: Db, repo: string): Record<string, string> {
  const rows = db.prepare('SELECT path, sha256 FROM parity_hashes WHERE repo = ?').all(repo) as { path: string; sha256: string }[]
  return Object.fromEntries(rows.map((r) => [r.path, r.sha256]))
}

export function drifted(db: Db, repo: string, at: string, rows: Opening[], sums: Record<string, string>): void {
  db.transaction(() => {
    const upsert = db.prepare(`INSERT INTO openings (repo, kind, area, quote, said_by, source, first_seen)
      VALUES (@repo, @kind, @area, @quote, @said_by, @source, @first_seen)
      ON CONFLICT (repo, kind, area, source) DO UPDATE SET quote = excluded.quote RETURNING id`)
    const seen = rows.map((row) => (upsert.get({ ...row, repo, first_seen: at }) as { id: number }).id)
    db.prepare(`UPDATE openings SET status = 'done' WHERE repo = ? AND kind = 'drift' AND status IN ('open', 'taken')
      AND id NOT IN (SELECT value FROM json_each(?))`).run(repo, JSON.stringify(seen))
    const keep = db.prepare(`INSERT INTO parity_hashes (repo, path, sha256) VALUES (?, ?, ?)
      ON CONFLICT (repo, path) DO UPDATE SET sha256 = excluded.sha256`)
    for (const [path, sha256] of Object.entries(sums)) keep.run(repo, path, sha256)
  })()
}
