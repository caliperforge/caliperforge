import { z } from 'zod'
import { laneOf, priorityOf } from '../cli/plan.ts'
import type { Db } from './index.ts'

const PART = /^(\d+)[a-z]\b/

const AFTER = /^After: #(\d+)$/m

export const Listed = z.array(z.object({
  number: z.int(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  labels: z.array(z.object({ name: z.string() })),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
}))

export type Listing = z.infer<typeof Listed>[number]

export const FIELDS = 'number,title,body,url,labels,createdAt,closedAt'

export function partOf(title: string): number | null {
  const hit = PART.exec(title)?.[1]
  return hit === undefined ? null : Number(hit)
}

export function afterOf(body: string): number | null {
  const hit = AFTER.exec(body)?.[1]
  return hit === undefined ? null : Number(hit)
}

/** Only a `whole` listing, one shorter than the list limit, drops the rows of issues missing from it. */
export function recordListing(db: Db, repo: string, listed: Listing[], whole: boolean): void {
  const put = db.prepare(`INSERT INTO tickets (repo, number, title, lane, priority, after, parent, opened_at, closed_at, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo, number) DO UPDATE SET title = excluded.title, lane = excluded.lane, priority = excluded.priority,
    after = excluded.after, parent = excluded.parent, opened_at = excluded.opened_at, closed_at = excluded.closed_at,
    kind = excluded.kind`)
  const drop = db.prepare('DELETE FROM tickets WHERE repo = ? AND number = ?')
  const kept: number[] = []
  for (const i of listed) {
    const lane = laneOf(i.labels)
    if (lane === null) {
      drop.run(repo, i.number)
      continue
    }
    const kind = i.labels.some((l) => l.name === 'fix') ? 'fix' : 'build'
    put.run(repo, i.number, i.title, lane, priority(i.labels), afterOf(i.body), partOf(i.title), i.createdAt, i.closedAt, kind)
    kept.push(i.number)
  }
  if (whole) {
    db.prepare('DELETE FROM tickets WHERE repo = ? AND closed_at IS NULL AND number NOT IN (SELECT value FROM json_each(?))')
      .run(repo, JSON.stringify(kept))
  }
}

/** Two P labels make `add` refuse the issue; the ticket is still recorded, unpriced. */
function priority(labels: { name: string }[]): number | null {
  try {
    return priorityOf(labels)
  } catch {
    return null
  }
}
