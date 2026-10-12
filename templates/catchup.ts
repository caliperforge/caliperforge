import { z } from 'zod'
import type { Outcome } from '../sequencer/kind.ts'
import { noted, proofed } from '../store/desk.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import { Fence, HEAD, noting, Stored } from './fence.ts'

/** A catchup plan's posts sit this far above its plan id on the desk, one band of 1_000_000 per post. */
const CATCHUP = 3_000_000

const Dated = Stored.extend({ from: Fence.shape.from.unwrap(), to: Fence.shape.to.unwrap(), post: z.string() }).array()

export function caught(db: Db, plan: PlanRow, text: string): Outcome {
  const got = Dated.safeParse(JSON.parse(text))
  const posts = (got.data ?? []).map(({ post, ...p }) => {
    const [, title = '', body = ''] = HEAD.exec(post) ?? []
    return { ...p, title: title.trim(), body: body.trim() }
  })
  if (!got.success || posts.some((p) => p.title === '' || p.body === '')) {
    return { outcome: 'refuse', spans: ['posts.json'], note: 'posts.json holds a post with no from/to, no # title line or no body' }
  }
  const today = new Date().toISOString().slice(0, 10)
  // Guatemala keeps UTC-6 all year (no DST), so 12:00 UTC is 06:00 there.
  const start = Date.parse(`${plan.queued_at.slice(0, 10)}T12:00:00Z`)
  const added = db.transaction(() => posts.filter(({ title, body, dek, sources, checks, from, to, learnings = '' }, i) => {
    const release = new Date(start + (i + 1) * 86_400_000).toISOString().replace('T', ' ').slice(0, 19)
    if (!proofed(db, { id: CATCHUP + i * 1_000_000 + plan.id, kind: 'catchup', dest: 'site', title, dek, body, sources: JSON.stringify(sources),
      checks: JSON.stringify(checks), work_date: `${from}–${to}`, written_date: today, release })) return false
    noted(db, from, noting(learnings), sources.map((s) => s.ref))
    return true
  }).length)()
  return { outcome: 'pass', spans: [], note: `${String(added)} catchup post(s) in proof` }
}
