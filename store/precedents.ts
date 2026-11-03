import type { Listed, Opening } from '../precedents/openings.ts'
import type { Precedent, Source, Thread } from '../precedents/store.ts'
import type { Db } from './index.ts'

const KINDS = ['review', 'inline', 'comment'] as const

export function keep(db: Db, source: Source, threads: Thread[]): void {
  const unknown = threads.find((t) => !(KINDS as readonly string[]).includes(t.kind))
  if (unknown !== undefined) throw new Error(`unknown thread kind ${unknown.kind}`)
  const { repo, number } = source
  db.transaction(() => {
    db.prepare('DELETE FROM precedent_threads WHERE repo = ? AND number = ?').run(repo, number)
    db.prepare(`INSERT OR REPLACE INTO precedent_sources (repo, number, title, merged_at, merger, files, issues)
      VALUES (@repo, @number, @title, @merged_at, @merger, @files, @issues)`)
      .run({ ...source, files: JSON.stringify(source.files), issues: JSON.stringify(source.issues) })
    const insert = db.prepare(`INSERT INTO precedent_threads (repo, number, kind, author, role, text, path, line, url)
      VALUES (@repo, @number, @kind, @author, @role, @text, @path, @line, @url)`)
    for (const thread of threads) insert.run({ ...thread, repo, number })
  })()
}

export function source(db: Db, repo: string, number: number): Source | undefined {
  const row = db.prepare('SELECT * FROM precedent_sources WHERE repo = ? AND number = ?')
    .get(repo, number) as (Omit<Source, 'files' | 'issues'> & { files: string; issues: string }) | undefined
  return row === undefined ? undefined : { ...row, files: JSON.parse(row.files) as string[], issues: JSON.parse(row.issues) as number[] }
}

export function threads(db: Db, repo: string, number: number): Thread[] {
  return db.prepare('SELECT kind, author, role, text, path, line, url FROM precedent_threads WHERE repo = ? AND number = ? ORDER BY id')
    .all(repo, number) as Thread[]
}

export function newestMerged(db: Db, repo: string): string | null {
  return db.prepare('SELECT max(merged_at) FROM precedent_sources WHERE repo = ?').pluck().get(repo) as string | null
}

export function undistilled(db: Db, repo: string): Source | undefined {
  const number = db.prepare(`SELECT s.number FROM precedent_sources s
    WHERE s.repo = ? AND s.merged_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM precedent_distilled d WHERE d.repo = s.repo AND d.number = s.number)
    ORDER BY s.merged_at, s.number LIMIT 1`).pluck().get(repo) as number | undefined
  return number === undefined ? undefined : source(db, repo, number)
}

export function distilled(db: Db, pr: Source, rows: Precedent[], tokens: number): void {
  const { repo, number, merged_at } = pr
  db.transaction(() => {
    db.prepare('DELETE FROM precedents WHERE repo = ? AND number = ?').run(repo, number)
    const insert = db.prepare(`INSERT INTO precedents (repo, number, merged_at, area, decision, why, said_by, role, source)
      VALUES (@repo, @number, @merged_at, @area, @decision, @why, @said_by, @role, @source)`)
    for (const row of rows) insert.run({ ...row, repo, number, merged_at })
    db.prepare('INSERT OR REPLACE INTO precedent_distilled (repo, number, tokens) VALUES (?, ?, ?)').run(repo, number, tokens)
  })()
}

export function precedents(db: Db, repo: string): Precedent[] {
  return db.prepare('SELECT area, decision, why, said_by, role, source FROM precedents WHERE repo = ? ORDER BY id').all(repo) as Precedent[]
}

export function filed(db: Db, repo: string): (Precedent & { merged_at: string; files: string[] })[] {
  const rows = db.prepare(`SELECT p.area, p.decision, p.why, p.said_by, p.role, p.source, p.merged_at, s.files FROM precedents p
    JOIN precedent_sources s ON s.repo = p.repo AND s.number = p.number WHERE p.repo = ? ORDER BY p.id`)
    .all(repo) as (Precedent & { merged_at: string; files: string })[]
  return rows.map((row) => ({ ...row, files: JSON.parse(row.files) as string[] }))
}

export function opened(db: Db, pr: Source, rows: Opening[]): void {
  const { repo, merged_at } = pr
  db.transaction(() => {
    const insert = db.prepare(`INSERT INTO openings (repo, kind, area, quote, said_by, source, first_seen)
      VALUES (@repo, @kind, @area, @quote, @said_by, @source, @first_seen) ON CONFLICT (repo, kind, area, source) DO NOTHING`)
    for (const row of rows) insert.run({ ...row, repo, first_seen: merged_at })
    const had = db.prepare('SELECT kind, source FROM openings WHERE repo = ? AND area = ?')
    for (const row of rows.filter((r, i) => rows.findIndex((s) => s.area === r.area) === i)) {
      const on = had.all(repo, row.area) as { kind: string; source: string }[]
      const prs = new Set(on.filter((o) => o.kind !== 'repeated').flatMap((o) => /\/pull\/(\d+)/.exec(o.source)?.[1] ?? []))
      if (prs.size >= 3 && !on.some((o) => o.kind === 'repeated')) insert.run({ ...row, kind: 'repeated', repo, first_seen: merged_at })
    }
  })()
}

export function finished(db: Db, repo: string, pr: { merged_at: string; files: string[]; issues: number[]; text: string }): void {
  const rows = db.prepare(`SELECT id, area, quote, source FROM openings WHERE repo = ? AND status IN ('open', 'taken') AND first_seen < ?`)
    .all(repo, pr.merged_at) as { id: number; area: string; quote: string; source: string }[]
  const done = db.prepare(`UPDATE openings SET status = 'done' WHERE id = ?`)
  for (const row of rows) {
    const closes = [...row.quote.matchAll(/(?:#|\/issues\/)(\d+)/g)].some((m) => pr.issues.includes(Number(m[1])))
    if (closes || (pr.files.includes(row.area.replace(/:.*/, '')) && pr.text.includes(row.source))) done.run(row.id)
  }
}

export function vouched(db: Db, repo: string): Opening[] {
  return db.prepare(`SELECT kind, area, quote, said_by, source FROM openings
    WHERE repo = ? AND status = 'open' AND kind IN ('deferred', 'asked') ORDER BY first_seen DESC, id DESC`).all(repo) as Opening[]
}

export function openings(db: Db, repo: string | null): Listed[] {
  return db.prepare(`SELECT repo, kind, area, quote, said_by, source, first_seen FROM openings
    WHERE status = 'open' AND (? IS NULL OR repo = ?) ORDER BY first_seen DESC, id DESC`).all(repo, repo) as Listed[]
}
