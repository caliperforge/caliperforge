import { laneOf, priorityOf } from '../cli/plan.ts'
import type { Db } from './index.ts'

const PART = /^(\d+)[a-z]\b/

const AFTER = /^After: #(\d+)$/m

export interface Listing { number: number; title: string; body: string; labels: { name: string }[] }

export function partOf(title: string): number | null {
  const hit = PART.exec(title)?.[1]
  return hit === undefined ? null : Number(hit)
}

/** Only a `whole` listing, one shorter than the list limit, drops the rows of issues missing from it. */
export function recordListing(db: Db, repo: string, listed: Listing[], whole: boolean): void {
  const put = db.prepare(`INSERT INTO tickets (repo, number, title, lane, priority, after, parent) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo, number) DO UPDATE SET title = excluded.title, lane = excluded.lane, priority = excluded.priority,
    after = excluded.after, parent = excluded.parent`)
  const drop = db.prepare('DELETE FROM tickets WHERE repo = ? AND number = ?')
  const kept: number[] = []
  for (const i of listed) {
    const lane = laneOf(i.labels)
    if (lane === null) {
      drop.run(repo, i.number)
      continue
    }
    const after = AFTER.exec(i.body)?.[1]
    put.run(repo, i.number, i.title, lane, priority(i.labels), after === undefined ? null : Number(after), partOf(i.title))
    kept.push(i.number)
  }
  if (whole) db.prepare('DELETE FROM tickets WHERE repo = ? AND number NOT IN (SELECT value FROM json_each(?))').run(repo, JSON.stringify(kept))
}

/** Two P labels make `add` refuse the issue; the ticket is still recorded, unpriced. */
function priority(labels: { name: string }[]): number | null {
  try {
    return priorityOf(labels)
  } catch {
    return null
  }
}
