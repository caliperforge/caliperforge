import { z } from 'zod'
import { gh, inline, WINDOW, type Read } from '../cli/gh.ts'
import { logins } from '../cli/measure.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { keep, newestMerged, type Thread } from './store.ts'

export const LIMIT = 1000

const Login = z.object({ login: z.string() })

const Said = z.object({ author: Login.nullable(), body: z.string() })

const Merged = z.array(z.object({
  number: z.int(),
  title: z.string(),
  mergedAt: z.string(),
  mergedBy: Login.nullable(),
  files: z.array(z.object({ path: z.string() })),
  closingIssuesReferences: z.array(z.object({ number: z.int() })),
  reviews: z.array(Said),
  comments: z.array(Said),
}))

const Mergers = z.array(z.object({ mergedBy: Login.nullable() }))

function twice<T>(f: () => T): T {
  for (let tried = 1; ; tried++) {
    try {
      return f()
    } catch (error) {
      if (tried === 2) throw error
    }
  }
}

export function harvest(db: Db, repo: string, since: string | null, read: Read = gh): number {
  const after = [newestMerged(db, repo), since].filter((d) => d !== null).sort().at(-1)
  const listed = Merged.parse(twice(() => read(['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', String(LIMIT),
    ...(after === undefined ? [] : ['--search', `merged:>${after}`]),
    '--json', 'number,title,mergedAt,mergedBy,files,closingIssuesReferences,reviews,comments'])))
  if (listed.length === LIMIT) throw new Error(`${repo} lists ${String(LIMIT)} merged PRs, the limit; the rest are unread`)
  if (listed.length === 0) return 0
  const mergers = logins(Mergers.parse(twice(() => read(['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', String(WINDOW),
    '--json', 'mergedBy']))).map((p) => p.mergedBy))
  const role = (who: string): string => (mergers.includes(who) ? 'maintainer' : 'contributor')
  let stored = 0
  for (const p of listed) {
    try {
      const lines = twice(() => inline(repo, p.number, read))
      if (lines.length >= WINDOW) throw new Error(`inline comments reach the cap of ${String(WINDOW)}; the rest are unread`)
      const said = (kind: string, rows: z.infer<typeof Said>[]): Thread[] => rows.filter((r) => r.body.trim() !== '')
        .map((r) => ({ kind, author: r.author?.login ?? '', role: role(r.author?.login ?? ''), text: r.body, path: null, line: null }))
      const threads = [...said('review', p.reviews), ...lines.map((c) => {
        const at = c.line ?? c.original_line
        return { kind: 'inline', author: c.user.login, role: role(c.user.login), text: c.body, path: at === null ? null : c.path, line: at }
      }), ...said('comment', p.comments)]
      if (lines.length < 3 && !threads.some((t) => t.kind === 'review' || t.role === 'maintainer')) continue
      keep(db, { repo, number: p.number, title: p.title, merged_at: p.mergedAt, merger: p.mergedBy?.login ?? null,
        files: p.files.map((f) => f.path), issues: p.closingIssuesReferences.map((i) => i.number) }, threads)
      stored++
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logged(db, { plan: null, kind: 'precedent_unread', actor: 'cf', outcome: 'refuse', message: `${repo}#${String(p.number)}: ${message}`,
        pointer: null, run: null })
    }
  }
  return stored
}
