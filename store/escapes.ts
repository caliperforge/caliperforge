import type { Db } from './index.ts'

export interface Escape { area: string; line: number; author: string; role: string; text: string; url: string }

export function keepEscapes(db: Db, repo: string, number: number, plan: number, rows: Escape[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM escapes WHERE repo = ? AND number = ?').run(repo, number)
    db.prepare('INSERT OR REPLACE INTO escape_counts (repo, number, plan, escapes) VALUES (?, ?, ?, ?)').run(repo, number, plan, rows.length)
    const insert = db.prepare(`INSERT INTO escapes (repo, number, area, line, author, role, text, url)
      VALUES (@repo, @number, @area, @line, @author, @role, @text, @url)`)
    for (const row of rows) insert.run({ ...row, repo, number })
  })()
}

export function escapeCounts(db: Db, repo: string): { number: number; plan: number; escapes: number }[] {
  return db.prepare('SELECT number, plan, escapes FROM escape_counts WHERE repo = ? ORDER BY number')
    .all(repo) as { number: number; plan: number; escapes: number }[]
}

export function escapesWeek(db: Db, now: Date): { repo: string; number: number; escapes: number }[] {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString()
  return db.prepare(`SELECT e.repo, e.number, e.escapes FROM escape_counts e JOIN records r ON r.repo = e.repo AND r.pr = e.number
    WHERE (r.state = 'OPEN' AND r.merged_at IS NULL) OR r.opened_at >= @since OR r.merged_at >= @since
    ORDER BY e.repo, e.number`).all({ since }) as { repo: string; number: number; escapes: number }[]
}

export function escapesOf(db: Db, repo: string, number: number): Escape[] {
  return db.prepare('SELECT area, line, author, role, text, url FROM escapes WHERE repo = ? AND number = ? ORDER BY id')
    .all(repo, number) as Escape[]
}
