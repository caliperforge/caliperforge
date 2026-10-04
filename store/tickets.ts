import { z } from 'zod'
import type { Read } from '../cli/gh.ts'
import type { Db } from './index.ts'
import { LANE, LANES, laneOf, priorityOf } from './lanes.ts'

export const HISTORY = 5000

const PART = /^(\d+)[a-z]\b/

const AFTER = /^After: (#\d+(?:, #\d+)*)$/m

export const Listed = z.array(z.object({
  number: z.int(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  labels: z.array(z.object({ name: z.string() })),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  stateReason: z.string().nullable(),
}))

export type Listing = z.infer<typeof Listed>[number]

export const FIELDS = 'number,title,body,url,labels,createdAt,closedAt,stateReason'

export function partOf(title: string): number | null {
  const hit = PART.exec(title)?.[1]
  return hit === undefined ? null : Number(hit)
}

export function afterOf(body: string): number[] {
  const hit = AFTER.exec(body)?.[1]
  return hit === undefined ? [] : hit.split(', ').map((n) => Number(n.slice(1)))
}

/** Only a `whole` listing, one shorter than the list limit, drops the rows of issues missing from it. */
export function recordListing(db: Db, repo: string, listed: Listing[], whole: boolean): void {
  const put = db.prepare(`INSERT INTO tickets (repo, number, title, lane, priority, after, parent, opened_at, closed_at, kind,
    state_reason, diagnosis_wrong)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo, number) DO UPDATE SET title = excluded.title, lane = excluded.lane, priority = excluded.priority,
    after = excluded.after, parent = excluded.parent, opened_at = excluded.opened_at, closed_at = excluded.closed_at,
    kind = excluded.kind, state_reason = excluded.state_reason, diagnosis_wrong = excluded.diagnosis_wrong`)
  const drop = db.prepare('DELETE FROM tickets WHERE repo = ? AND number = ?')
  const kept: number[] = []
  for (const i of listed) {
    const lane = laneOf(i.labels)
    if (lane === null) {
      drop.run(repo, i.number)
      continue
    }
    const kind = i.labels.some((l) => l.name === 'fix') ? 'fix' : 'build'
    const wrong = i.labels.some((l) => l.name === 'diagnosis:wrong') ? 1 : 0
    const afters = afterOf(i.body)
    put.run(repo, i.number, i.title, lane, priority(i.labels), afters.length === 0 ? null : JSON.stringify(afters), partOf(i.title),
      i.createdAt, i.closedAt, kind,
      i.stateReason === '' ? null : i.stateReason, wrong)
    kept.push(i.number)
  }
  if (whole) {
    db.prepare('DELETE FROM tickets WHERE repo = ? AND closed_at IS NULL AND number NOT IN (SELECT value FROM json_each(?))')
      .run(repo, JSON.stringify(kept))
  }
}

export interface Ticket {
  repo: string; number: number; title: string; lane: string; priority: number | null; after: string | null
  parent: number | null; opened_at: string | null; closed_at: string | null; kind: 'fix' | 'build' | null
}

export function allTickets(db: Db): Ticket[] {
  return db.prepare('SELECT * FROM tickets ORDER BY repo, number').all() as Ticket[]
}

export function backfillTickets(db: Db, read: Read): number {
  const repos = [...new Set(LANES.map((l) => LANE[l].home))].map((repo) => {
    const list = (state: string): Listing[] => {
      const got = Listed.parse(read(['issue', 'list', '--repo', repo, '--state', state, '--limit', String(HISTORY), '--json', FIELDS]))
      if (got.length === HISTORY) throw new Error(`${repo} lists ${String(HISTORY)} ${state} issues, the limit; the history may be cut short`)
      return got
    }
    return { repo, listed: [...list('open'), ...list('closed')] }
  })
  for (const { repo, listed } of repos) recordListing(db, repo, listed, false)
  return repos.reduce((n, r) => n + r.listed.length, 0)
}

/** Two P labels make `add` refuse the issue; the ticket is still recorded, unpriced. */
function priority(labels: { name: string }[]): number | null {
  try {
    return priorityOf(labels)
  } catch {
    return null
  }
}
