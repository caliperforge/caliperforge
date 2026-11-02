import type { Db } from '../store/index.ts'
import type { Source, Thread } from './store.ts'

export interface Opening { kind: 'deferred' | 'asked'; area: string; quote: string; said_by: string; source: string }

export type Listed = Opening & { repo: string; first_seen: string }

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
