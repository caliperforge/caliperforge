import { z } from 'zod'
import { type Item, log, proofed } from '../store/desk.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import type { Step } from '../templates/pr-path.ts'
import type { Outcome } from './kind.ts'
import { prose } from './prose.ts'
import { get, maybe, put } from './workspace.ts'

export const CLOSING = /(?:^|\n)---\n((?:\w+:.*\n)+)---\s*$/

const Items = z.object({
  headline: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  items: z.array(z.object({
    title: z.string().trim().min(1),
    what: z.string(),
    lesson: z.string(),
    fix: z.string(),
    status: z.enum(['fixed', 'open', 'ruled', 'noted']),
  })).min(3).max(5),
})

export function listed(root: string, plan: PlanRow, step: Step, text: string): Outcome {
  const fence = CLOSING.exec(text)
  const got = Items.safeParse(fence === null ? null : prose(fence[1] ?? '', ['headline', 'summary']))
  if (!got.success) return { outcome: 'refuse', spans: ['writer.fence'], note: `${step.runs} reply has no valid closing fence` }
  put(root, plan.id, 'items.json', JSON.stringify(got.data.items))
  put(root, plan.id, 'headline.json', JSON.stringify({ headline: got.data.headline, summary: got.data.summary }))
  return { outcome: 'pass', spans: [], note: `${step.runs}: items.json written` }
}

export function subject(root: string, plan: number): [string, string | null] {
  const name = ['items.json', 'posts.json'].find((n) => maybe(root, plan, n) !== null) ?? 'draft.md'
  return [name, maybe(root, plan, name)]
}

export function merged(db: Db, root: string, plan: PlanRow): Outcome {
  const items = maybe(root, plan.id, 'items.json')
  if (items === null) return { outcome: 'pass', spans: [], note: 'no draft' }
  const { day } = JSON.parse(get(root, plan.id, 'packet.json')) as { day: string }
  const { headline, summary } = JSON.parse(get(root, plan.id, 'headline.json')) as { headline: string; summary: string }
  const list = JSON.parse(items) as Item[]
  const body = list.map((i) => [`## ${i.title}`, i.what, i.lesson, i.fix].filter((p) => p !== '').join('\n\n')).join('\n\n')
  const added = db.transaction(() => {
    proofed(db, { id: plan.id, kind: 'daily', dest: 'site', title: headline, dek: summary, body, sources: '[]', checks: '[]',
      work_date: day, written_date: new Date().toISOString().slice(0, 10) })
    return log(db, day, list)
  })()
  return { outcome: 'pass', spans: [], note: `${String(added)} item(s) added to ${day}` }
}
