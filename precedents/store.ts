import type { Db } from '../store/index.ts'

export const KINDS = ['review', 'inline', 'comment'] as const

export interface Source { repo: string; number: number; title: string; merged_at: string; merger: string | null; files: string[]; issues: number[] }

export interface Thread { kind: string; author: string; role: string; text: string; path: string | null; line: number | null }

export function keep(db: Db, source: Source, threads: Thread[]): void {
  const unknown = threads.find((t) => !(KINDS as readonly string[]).includes(t.kind))
  if (unknown !== undefined) throw new Error(`unknown thread kind ${unknown.kind}`)
  const { repo, number } = source
  db.transaction(() => {
    db.prepare('DELETE FROM precedent_threads WHERE repo = ? AND number = ?').run(repo, number)
    db.prepare(`INSERT OR REPLACE INTO precedent_sources (repo, number, title, merged_at, merger, files, issues)
      VALUES (@repo, @number, @title, @merged_at, @merger, @files, @issues)`)
      .run({ ...source, files: JSON.stringify(source.files), issues: JSON.stringify(source.issues) })
    const insert = db.prepare(`INSERT INTO precedent_threads (repo, number, kind, author, role, text, path, line)
      VALUES (@repo, @number, @kind, @author, @role, @text, @path, @line)`)
    for (const thread of threads) insert.run({ ...thread, repo, number })
  })()
}

export function source(db: Db, repo: string, number: number): Source | undefined {
  const row = db.prepare('SELECT * FROM precedent_sources WHERE repo = ? AND number = ?')
    .get(repo, number) as (Omit<Source, 'files' | 'issues'> & { files: string; issues: string }) | undefined
  return row === undefined ? undefined : { ...row, files: JSON.parse(row.files) as string[], issues: JSON.parse(row.issues) as number[] }
}

export function threads(db: Db, repo: string, number: number): Thread[] {
  return db.prepare('SELECT kind, author, role, text, path, line FROM precedent_threads WHERE repo = ? AND number = ? ORDER BY id')
    .all(repo, number) as Thread[]
}

export function newestMerged(db: Db, repo: string): string | null {
  return db.prepare('SELECT max(merged_at) FROM precedent_sources WHERE repo = ?').pluck().get(repo) as string | null
}
