import { z } from 'zod'
import { type Item, log } from '../store/desk.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import type { Step } from '../templates/pr-path.ts'
import type { Outcome } from './kind.ts'
import { prose } from './prose.ts'
import { get, maybe, put } from './workspace.ts'

export const CLOSING = /(?:^|\n)---\n((?:\w+:.*\n)+)---\s*$/

const Items = z.object({
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
  const got = Items.safeParse(fence === null ? null : prose(fence[1] ?? '', []))
  if (!got.success) return { outcome: 'refuse', spans: ['writer.fence'], note: `${step.runs} reply has no valid closing fence` }
  put(root, plan.id, 'items.json', JSON.stringify(got.data.items))
  return { outcome: 'pass', spans: [], note: `${step.runs}: items.json written` }
}

export function subject(root: string, plan: number): [string, string | null] {
  const items = maybe(root, plan, 'items.json')
  return items === null ? ['draft.md', maybe(root, plan, 'draft.md')] : ['items.json', items]
}

export function merged(db: Db, root: string, plan: PlanRow): Outcome {
  const items = maybe(root, plan.id, 'items.json')
  if (items === null) return { outcome: 'pass', spans: [], note: 'no draft' }
  const { day } = JSON.parse(get(root, plan.id, 'packet.json')) as { day: string }
  return { outcome: 'pass', spans: [], note: `${String(log(db, day, JSON.parse(items) as Item[]))} item(s) added to ${day}` }
}
