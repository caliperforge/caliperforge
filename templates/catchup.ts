import { z } from 'zod'
import type { Outcome } from '../sequencer/kind.ts'
import { noted, proofed } from '../store/desk.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import { Fence, HEAD, noting, Stored } from './fence.ts'

/** A catchup plan's posts sit this far above its plan id on the desk, one band of 1_000_000 per post. */
const CATCHUP = 3_000_000

const Dated = Stored.extend({ date: Fence.shape.date.unwrap(), post: z.string() }).array()

export function caught(db: Db, plan: PlanRow, text: string): Outcome {
  const got = Dated.safeParse(JSON.parse(text))
  const posts = (got.data ?? []).map(({ post, ...p }) => {
    const [, title = '', body = ''] = HEAD.exec(post) ?? []
    return { ...p, title: title.trim(), body: body.trim() }
  })
  if (!got.success || posts.some((p) => p.title === '' || p.body === '')) {
    return { outcome: 'refuse', spans: ['posts.json'], note: 'posts.json holds a post with no date, no # title line or no body' }
  }
  const today = new Date().toISOString().slice(0, 10)
  const added = db.transaction(() => posts.filter(({ title, body, dek, sources, checks, date, learnings = '' }, i) => {
    if (!proofed(db, { id: CATCHUP + i * 1_000_000 + plan.id, kind: 'catchup', dest: 'site', title, dek, body, sources: JSON.stringify(sources),
      checks: JSON.stringify(checks), work_date: date, written_date: today })) return false
    noted(db, date, noting(learnings), sources.map((s) => s.ref))
    return true
  }).length)()
  return { outcome: 'pass', spans: [], note: `${String(added)} catchup post(s) in proof` }
}
