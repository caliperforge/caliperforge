import type { Db } from '../store/index.ts'
import { partOf } from '../store/parts.ts'
import { builderRan, originIssue, planById, type PlanRow } from '../store/plans.ts'
import { homeOf } from './home.ts'
import { WIRE, type Wire } from './push.ts'
import { comments } from './split.ts'
import { maybe, put } from './workspace.ts'

/** A part filed before splits carried its parent's comments gets them before its brief, unless a builder has run on it. */
export function refilled(db: Db, root: string, plan: PlanRow, wire: Wire = WIRE): void {
  const row = partOf(db, plan.id)
  const ask = maybe(root, plan.id, 'ask.md')
  if (row === undefined || builderRan(db, plan.id) || ask === null || ask.includes('## Parent comments')) return
  const parent = planById(db, row.parent)
  const issue = originIssue(parent)
  if (issue === null) return
  const said = comments(wire.thread?.(homeOf(parent), issue) ?? [], `#${String(issue)}`)
  if (said !== '') put(root, plan.id, 'ask.md', `${ask.trimEnd()}\n\n${said}\n`)
}
