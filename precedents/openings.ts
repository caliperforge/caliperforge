import type { Db } from '../store/index.ts'
import type { Source, Thread } from './store.ts'

export interface Opening { kind: 'deferred' | 'asked'; area: string; quote: string; said_by: string; source: string }

const OPENING = /^- opening: (?<kind>deferred|asked) \| area: (?<area>.+?) \| quote: (?<quote>.+?) \| said_by: (?<said_by>\S+) \| source: (?<source>\S+)$/

export function openingOf(line: string, said: Thread[]): Opening | null {
  const got = OPENING.exec(line)?.groups as Opening | undefined
  if (got === undefined || !said.some((t) => t.url === got.source && t.author === got.said_by && t.role === 'maintainer')) return null
  const { kind, area, quote, said_by, source } = got
  return { kind, area, quote, said_by, source }
}

export function opened(db: Db, pr: Source, rows: Opening[]): void {
  const { repo, merged_at } = pr
  db.transaction(() => {
    const insert = db.prepare(`INSERT INTO openings (repo, kind, area, quote, said_by, source, first_seen)
      VALUES (@repo, @kind, @area, @quote, @said_by, @source, @first_seen) ON CONFLICT (repo, kind, area, source) DO NOTHING`)
    for (const row of rows) insert.run({ ...row, repo, first_seen: merged_at })
  })()
}
